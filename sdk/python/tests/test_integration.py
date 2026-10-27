"""The SDK against the real bundled gateway: robots, screens, state, notices, pairing, clocks, phones."""

from __future__ import annotations

import json
import math
import threading
import time
from typing import Any

import numpy as np
import pytest
import websockets.sync.client

import marionette.client as client_module
from helpers import yaw
from marionette import GatewayClient, PhoneTracker, RobotLink
from marionette.frames import apply_phone_frame
from marionette.protocol import wall_ms
from marionette.teleop import exp_rotation, quaternion_to_matrix
from marionette.testing import Gateway, SimPhone, wait_until

SCREEN = """<!doctype html><html><head><title>Arm</title>
<script type="application/json" id="marionette-config">
{"controls": [
  {"id": "deadman", "type": "button", "label": "Hold to move", "action": "teleop.deadman", "hold": true},
  {"id": "estop", "type": "toggle", "label": "Stop", "action": "safety.estop", "value": false},
  {"id": "scale", "type": "slider", "label": "Scale", "action": "teleop.translationScale", "value": 1, "min": 0.1, "max": 4, "step": 0.1},
  {"id": "drive", "type": "joystick", "label": "Drive", "action": "base.drive", "value": {"x": 0, "y": 0}},
  {"id": "calibration-start", "type": "button", "label": "Calibrate", "action": "calibration.start"},
  {"id": "calibration", "type": "button", "label": "Capture", "action": "calibration.capture"},
  {"id": "capture-origin", "type": "button", "label": "Origin", "action": "calibration.captureOrigin"}
 ],
 "cameraStreams": [{"id": "front", "label": "Front", "url": "webrtc://arm/front", "status": "live"}]}
</script></head><body><main id="arm-screen">Arm</main></body></html>"""


def robot(gateway: Gateway, robot_id: str = "arm", **options: Any) -> RobotLink:
    link = RobotLink(gateway.url, robot_id, robot_id.title(), **options).start()
    assert link.wait_connected(5), link.error
    return link


def test_a_robot_screen_is_accepted_and_shown_and_a_broken_one_refused(gateway: Gateway) -> None:
    link = robot(gateway, screen=SCREEN, title="Arm screen")
    try:
        assert link.wait_screen(5) is True and link.screen_error is None
        with SimPhone(gateway) as phone:
            phone.wait_for(lambda p: p.html and "arm-screen" in p.html["html"], what="the robot's screen")
            assert phone.html["source"] == {"kind": "robot", "robotId": "arm"} and phone.html["title"] == "Arm screen"
            phone.wait_for(lambda p: p.config and len(p.config["controls"]) == 7, what="the screen's layout")
        link.set_screen(SCREEN.replace('"controls": [', '"controls": [,'))
        assert link.wait_screen(5) is False
        assert "Screen refused" in (link.screen_error or "") and "not valid JSON" in (link.screen_error or "")
        assert gateway.get("/api/html-config")["source"] == {"kind": "robot", "robotId": "arm"}  # the previous one stays
    finally:
        link.stop()


def test_a_screen_file_is_watched(gateway: Gateway, tmp_path: Any) -> None:
    screen = tmp_path / "screen.html"
    screen.write_text(SCREEN)
    link = robot(gateway, screen=screen, watch=True)
    try:
        assert link.wait_screen(5)
        time.sleep(0.05)
        screen.write_text(SCREEN.replace("arm-screen", "arm-screen-2"))
        wait_until(lambda: "arm-screen-2" in gateway.get("/api/html-config")["html"], 5, "the saved screen")
    finally:
        link.stop()


def test_robot_state_is_routed_retained_and_replayed(gateway: Gateway) -> None:
    link = robot(gateway, every=0.1)
    try:
        with SimPhone(gateway) as one, SimPhone(gateway) as two:
            link.state({"engaged": False, "streams": ["front"], "battery": None})
            link.state({"reason": "Calibrate first", "nested": {"a": [1, 2.5]}}, phone=one.phone_id)
            one.wait_for(lambda p: any(s.get("phoneId") for s in p.robot_states) and p.robot_states, what="both states")
            two.wait_for(lambda p: p.robot_states, what="the global state")
            assert all(s["robotId"] == "arm" and "receivedAt" in s and s["everyMs"] == 100 for s in one.robot_states)
            assert not any(s.get("phoneId") for s in two.robot_states)  # another phone's state never reaches it
            assert any(s.get("phoneId") == one.phone_id and s["state"]["nested"] == {"a": [1, 2.5]} for s in one.robot_states)
            # Re-sent unchanged every `every` seconds, and at once on change.
            count = len(two.robot_states)
            two.wait_for(lambda p: len(p.robot_states) >= count + 3, 2.0, "repeats")
            link.state({"engaged": True, "streams": ["front"], "battery": None})
            two.wait_for(lambda p: p.robot_states[-1]["state"]["engaged"] is True, 0.5, "the change")
            # A phone that connects later gets the retained global state right after its config.
            with SimPhone(gateway) as late:
                late.wait_for(lambda p: p.robot_states, 2.0, "the replay")
                assert late.robot_states[0]["state"]["engaged"] is True
    finally:
        link.stop()
    # The gateway keeps it after the robot goes.
    assert any(s["robotId"] == "arm" for s in gateway.state()["robotStates"])


