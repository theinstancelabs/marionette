"""python3 -m unittest discover consumers/ros2"""
import json
import unittest

from marionette_ros2_bridge import gateway_targets, gateway_url, hello
from marionette_topics import Topics, slug

ROSTER = {"type": "config", "phones": [{"id": "phone-1", "name": "Phone 1", "color": "#c98200", "connected": True}, {"id": "phone-2", "name": "Phone 2", "color": "#b04fc4", "connected": False}]}


def pose(phone: str, seq: int, heartbeat: bool = True, tracking: str = "normal") -> dict:
    return {"type": "pose", "phoneId": phone, "seq": seq, "heartbeat": heartbeat, "trackingState": tracking, "source": "arkit", "calibrationVersion": "guided-v2:1",
            "position": {"x": 0.1, "y": -0.02, "z": 0.3}, "rotation": {"x": 0, "y": 0, "z": 0, "w": 1}}


class TopicsTest(unittest.TestCase):
    def test_names_topics_after_the_roster_and_latches_it(self):
        topics = Topics()
        [roster] = topics.handle(ROSTER)
        self.assertEqual(roster.topic, "/marionette/phones")
        self.assertEqual([p["topic"] for p in roster.payload["phones"]], ["/marionette/phone_1", "/marionette/phone_2"])
        self.assertEqual([item.topic for item in topics.handle({**ROSTER, "phone": ROSTER["phones"][0]})], ["/marionette/phone_1/state"])
        self.assertEqual(topics.handle(ROSTER), [])
        self.assertEqual(slug("Left hand!"), "left_hand")
        self.assertEqual(slug("2"), "phone_2")

    def test_publishes_live_poses_per_phone_and_tracking_on_change(self):
        topics = Topics()
        topics.handle(ROSTER)
        first = topics.handle(pose("phone-1", 1))
        self.assertEqual([item.topic for item in first], ["/marionette/phone_1/tracking", "/marionette/phone_1/pose"])
        self.assertEqual([item.latched for item in first], [True, False])
        self.assertEqual(first[1].payload["frame_id"], "phone_1/operator")
        self.assertEqual(first[1].payload["position"], {"x": 0.1, "y": -0.02, "z": 0.3})
        self.assertEqual([item.topic for item in topics.handle(pose("phone-1", 2))], ["/marionette/phone_1/pose"])
        lost = topics.handle(pose("phone-1", 3, heartbeat=False, tracking="unavailable"))
        self.assertEqual([(item.topic, item.payload["state"]) for item in lost], [("/marionette/phone_1/tracking", "unavailable")])
        self.assertEqual(topics.handle(pose("phone-2", 1, tracking="limited"))[0].payload["state"], "limited")

    def test_forwards_every_button_event_with_its_phone(self):
        topics = Topics()
        topics.handle(ROSTER)
        press = topics.handle({"type": "input", "phoneId": "phone-2", "controlId": "estop", "action": "safety.estop", "value": True, "source": "phone", "receivedAt": 5, "sentAt": 4})
        repeat = topics.handle({"type": "input", "phoneId": "phone-1", "controlId": "deadman", "action": "teleop.deadman", "value": True, "renew": True, "source": "phone", "receivedAt": 6})
        dropped = topics.handle({"type": "input", "phoneId": "phone-1", "controlId": "deadman", "action": "teleop.deadman", "value": False, "source": "gateway", "reason": "renewals stopped", "receivedAt": 7})
        self.assertEqual(press[0].topic, "/marionette/phone_2/buttons")
        self.assertEqual(json.loads(press[0].json()), {"phone": "phone-2", "control": "estop", "action": "safety.estop", "value": True, "source": "phone", "received_at_ms": 5, "sent_at_ms": 4})
        self.assertTrue(repeat[0].payload["repeat"])
        self.assertEqual(dropped[0].payload["reason"], "renewals stopped")
        self.assertEqual(topics.handle({"type": "status", "message": "hi"}), [])

    def test_publishes_each_phone_state_so_a_late_consumer_knows_stop_is_on(self):
        topics = Topics()
        topics.handle(ROSTER)
        config = {"type": "config", "phone": ROSTER["phones"][0], "phones": ROSTER["phones"], "calibration": {"status": "captured", "epoch": 2, "reference": {"mode": "guided"}, "check": {"passed": True, "results": []}},
                  "controls": [{"id": "estop", "type": "toggle", "action": "safety.estop", "value": True}, {"id": "deadman", "type": "button", "action": "teleop.deadman", "hold": True, "held": True},
                               {"id": "calibration-start", "type": "button", "action": "calibration.start"}]}
        [state] = topics.handle(config)
        self.assertEqual((state.topic, state.latched), ("/marionette/phone_1/state", True))
        self.assertEqual(state.payload, {"phone": "phone-1", "name": "Phone 1", "connected": True, "calibration": {"status": "captured", "epoch": 2, "mode": "guided", "validated": True},
                                         "controls": [{"control": "estop", "action": "safety.estop", "value": True}, {"control": "deadman", "action": "teleop.deadman", "held": True}]})
        self.assertEqual(topics.handle(config), [])

    def test_says_when_the_gateway_is_lost_instead_of_leaving_holds_and_tracking_standing(self):
        topics = Topics()
        topics.handle(ROSTER)
        topics.handle({"type": "config", "phone": ROSTER["phones"][0], "phones": ROSTER["phones"], "calibration": {"status": "uncalibrated", "epoch": 0},
                       "controls": [{"id": "deadman", "type": "button", "action": "teleop.deadman", "hold": True, "held": True}]})
        topics.handle(pose("phone-1", 1))
        lost = topics.gateway_lost()
        self.assertEqual([(item.topic, item.payload.get("state", item.payload.get("value"))) for item in lost if not item.topic.endswith(("/state", "/phones"))],
                         [("/marionette/phone_1/tracking", "unavailable"), ("/marionette/phone_1/buttons", False)])
        state = next(item for item in lost if item.topic.endswith("/state")).payload
        self.assertEqual((state["connected"], state["controls"][0]["held"]), (False, False))
        self.assertEqual([p["connected"] for p in next(item for item in lost if item.topic == "/marionette/phones").payload["phones"]], [False, False])
        self.assertEqual(topics.gateway_lost(), [])
        # Back online: the gateway's roster and the next pose are published again.
        self.assertEqual([item.topic for item in topics.handle(ROSTER)], ["/marionette/phones"])
        self.assertEqual(topics.handle(pose("phone-1", 2))[0].payload["state"], "normal")

    def test_streams_dragged_values_and_ends_them_when_the_gateway_is_lost(self):
        topics = Topics()
        topics.handle(ROSTER)
        sample = topics.handle({"type": "input", "phoneId": "phone-1", "controlId": "drive", "action": "base.drive", "value": {"x": 0.5, "y": -0.2}, "live": True, "source": "phone", "receivedAt": 9})
        self.assertEqual((sample[0].topic, sample[0].payload["value"], sample[0].payload["live"]), ("/marionette/phone_1/buttons", {"x": 0.5, "y": -0.2}, True))
        final = topics.handle({"type": "input", "phoneId": "phone-1", "controlId": "drive", "action": "base.drive", "value": {"x": 0, "y": 0}, "source": "phone", "receivedAt": 10})
        self.assertNotIn("live", final[0].payload)
        config = {"type": "config", "phone": ROSTER["phones"][0], "phones": ROSTER["phones"], "calibration": {"status": "uncalibrated", "epoch": 0},
                  "controls": [{"id": "drive", "type": "joystick", "action": "base.drive", "value": {"x": 0.5, "y": -0.2}, "live": True}, {"id": "speed-limit", "type": "slider", "action": "base.speedLimit", "value": 70, "live": True},
                               {"id": "estop", "type": "toggle", "action": "safety.estop", "value": False}]}
        [state] = topics.handle(config)
        self.assertEqual(state.payload["controls"], [{"control": "drive", "action": "base.drive", "value": {"x": 0.5, "y": -0.2}, "live": True}, {"control": "speed-limit", "action": "base.speedLimit", "value": 70, "live": True},
                                                     {"control": "estop", "action": "safety.estop", "value": False}])
        lost = topics.gateway_lost()
        ends = [item.payload for item in lost if item.topic.endswith("/buttons")]
        self.assertEqual([(end["control"], end["value"], end["source"]) for end in ends], [("drive", {"x": 0, "y": 0}, "bridge"), ("speed-limit", 70, "bridge")])
        after = next(item for item in lost if item.topic.endswith("/state")).payload["controls"]
        self.assertEqual(after[:2], [{"control": "drive", "action": "base.drive", "value": {"x": 0, "y": 0}, "live": False}, {"control": "speed-limit", "action": "base.speedLimit", "value": 70, "live": False}])

    def test_ignores_messages_that_are_not_objects(self):
        self.assertEqual(Topics().handle(["config"]), [])
        self.assertEqual(Topics().handle("pose"), [])

    def test_understands_gateway_addresses_like_the_app_and_viewer(self):
        self.assertEqual(gateway_url("10.1.10.120"), "ws://10.1.10.120:8787/ws")
        self.assertEqual(gateway_url("robot.local:9000"), "ws://robot.local:9000/ws")
        self.assertEqual(gateway_url("wss://robot.example"), "wss://robot.example:8787/ws")
        self.assertEqual(gateway_url("https://robot.example:443/"), "wss://robot.example:443/ws")
        self.assertEqual(gateway_url("http://10.0.0.5"), "ws://10.0.0.5:8787/ws")
        self.assertEqual(gateway_url("[::1]"), "ws://[::1]:8787/ws")
        with self.assertRaises(ValueError):
            gateway_url("not an address")

    def test_takes_a_pairing_code_or_the_gateways_pairing_link(self):
        self.assertEqual(gateway_targets("10.0.0.5", "k7q2-m9xd"), (["ws://10.0.0.5:8787/ws"], "K7Q2M9XD"))
        self.assertEqual(gateway_targets("localhost"), (["ws://localhost:8787/ws"], None))
        link = "marionette://pair?v=1&host=192.168.1.20,100.64.0.5&port=9000&code=K7Q2M9XD&id=gw-ab12&name=Lab%20robot"
        self.assertEqual(gateway_targets(link), (["ws://192.168.1.20:9000/ws", "ws://100.64.0.5:9000/ws"], "K7Q2M9XD"))
        self.assertEqual(gateway_targets(link, "abcd-efgh")[1], "ABCDEFGH")
        self.assertEqual(gateway_targets("marionette://pair?host=robot.local"), (["ws://robot.local:8787/ws"], None))
        for bad in ("marionette://pair?host=;rm", "marionette://pair?host=a&port=0"):
            with self.assertRaises(ValueError):
                gateway_targets(bad)
        self.assertEqual(hello("K7Q2M9XD"), {"type": "hello", "version": 1, "role": "console", "cameras": False, "token": "K7Q2M9XD"})
        self.assertNotIn("token", hello())


if __name__ == "__main__":
    unittest.main()
