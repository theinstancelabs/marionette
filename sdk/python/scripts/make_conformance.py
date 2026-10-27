#!/usr/bin/env python3
"""Writes the Python SDK's tracker conformance fixtures (``sdk/conformance/tracker/py-*.json``).

    sdk/python/.venv/bin/python sdk/python/scripts/make_conformance.py

The messages come from ``marionette.testing.msg``, so they are shaped exactly like the gateway's; every expectation is
written out by hand here (never taken from the tracker), so a fixture says what the rules require. Both SDKs run every
fixture in the folder.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from marionette.testing import msg

OUT = Path(__file__).resolve().parents[2] / "conformance" / "tracker"
GATEWAY = "marionette-py00001"
RESTARTED = "marionette-py00002"
T = 1_793_100_000_000.0  # a fixed wall clock (ms) for the stamps

CONTROLS = [
    msg.button("deadman", "teleop.deadman", label="Hold to move", hold=True),
    msg.button("turn-left", "base.turnLeft", label="Turn left", hold=True),
    msg.toggle("estop", "safety.estop", label="Stop"),
    msg.select("arm", "arm.select", "left", [("Left arm", "left"), ("Right arm", "right")], label="Arm"),
    msg.slider("scale", "teleop.translationScale", 1, 0.1, 4, 0.1, unit="×", label="Motion scale"),
    msg.joystick("drive", "base.drive", label="Drive"),
    msg.button("reset-left", "arm.resetLeft", label="Reset left arm"),
    msg.button("calibration-start", "calibration.start", label="Start calibration"),
]
REST = {"x": 0, "y": 0}


class Steps(list[dict[str, Any]]):
    def __init__(self) -> None:
        super().__init__()
        self.t = T

    def stamp(self) -> float:
        self.t += 7.5
        return self.t

    def message(self, message: dict[str, Any]) -> Steps:
        self.append({"message": message})
        return self

    def config(self, phones: list[Any], phone: Any = None, session: str = GATEWAY, **fields: Any) -> Steps:
        return self.message(msg.config(phones, phone, CONTROLS, session=session, server_name="Python fixtures", **fields))

    def input(self, phone: str, action: str, value: Any = None, **fields: Any) -> Steps:
        control = next((c["id"] for c in CONTROLS if c["action"] == action), action.rsplit(".", 1)[-1])
        stamp = self.stamp()
        extra = {"sent_at": stamp - 3, "latency_ms": 2.5} if fields.get("source", "phone") == "phone" else {}
        return self.message(msg.input(phone, action, value, control=control, session=f"iphone-{phone}", received_at=stamp, **{**extra, **fields}))

    def gateway_end(self, phone: str, action: str, value: Any, reason: str) -> Steps:
        control = next(c["id"] for c in CONTROLS if c["action"] == action)
        return self.message(msg.input(phone, action, value, control=control, source="gateway", reason=reason, session=f"iphone-{phone}", received_at=self.stamp()))

    def pose(self, phone: str, seq: int, **fields: Any) -> Steps:
        stamp = self.stamp()
        fields.setdefault("session", f"iphone-{phone}")
        return self.message(msg.pose(phone, (0.1, 0.0, 0.05), (0.0, 0.0, 0.2), seq=seq, monotonic=seq / 60, sent_at=stamp - 4, received_at=stamp, latency_ms=3.0, **fields))

    def advance(self, seconds: float) -> Steps:
        self.append({"advance": seconds})
        return self

    def expect(self, note: str, phones: dict[str, Any] | None = None, *, absent: list[str] | None = None, any_stop: bool | None = None) -> Steps:
        expect: dict[str, Any] = {}
        if phones is not None:
            expect["phones"] = phones
        if absent is not None:
            expect["absent"] = absent
        if any_stop is not None:
            expect["any_stop"] = any_stop
        self.append({"note": note, "expect": expect})
        return self


def hold(down: bool, presses: int) -> dict[str, Any]:
    return {"down": down, "presses": presses}


def drag(live: bool, dropped: bool, value: Any) -> dict[str, Any]:
    return {"live": live, "dropped": dropped, "value": value}


def fixtures() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}

    def add(name: str, title: str, description: str, steps: Steps, **options: Any) -> None:
        out[name] = {"name": title, "description": description, "options": {"mirror": "stop-only", "stop_action": "safety.estop", **options}, "steps": list(steps)}

    s = Steps().config(["phone-1"], "phone-1")
    s.expect("the layout gives every hold a record", {"phone-1": {"connected": True, "holds": {"teleop.deadman": hold(False, 0), "base.turnLeft": hold(False, 0)}}})
    s.input("phone-1", "teleop.deadman", True, renew=True)
    s.expect("a repeat before any press starts nothing", {"phone-1": {"holds": {"teleop.deadman": hold(False, 0)}}})
    s.input("phone-1", "teleop.deadman", True).advance(0.2).input("phone-1", "teleop.deadman", True, renew=True)
    s.input("phone-1", "teleop.deadman", True)
    s.expect("a press, its repeat and a second press while down count once", {"phone-1": {"holds": {"teleop.deadman": hold(True, 1)}, "presses": {"teleop.deadman": 1}}})
    s.advance(0.7).gateway_end("phone-1", "teleop.deadman", False, "renewals stopped")
    s.input("phone-1", "teleop.deadman", True, renew=True)
    s.expect("after the gateway let go, a late repeat doesn't press again", {"phone-1": {"holds": {"teleop.deadman": hold(False, 1)}}})
    s.config(["phone-1"], "phone-1", held=["teleop.deadman"])
    s.expect("the gateway's held:true never starts a hold", {"phone-1": {"holds": {"teleop.deadman": hold(False, 1)}}})
    s.input("phone-1", "teleop.deadman", True)
    s.config(["phone-1"], "phone-1")
    s.expect("the gateway's held:false ends one", {"phone-1": {"holds": {"teleop.deadman": hold(False, 2)}}})
    add("py-hold-repeat", "A repeat only extends a hold that is down (Python)", "Renewals extend a held button but never press it, before the first press or after the gateway (renewals stopped, or its config's held:false) let go.", s)

    s = Steps().config(["phone-1"], "phone-1")
    s.expect("plain buttons start at zero", {"phone-1": {"presses": {"arm.resetLeft": 0, "calibration.start": 0}}})
    s.input("phone-1", "arm.resetLeft").input("phone-1", "arm.resetLeft").input("phone-1", "arm.resetLeft", renew=True)
    s.input("phone-1", "base.turnLeft", True).input("phone-1", "base.turnLeft", False).input("phone-1", "base.turnLeft", True).input("phone-1", "base.turnLeft", True, renew=True)
    s.input("phone-1", "calibration.start")
    s.expect("each press edge counts once, repeats don't", {"phone-1": {"presses": {"arm.resetLeft": 2, "base.turnLeft": 2, "calibration.start": 1}, "holds": {"base.turnLeft": hold(True, 2)}}})
    add("py-press-edges", "Press edges for plain and hold buttons (Python)", "Plain buttons count every press that isn't a repeat; hold buttons count presses from up to down.", s)

    s = Steps().config(["phone-1"], "phone-1")
    s.input("phone-1", "base.drive", {"x": 0.5, "y": 0.25}, live=True).advance(0.05).input("phone-1", "base.drive", {"x": 0.5, "y": 0.25}, live=True, renew=True)
    s.expect("the stick is live where it is pushed", {"phone-1": {"drags": {"base.drive": drag(True, False, {"x": 0.5, "y": 0.25})}, "values": {"base.drive": {"x": 0.5, "y": 0.25}}}})
    s.advance(0.45).gateway_end("phone-1", "base.drive", REST, "samples stopped")
    s.input("phone-1", "base.drive", {"x": 0.9, "y": 0}, live=True).input("phone-1", "base.drive", {"x": 0.9, "y": 0}, live=True, renew=True)
    s.expect("ended by the gateway: at rest and dropped, though samples still arrive", {"phone-1": {"drags": {"base.drive": drag(False, True, REST)}, "values": {"base.drive": REST}}})
    s.config(["phone-1"], "phone-1")
    s.expect("a config doesn't lift the finger", {"phone-1": {"drags": {"base.drive": {"dropped": True, "live": False}}}})
    s.input("phone-1", "base.drive", REST)
    s.expect("the finger lifts", {"phone-1": {"drags": {"base.drive": drag(False, False, REST)}}})
    s.input("phone-1", "base.drive", {"x": -0.3, "y": 0.1}, live=True)
    s.expect("the next touch counts again", {"phone-1": {"drags": {"base.drive": drag(True, False, {"x": -0.3, "y": 0.1})}}})
    s.input("phone-1", "base.drive", REST)
    s.input("phone-1", "base.drive", {"x": 0.2, "y": 0}, live=True, renew=True)
    s.expect("a repeat never starts a drag", {"phone-1": {"drags": {"base.drive": drag(False, False, REST)}}})
    add("py-stick-dropped", "A stick the gateway ended stays dropped until let go (Python)", "When the drive stick's samples stop, the gateway ends the drag at rest; samples that still arrive are ignored until the finger lifts.", s)

    s = Steps().config(["phone-1"], "phone-1")
    s.input("phone-1", "teleop.translationScale", 1.5, live=True).input("phone-1", "teleop.translationScale", 2.2, live=True)
    s.expect("slider values come from the live inputs", {"phone-1": {"values": {"teleop.translationScale": 2.2}, "drags": {"teleop.translationScale": drag(True, False, 2.2)}}})
    s.config(["phone-1", "phone-2"], "phone-1", values={"teleop.translationScale": 2.2}, live=["teleop.translationScale"])
    s.input("phone-1", "teleop.translationScale", 2.5, live=True)
    s.expect("still following the samples after a mid-drag config", {"phone-1": {"values": {"teleop.translationScale": 2.5}}})
    s.advance(0.45).gateway_end("phone-1", "teleop.translationScale", 2.5, "samples stopped")
    s.input("phone-1", "teleop.translationScale", 3.5, live=True)
    s.expect("dropped, the slider keeps the value it had", {"phone-1": {"values": {"teleop.translationScale": 2.5}, "drags": {"teleop.translationScale": drag(False, True, 2.5)}}})
    s.input("phone-1", "teleop.translationScale", 3.0)
    s.expect("letting go sets the final value", {"phone-1": {"values": {"teleop.translationScale": 3.0}, "drags": {"teleop.translationScale": drag(False, False, 3.0)}}})
    s.input("phone-1", "teleop.translationScale", 9.0)
    s.expect("a value outside the slider is ignored", {"phone-1": {"values": {"teleop.translationScale": 3.0}}})
    add("py-slider-dropped", "Slider values from live inputs, kept when dropped (Python)", "A slider follows its live samples; the gateway ending the drag keeps its value until the finger lifts and sets the final one.", s)

    s = Steps().config(["phone-1", "phone-2"], "phone-1").config(["phone-1", "phone-2"], "phone-2")
    s.input("phone-2", "safety.estop", True)
    s.expect("Stop is on from the press itself, before any config", {"phone-2": {"stop": True, "values": {"safety.estop": True}}, "phone-1": {"stop": False}}, any_stop=True)
    s.config(["phone-1", "phone-2"], "phone-2", values={"safety.estop": True})
    s.input("phone-2", "safety.estop", False)
    s.expect("the phone turns it off", {"phone-2": {"stop": False}}, any_stop=False)
    add("py-stop-press", "Stop acts from the press (Python)", "A phone's Stop toggle counts from its input, without waiting for the config that follows.", s)

    s = Steps().config(["phone-1"], "phone-1")
    for action, value, live in (("teleop.deadman", True, False), ("base.drive", {"x": 1, "y": 0}, True), ("teleop.translationScale", 3.0, True), ("arm.resetLeft", None, False), ("arm.select", "right", False)):
        s.input("phone-1", action, value, live=live, source="mirror")
    s.expect("a mirror can't hold, drag, press or set", {"phone-1": {"holds": {"teleop.deadman": hold(False, 0)}, "drags": {"base.drive": drag(False, False, REST)}, "presses": {"arm.resetLeft": 0}, "values": {"arm.select": "left", "teleop.translationScale": 1}}}, any_stop=False)
    s.input("phone-1", "safety.estop", True, source="mirror")
    s.expect("but it can turn Stop on", {"phone-1": {"stop": True}}, any_stop=True)
    s.config(["phone-1"], "phone-1", values={"safety.estop": True})
    s.input("phone-1", "safety.estop", False, source="mirror")
    s.config(["phone-1"], "phone-1", values={"safety.estop": False})
    s.expect("not off: not by its press, nor by the config the gateway sends after it", {"phone-1": {"stop": True}}, any_stop=True)
    s.input("phone-1", "safety.estop", False)
    s.expect("the phone itself can", {"phone-1": {"stop": False}}, any_stop=False)
    add("py-mirror-stop-only", "A desktop mirror may only turn Stop on (Python)", "With the default stop-only policy a mirror's presses move nothing, and Stop comes off only from the phone.", s)

    s = Steps().config(["phone-1"], "phone-1")
    s.input("phone-1", "teleop.deadman", True, source="mirror").input("phone-1", "arm.select", "right", source="mirror")
    s.expect("allow: a mirror acts as the phone", {"phone-1": {"holds": {"teleop.deadman": hold(True, 1)}, "values": {"arm.select": "right"}}})
    s.input("phone-1", "safety.estop", True, source="mirror").input("phone-1", "safety.estop", False, source="mirror")
    s.config(["phone-1"], "phone-1", values={"safety.estop": False, "arm.select": "right"})
    s.expect("including Stop, both ways", {"phone-1": {"stop": False}}, any_stop=False)
    add("py-mirror-allow", "A mirror allowed to act as its phone (Python)", "With mirror: allow, a mirror's presses count like the phone's own.", s, mirror="allow")

    s = Steps().config(["phone-1"], "phone-1")
    s.input("phone-1", "safety.estop", True, source="mirror").input("phone-1", "teleop.deadman", True, source="mirror")
    s.expect("deny: nothing from a mirror", {"phone-1": {"stop": False, "holds": {"teleop.deadman": hold(False, 0)}}}, any_stop=False)
    add("py-mirror-deny", "A mirror denied (Python)", "With mirror: deny, a mirror's inputs change nothing.", s, mirror="deny")

    s = Steps().config(["phone-1", "phone-2"], "phone-1").config(["phone-1", "phone-2"], "phone-2")
    s.pose("phone-1", 1).input("phone-1", "teleop.deadman", True).input("phone-1", "base.drive", {"x": 0.4, "y": 0}, live=True).input("phone-2", "safety.estop", True)
    s.append({"lost": True})
    s.expect("a lost gateway: nobody is connected, holding or dragging; Stop stays", {
        "phone-1": {"connected": False, "pose": None, "holds": {"teleop.deadman": hold(False, 1)}, "drags": {"base.drive": drag(False, False, REST)}},
        "phone-2": {"connected": False, "stop": True}}, any_stop=True)
    s.config(["phone-1", "phone-2"], "phone-1").config(["phone-1", "phone-2"], "phone-2", values={"safety.estop": False})
    s.expect("back on the same gateway, the configs say how things are", {"phone-1": {"connected": True}, "phone-2": {"connected": True, "stop": False}}, any_stop=False)
    add("py-lost-gateway", "A lost gateway lets go of everything (Python)", "When the connection to the gateway drops, every phone is offline and lets go; Stop stays until the gateway says otherwise.", s)

    s = Steps().config(["phone-1", "phone-2"], "phone-1").config(["phone-1", "phone-2"], "phone-2")
    s.input("phone-1", "safety.estop", True).input("phone-2", "teleop.deadman", True)
    s.append({"lost": True})
    s.config(["phone-1"], "phone-1", session=RESTARTED)
    stale = f"phone-1@{GATEWAY}"
    s.expect("a restarted gateway: new ids, but the phone left with Stop on stays, offline", {
        stale: {"id": stale, "connected": False, "stop": True, "pose": None},
        "phone-1": {"connected": True, "stop": False}}, absent=["phone-2"], any_stop=True)
    s.input(stale, "safety.estop", False)
    s.expect("nothing can reach the kept phone", {stale: {"stop": True}}, any_stop=True)
    s.append({"lost": True})
    s.config(["phone-1"], "phone-1", session="marionette-py00003")
    s.expect("it survives another restart under the same name", {stale: {"stop": True}}, absent=[f"{stale}@{RESTARTED}"], any_stop=True)
    s.append({"clear_stale_stops": True})
    s.expect("until it is cleared", {"phone-1": {"connected": True}}, absent=[stale], any_stop=False)
    add("py-gateway-restart", "A Stop survives a gateway restart (Python)", "A new gateway session names phones afresh; a phone left with Stop on is kept as <id>@<old session> until clear_stale_stops().", s)

    s = Steps().config(["phone-1"], "phone-1")
    s.pose("phone-1", 1).input("phone-1", "teleop.deadman", True).input("phone-1", "base.drive", {"x": 0.7, "y": 0}, live=True)
    s.gateway_end("phone-1", "teleop.deadman", False, "phone disconnected").gateway_end("phone-1", "base.drive", REST, "phone disconnected")
    s.message(msg.pose("phone-1", session="iphone-phone-1", tracking="unavailable", heartbeat=False, calibration="arkit-gravity-v2-stale", received_at=s.stamp()))
    s.config([msg.phone_info("phone-1", connected=False)])
    s.expect("a disconnected phone holds and drags nothing, and has no pose", {"phone-1": {"connected": False, "pose": None, "holds": {"teleop.deadman": hold(False, 1)}, "drags": {"base.drive": drag(False, False, REST)}}})
    s.config(["phone-1"], "phone-1").input("phone-1", "base.drive", {"x": 0.2, "y": 0}, live=True)
    s.expect("back again, its first touch counts", {"phone-1": {"connected": True, "drags": {"base.drive": drag(True, False, {"x": 0.2, "y": 0})}}})
    add("py-phone-disconnect", "A phone that disconnects lets go (Python)", "The gateway ends the phone's holds and drags and lists it offline; it holds nothing, and its drags aren't left dropped for when it returns.", s)

    s = Steps().config(["phone-1", "phone-2"], "phone-1").config(["phone-1", "phone-2"], "phone-2")
    s.input("phone-2", "safety.estop", True)
    s.config(["phone-1"], "phone-1")
    s.expect("a phone gone from the roster with Stop on is kept for its Stop", {f"phone-2@{GATEWAY}": {"stop": True, "connected": False}}, absent=["phone-2"], any_stop=True)
    s.config(["phone-1", "phone-3"], "phone-1").config(["phone-1"], "phone-1")
    s.expect("one without Stop is just gone", {"phone-1": {"connected": True}}, absent=["phone-3"])
    s.message({"type": "config", "version": 1, "sessionId": GATEWAY, "phones": [{"id": 7}], "controls": CONTROLS})
    s.expect("a roster it can't read doesn't drop anyone", {"phone-1": {"connected": True}})
    add("py-roster-gone", "Phones gone from the roster (Python)", "An older app without a device id leaves the roster without a disconnect; it is dropped, unless its Stop was on.", s)

    s = Steps().config(["phone-1"], "phone-1", values={"safety.estop": True})
    s.expect("a tracker that starts late learns Stop from the config", {"phone-1": {"stop": True}}, any_stop=True)
    s.config([msg.phone_info("phone-1", connected=False)])
    s.append({"clear_stale_stops": True})
    s.config([msg.phone_info("phone-1", connected=False)], msg.phone_info("phone-1", connected=False), values={"safety.estop": True})
    s.expect("cleared while offline, and the republished offline config doesn't undo it", {"phone-1": {"stop": False, "connected": False}}, any_stop=False)
    s.config(["phone-1"], "phone-1", values={"safety.estop": True})
    s.expect("back online, its own Stop applies again", {"phone-1": {"stop": True}}, any_stop=True)
    add("py-clear-offline-stop", "Clearing an offline phone's Stop (Python)", "clear_stale_stops() also clears Stop on offline phones of this gateway, which can't clear it themselves, until they come back.", s)

    s = Steps().config(["phone-1"], "phone-1", calibration={"status": "capturing", "epoch": 1, "step": "forward"})
    s.expect("calibration status and epoch", {"phone-1": {"calibration": "capturing", "epoch": 1, "pose": None}})
    s.pose("phone-1", 1, calibration="arkit-gravity-v2", tracking="limited")
    s.expect("a pose", {"phone-1": {"pose": {"session": "iphone-phone-1", "tracking": "limited", "source": "arkit", "calibration": "arkit-gravity-v2"}}})
    s.config(["phone-1"], "phone-1", calibration={"status": "captured", "epoch": 2})
    s.pose("phone-1", 2, calibration="guided-v2:2")
    s.expect("calibrated", {"phone-1": {"calibration": "captured", "epoch": 2, "pose": {"calibration": "guided-v2:2", "tracking": "normal"}}})
    s.message(msg.pose("phone-1", session="iphone-phone-1", tracking="unavailable", heartbeat=False, calibration="guided-v2:2-stale", received_at=s.stamp()))
    s.expect("the gateway's watchdog pose (heartbeat false) clears it", {"phone-1": {"pose": None}})
    add("py-calibration-pose", "Calibration and poses (Python)", "Each phone's calibration status and epoch come from its config; poses carry session, tracking, source and calibration, and a heartbeat:false pose means none.", s)

    s = Steps().config(["phone-1"], "phone-1")
    s.input("phone-1", "teleop.deadman", True).pose("phone-1", 1)
    for bad in (
        "nope",
        None,
        [],
        {"type": "input", "phoneId": "phone-1"},
        {"type": "input", "phoneId": "phone-1", "action": "safety.estop", "value": True, "source": "printer"},
        {"type": "input", "phoneId": "phone-7", "action": "safety.estop", "value": True, "source": "phone"},
        {"type": "input", "phoneId": "phone-1", "action": "base.drive", "value": {"x": 1.5, "y": 0}, "live": True, "source": "phone"},
        {"type": "input", "phoneId": "phone-1", "action": "arm.select", "value": "middle", "source": "phone"},
        {"type": "input", "phoneId": "phone-1", "action": "safety.estop", "value": "on", "source": "phone"},
        {"type": "pose", "phoneId": "phone-1", "position": {"x": 0, "y": 0}, "rotation": {"x": 0, "y": 0, "z": 0, "w": 1}, "trackingState": "normal", "heartbeat": True},
        {"type": "pose", "phoneId": "phone-1", "sessionId": "x", "calibrationVersion": "v", "source": "arkit", "position": {"x": 0, "y": 0, "z": 0}, "rotation": {"x": 0, "y": 0, "z": 0, "w": 1}, "trackingState": "dancing", "heartbeat": True},
        {"type": "config", "phone": {"id": 42}},
        {"type": "robot_state", "robotId": "arm", "state": {"stop": True}},
    ):
        s.message(bad)  # type: ignore[arg-type]
    s.expect("unchanged by every malformed message", {"phone-1": {"connected": True, "stop": False, "holds": {"teleop.deadman": hold(True, 1)}, "values": {"arm.select": "left"}, "drags": {"base.drive": drag(False, False, REST)},
                                                     "pose": {"session": "iphone-phone-1", "tracking": "normal"}}}, absent=["phone-7"], any_stop=False)
    add("py-malformed", "Malformed messages are ignored (Python)", "Messages that aren't objects, miss fields, name unknown phones or carry values no control accepts change nothing.", s)

    custom = [*CONTROLS[:2], msg.toggle("halt", "robot.halt", label="Halt"), *CONTROLS[3:]]
    s = Steps()
    s.message(msg.config(["phone-1"], "phone-1", custom, session=GATEWAY))
    s.input("phone-1", "robot.halt", True).input("phone-1", "safety.estop", True)
    s.expect("Stop is whatever action the robot names", {"phone-1": {"stop": True, "values": {"robot.halt": True}}}, any_stop=True)
    s.input("phone-1", "robot.halt", False)
    s.expect("and only that one", {"phone-1": {"stop": False}}, any_stop=False)
    add("py-custom-stop", "A Stop with another action (Python)", "options.stop_action names the toggle that is Stop.", s, stop_action="robot.halt")
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("py-*.json"):
        old.unlink()
    for name, fixture in fixtures().items():
        (OUT / f"{name}.json").write_text(json.dumps(fixture, indent=1, ensure_ascii=False) + "\n")
    print(f"Wrote {len(fixtures())} fixtures to {OUT}")


if __name__ == "__main__":
    main()