def test_notices_are_never_coalesced(gateway: Gateway) -> None:
    link = robot(gateway)
    try:
        with SimPhone(gateway) as phone:
            for i in range(5):
                assert link.notice(f"Notice {i}", phone=phone.phone_id, n=i)
            link.notice("For everyone")
            phone.wait_for(lambda p: len([s for s in p.statuses if s.get("controlId") == "robot.notice"]) == 6, what="six notices")
            notices = [s for s in phone.statuses if s.get("controlId") == "robot.notice"]
            assert [s["message"] for s in notices] == [*(f"Notice {i}" for i in range(5)), "For everyone"]
            assert notices[2]["values"] == {"n": 2} and notices[0]["sessionId"] == "arm"
    finally:
        link.stop()
    assert not link.notice("Nobody hears this")  # dropped while disconnected


def test_a_duplicate_robot_id_is_refused_and_takes_over_once_the_first_goes(gateway: Gateway) -> None:
    first = robot(gateway, "twin")
    second = RobotLink(gateway.url, "twin", "Twin 2").start()
    try:
        wait_until(lambda: second.error and "Another robot with id 'twin'" in second.error, 5, "the 4409")
        assert not second.connected and second.client.close_code == 4409
        first.stop()
        assert second.wait_connected(10), second.error
        assert second.error is None
        roster = gateway.state()["robots"]
        assert [(r["id"], r["name"], r["connected"]) for r in roster] == [("twin", "Twin 2", True)]
    finally:
        first.stop()
        second.stop()


def test_pairing_codes_and_links() -> None:
    with Gateway(auth="strict", token="K7Q2M9XD") as gateway:
        refused = GatewayClient(gateway.url).start()
        try:
            wait_until(lambda: refused.error and "Pairing code missing or wrong" in refused.error, 5, "the 4401")
            assert not refused.connected and refused.close_code == 4401
        finally:
            refused.stop()
        with GatewayClient(gateway.url, token="k7q2-m9xd") as typed:
            assert typed.wait_connected(5), typed.error
        link = gateway.get("/api/pairing")["url"]
        assert link.startswith("marionette://pair?") and "code=K7Q2M9XD" in link
        with GatewayClient(link) as paired, SimPhone(link) as phone:
            assert paired.wait_connected(5), paired.error
            assert phone.phone_id == "phone-1"


def test_the_clock_offset_and_latency_stamps(gateway: Gateway) -> None:
    tracker = PhoneTracker()
    link = robot(gateway, tracker=tracker)
    try:
        wait_until(lambda: link.client.offset_ms is not None, 3, "a pong")
        # Same computer: the offset is near zero and the round trip short.
        assert abs(link.client.offset_ms) < 5 and 0 <= link.client.rtt_ms < 50  # type: ignore[arg-type,operator]
        # A phone whose clock is 5 s off still gets small latency stamps: the gateway measures its offset.
        with SimPhone(gateway, clock_skew_ms=5000) as phone:
            pose = wait_until(lambda: (p := tracker.get(phone.phone_id)) and p.pose and p.pose.latency_ms is not None and p.pose, 4, "a stamped pose")
            assert 0 <= pose.latency_ms < 50 and pose.hop_ms is not None and pose.delay_ms is not None and pose.delay_ms < 50
            assert pose.sent_at is not None and pose.received_at is not None
            assert 0 <= pose.age(time.monotonic()) < 0.1
            assert gateway.state()["phones"][0]["link"]["offsetKnown"] is True
    finally:
        link.stop()


def test_a_clock_step_on_the_robot_never_leaves_a_stale_offset(gateway: Gateway, monkeypatch: pytest.MonkeyPatch) -> None:
    shift = {"ms": 0.0}
    monkeypatch.setattr(client_module, "wall_ms", lambda: wall_ms() + shift["ms"])
    with GatewayClient(gateway.url, ping_every=0.2) as client:
        wait_until(lambda: len(client._samples) >= 5, 5, "five pongs")
        before = client.offset_ms
        assert before is not None and abs(before) < 5
        for step in (-2000.0, 3000.0):  # chrony steps the clock back, then someone sets it forward
            shift["ms"] += step
            seen: list[float | None] = []
            started = time.monotonic()
            while time.monotonic() - started < 1.0:
                seen.append(client.offset_ms)
                time.sleep(0.005)
            # From the moment the clock moves the offset is unknown, until it is measured again (well within a second).
            assert all(abs(offset - (before - shift["ms"])) < 5 for offset in seen if offset is not None), seen
            assert seen[-1] is not None and 0 <= client.rtt_ms < 50  # type: ignore[operator]


def test_simphone_poses_match_the_gateways_conversion_and_calibration(gateway: Gateway) -> None:
    tracker = PhoneTracker()
    with GatewayClient(gateway.url) as watcher:
        tracker.attach(watcher)
        assert watcher.wait_connected(5)
        with SimPhone(gateway, heading=30.0) as phone:
            turn = exp_rotation([0.1, -0.2, 0.3])
            start = np.array([0.05, -0.02, 0.1])
            phone.move_to(start, turn)
            time.sleep(0.1)
            published = tracker.get(phone.phone_id).pose  # type: ignore[union-attr]
            raw_position, raw_rotation = phone.arkit()
            position, rotation = apply_phone_frame(raw_position, raw_rotation)
            np.testing.assert_allclose(published.position, position, atol=1e-6)  # the protocol's conversion, ported
            np.testing.assert_allclose(published.rotation, rotation, atol=1e-6)
            # Uncalibrated, ARKit's world is turned 30° from the operator's.
            assert yaw(published.rotation @ turn.T) == pytest.approx(30.0, abs=1e-4)
            calibration = phone.calibrate()
            assert calibration["status"] == "captured" and calibration["reference"]["mode"] == "guided"
            here = np.array([0.08, 0.03, -0.02])
            phone.move_to(here, turn)
            wait_until(lambda: tracker.get(phone.phone_id).pose.calibration == f"guided-v2:{calibration['epoch']}", 2, "calibrated poses")  # type: ignore[union-attr]
            time.sleep(0.1)
            published = tracker.get(phone.phone_id).pose  # type: ignore[union-attr]
            # Calibrated: the operator's own frame, measured from where calibration started.
            np.testing.assert_allclose(published.position, here - start, atol=1e-6)
            np.testing.assert_allclose(published.rotation, turn, atol=1e-6)
            assert tracker.get(phone.phone_id).calibration == "captured"  # type: ignore[union-attr]


def test_reconnecting_in_the_same_session_keeps_calibration_and_a_new_one_clears_it(gateway: Gateway) -> None:
    with SimPhone(gateway) as phone:
        epoch = phone.quick_origin()["epoch"]
        first_id = phone.phone_id
        phone.reconnect(same_session=True)
        assert phone.phone_id == first_id
        assert phone.calibration["status"] == "captured" and phone.calibration["epoch"] == epoch
        phone.reconnect(same_session=False)
        phone.wait_for(lambda p: p.calibration["status"] == "uncalibrated", what="the cleared calibration")


def test_holds_drags_and_the_gateways_inferred_ends(gateway: Gateway) -> None:
    tracker = PhoneTracker()
    link = robot(gateway, screen=SCREEN, tracker=tracker)
    try:
        assert link.wait_screen(5)
        with SimPhone(gateway) as phone:
            phone.wait_for(lambda p: p.control("base.drive") is not None, what="the robot's layout")
            pid = phone.phone_id

            def me() -> Any:
                return tracker.get(pid)

            phone.press("teleop.deadman")
            wait_until(lambda: me().holding("teleop.deadman", time.monotonic(), 0.3), 2, "the hold")
            time.sleep(0.5)  # its repeats keep it live
            assert me().holding("teleop.deadman", time.monotonic(), 0.3) and me().presses("teleop.deadman") == 1
            with phone.renewals_paused():
                wait_until(lambda: not me().hold("teleop.deadman").down, 2, "the gateway's release")
            phone.release("teleop.deadman")
            phone.stick(0.5, 0.25)
            wait_until(lambda: me().stick("base.drive", time.monotonic()) == (0.5, 0.25), 2, "the stick")
            phone.pause_renewals()
            wait_until(lambda: me().drag("base.drive").dropped, 2, "the dropped drag")
            phone.resume_renewals()
            phone.stick(0.9, 0.0)  # still touching: ignored by the gateway and the tracker
            time.sleep(0.2)
            assert me().stick("base.drive", time.monotonic()) == (0.0, 0.0) and me().drag("base.drive").dropped
            assert phone.value("base.drive") == {"x": 0, "y": 0}
            phone.let_go("base.drive")
            phone.stick(0.3, 0.0)
            wait_until(lambda: me().stick("base.drive", time.monotonic()) == (0.3, 0.0), 2, "the next touch")
            phone.let_go()
            phone.drag("teleop.translationScale", [1.5, 2.0, 2.5])
            wait_until(lambda: me().value("teleop.translationScale") == 2.5 and not me().drag("teleop.translationScale").live, 2, "the slider")
            assert phone.value("teleop.translationScale") == 2.5
    finally:
        link.stop()


def test_a_gateway_restart_keeps_a_stop_until_cleared() -> None:
    with Gateway() as gateway:
        tracker = PhoneTracker()
        with GatewayClient(gateway.url) as watcher:
            tracker.attach(watcher)
            assert watcher.wait_connected(5)
            phone = SimPhone(gateway).connect()
            try:
                phone.set("safety.estop", True)
                wait_until(tracker.any_stop, 2, "Stop")
                old = gateway.session
                phone.disconnect()
                gateway.restart()
                assert gateway.session != old
                wait_until(lambda: watcher.connected and tracker.gateway != old, 10, "the new gateway")
                phone.reconnect()  # the same phone, a new gateway: Stop is off there
                wait_until(lambda: (p := tracker.get(phone.phone_id)) and p.connected, 5, "the phone back")
                assert tracker.any_stop() and f"phone-1@{old}" in tracker.snapshot()
                assert not tracker.get("phone-1").stop  # type: ignore[union-attr]
                assert tracker.clear_stale_stops() == [f"phone-1@{old}"] and not tracker.any_stop()
            finally:
                phone.close()


def test_send_is_safe_from_many_threads(gateway: Gateway) -> None:
    link = robot(gateway)
    try:
        with SimPhone(gateway) as phone:
            def burst(n: int) -> None:
                for i in range(25):
                    link.notice(f"{n}:{i}", phone=phone.phone_id)

            threads = [threading.Thread(target=burst, args=(n,)) for n in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            phone.wait_for(lambda p: len([s for s in p.statuses if s.get("controlId") == "robot.notice"]) == 100, what="every notice")
            got = [s["message"] for s in phone.statuses if s.get("controlId") == "robot.notice"]
            for n in range(4):
                assert [m for m in got if m.startswith(f"{n}:")] == [f"{n}:{i}" for i in range(25)]  # each thread's in order
    finally:
        link.stop()


def test_jpeg_frames_reach_a_console_that_asks(gateway: Gateway) -> None:
    link = robot(gateway, screen=SCREEN)
    frames: list[dict[str, Any]] = []
    try:
        assert link.wait_screen(5)
        with GatewayClient(gateway.url, cameras=True, on_message=lambda m: m.get("type") == "camera_frame" and m["cameraId"] == "front" and frames.append(m)) as viewer:
            assert viewer.wait_connected(5)
            for i in range(3):
                link.send_jpeg("front", b"\xff\xd8jpeg" + bytes([i]), captured_ms=1000.0 + i)
                time.sleep(0.05)
            wait_until(lambda: frames, 2, "a frame")
            assert frames[-1]["dataUrl"].startswith("data:image/jpeg;base64,") and frames[-1]["sessionId"] == "arm"
    finally:
        link.stop()
    assert not link.send_jpeg("front", b"x")


def test_quaternions_from_the_gateway_are_unit(gateway: Gateway) -> None:
    with GatewayClient(gateway.url) as watcher, SimPhone(gateway) as phone:
        poses: list[dict[str, Any]] = []
        watcher.on("message", lambda m: m.get("type") == "pose" and poses.append(m))
        phone.move_by((0.01, 0, 0), turn=(0, 0, math.pi / 3), seconds=0.1)
        wait_until(lambda: len(poses) > 5, 2, "poses")
        q = poses[-1]["rotation"]
        assert abs(np.linalg.norm([q["x"], q["y"], q["z"], q["w"]]) - 1) < 1e-9
        assert quaternion_to_matrix(q).shape == (3, 3)


MIRRORED = """<!doctype html><html><body>
<script type="application/json" id="marionette-config">
{"controls": [
  {"id": "estop", "type": "toggle", "label": "Stop", "action": "safety.estop", "value": false},
  {"id": "arm", "type": "select", "label": "Arm", "action": "arm.select", "value": "left", "options": [{"label": "L", "value": "left"}, {"label": "R", "value": "right"}]},
  {"id": "grip", "type": "slider", "label": "Grip", "action": "gripper.set", "value": 0, "min": 0, "max": 1, "step": 0.05},
  {"id": "drive", "type": "joystick", "label": "Drive", "action": "base.drive", "value": {"x": 0, "y": 0}},
  {"id": "deadman", "type": "button", "label": "Hold", "action": "teleop.deadman", "hold": true}
 ]}
</script></body></html>"""


def test_a_desk_mirror_moves_nothing_but_stop_unless_mirrors_may_act() -> None:
    """The gateway applies a desk mirror's changes and republishes the phone's config, and ends the mirror's drags when
    it goes quiet: under stop-only none of that reaches the phone's record (the review's two reproductions)."""
    with Gateway(html=MIRRORED) as gateway:
        trackers = {"stop-only": PhoneTracker(mirror="stop-only"), "allow": PhoneTracker(mirror="allow")}
        clients = [GatewayClient(gateway.url) for _ in trackers]
        for client, tracker in zip(clients, trackers.values(), strict=True):
            tracker.attach(client)
            client.start()
        seen: list[dict[str, Any]] = []
        clients[0].on("message", lambda m: m.get("type") in ("input", "config") and seen.append(m))
        try:
            with SimPhone(gateway) as phone:
                pid = phone.phone_id

                def guarded() -> Any:
                    return trackers["stop-only"].get(pid)

                def allowed() -> Any:
                    return trackers["allow"].get(pid)

                def act(mirror: Any, control: str, action: str, value: Any, live: bool = False) -> None:
                    message = {"type": "action", "version": 1, "sessionId": "desk", "controlId": control, "action": action, "value": value, "sentAt": time.time() * 1000}
                    mirror.send(json.dumps({**message, "live": True} if live else message))

                wait_until(lambda: guarded() and allowed() and guarded().value("arm.select") == allowed().value("arm.select") == "left", 5, "the phone")
                with websockets.sync.client.connect(gateway.url, max_queue=None) as mirror:
                    mirror.send(json.dumps({"type": "hello", "version": 1, "role": "console", "follow": pid}))
                    while json.loads(mirror.recv(5)).get("type") != "config":
                        pass
                    act(mirror, "arm", "arm.select", "right")
                    act(mirror, "grip", "gripper.set", 0.5, live=True)
                    act(mirror, "grip", "gripper.set", 1.0)  # let go
                    act(mirror, "drive", "base.drive", {"x": 0.5, "y": 0}, live=True)
                    act(mirror, "grip", "gripper.set", 0.9, live=True)  # and the desk goes quiet: the gateway ends both drags
                    ended = lambda: {m["action"] for m in seen if m["type"] == "input" and m.get("source") == "gateway"}  # noqa: E731
                    wait_until(lambda: ended() >= {"gripper.set", "base.drive"}, 3, "the gateway's ends")
                    wait_until(lambda: allowed().value("arm.select") == "right" and allowed().value("gripper.set") == 0.9, 2, "the mirror's changes, allowed")
                    # The gateway republished the mirror's changes in the phone's config...
                    mine = [m for m in seen if m["type"] == "config" and m.get("phone", {}).get("id") == pid]
                    assert any(c["action"] == "arm.select" and c.get("value") == "right" for m in mine for c in m["controls"])
                    assert any(c["action"] == "gripper.set" and c.get("value") == 0.9 for m in mine for c in m["controls"])
                    # ...and none of it counts under stop-only.
                    record = guarded()
                    assert record.value("arm.select") == "left" and record.value("gripper.set") == 0 and record.stick("base.drive") == (0.0, 0.0)
                    grip = record.drag("gripper.set")
                    assert (grip.value, grip.live, grip.dropped, grip.updates) == (0, False, False, 0)
                    assert allowed().drag("gripper.set").updates == 4  # two samples, the let-go and the gateway's end
                    # The phone's own changes count, and a mirror's Stop on does too.
                    phone.set("arm.select", "right")
                    wait_until(lambda: guarded().value("arm.select") == "right", 2, "the phone's own change")
                    act(mirror, "estop", "safety.estop", True)
                    wait_until(trackers["stop-only"].any_stop, 2, "the mirror's Stop")
        finally:
            for client in clients:
                client.stop()
