"""Turns Marionette gateway messages into ROS 2 topic payloads.

Plain Python with no ROS imports, so it can be tested anywhere. The bridge
(`marionette_ros2_bridge.py`) publishes what `Topics.handle` returns.

Per phone (named from the gateway roster, so "Phone 1" becomes `phone_1`):
  /marionette/<phone>/pose      geometry_msgs/PoseStamped, frame "<phone>/operator"
                                (REP-103: +X forward, +Y left, +Z up, metres), only
                                while the phone's stream is live
  /marionette/<phone>/buttons   std_msgs/String, one JSON object per button event,
                                exactly as the gateway relayed it (repeats included)
  /marionette/<phone>/tracking  std_msgs/String (latched), the ARKit tracking state on
                                change ("normal", "limited", ..., "unavailable" when the
                                stream stops or the bridge loses the gateway)
  /marionette/<phone>/state     std_msgs/String (latched), the phone's current control
                                values, which hold buttons it holds, and its calibration,
                                on change; this is how a consumer that starts late learns
                                that Stop is already on
and /marionette/phones          std_msgs/String (latched), the roster as JSON.

When the bridge loses the gateway it says so instead of leaving the last values
standing: tracking goes "unavailable", every phone is marked disconnected, and each
hold the gateway had reported gets a release on `buttons` with `"source": "bridge"`.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

GATEWAY_LOST = "gateway connection lost"


def slug(name: str) -> str:
    """A ROS-safe topic segment: "Phone 1" -> "phone_1"."""
    text = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return text if text and not text[0].isdigit() else f"phone_{text}"


@dataclass
class Publish:
    topic: str
    kind: str  # "pose" (PoseStamped) or "string" (std_msgs/String)
    payload: dict[str, Any]
    latched: bool = False  # transient-local, so a late subscriber gets the last one

    def json(self) -> str:
        return json.dumps(self.payload, separators=(",", ":"))


@dataclass
class Topics:
    prefix: str = "/marionette"
    names: dict[str, str] = field(default_factory=dict)
    tracking: dict[str, str] = field(default_factory=dict)
    states: dict[str, dict[str, Any]] = field(default_factory=dict)
    roster: dict[str, Any] = field(default_factory=dict)

    def phone_topic(self, phone_id: str, leaf: str) -> str:
        return f"{self.prefix}/{self.names.get(phone_id, slug(phone_id))}/{leaf}"

    def handle(self, message: Any) -> list[Publish]:
        if not isinstance(message, dict):
            return []
        kind = message.get("type")
        if kind == "config":
            return self._config(message)
        if kind == "pose" and isinstance(message.get("phoneId"), str):
            return self._pose(message)
        if kind == "input" and isinstance(message.get("phoneId"), str):
            return [self._button(message)]
        return []

    def gateway_lost(self) -> list[Publish]:
        """What to publish when the gateway connection drops, so nothing reads as live."""
        out: list[Publish] = []
        for phone, state in list(self.tracking.items()):
            if state != "unavailable":
                self.tracking[phone] = "unavailable"
                out.append(Publish(self.phone_topic(phone, "tracking"), "string", {"phone": phone, "state": "unavailable", "source": None, "reason": GATEWAY_LOST}, True))
        for phone, state in list(self.states.items()):
            for control in state["controls"]:
                if control.get("held"):
                    out.append(Publish(self.phone_topic(phone, "buttons"), "string", {"phone": phone, "control": control["control"], "action": control["action"], "value": False, "source": "bridge", "reason": GATEWAY_LOST}))
            lost = {**state, "connected": False, "reason": GATEWAY_LOST, "controls": [{**control, "held": False} if "held" in control else control for control in state["controls"]]}
            if lost != state:
                self.states[phone] = lost
                out.append(Publish(self.phone_topic(phone, "state"), "string", lost, True))
        if self.roster and any(phone["connected"] for phone in self.roster["phones"]):
            self.roster = {**self.roster, "phones": [{**phone, "connected": False} for phone in self.roster["phones"]]}
            out.append(Publish(f"{self.prefix}/phones", "string", self.roster, True))
        return out

    def _config(self, message: dict[str, Any]) -> list[Publish]:
        roster = [phone for phone in message.get("phones", []) if isinstance(phone, dict) and isinstance(phone.get("id"), str)]
        for phone in roster:
            self.names[phone["id"]] = slug(str(phone.get("name", phone["id"])))
        phone = message.get("phone")
        if isinstance(phone, dict) and isinstance(phone.get("id"), str):
            return self._state(message, phone)
        payload = {"phones": [
            {"id": phone["id"], "name": phone.get("name"), "topic": f"{self.prefix}/{self.names[phone['id']]}", "color": phone.get("color"), "connected": bool(phone.get("connected"))}
            for phone in roster]}
        # The gateway repeats the roster with other changes; publish it only when it differs.
        if payload == self.roster:
            return []
        self.roster = payload
        return [Publish(f"{self.prefix}/phones", "string", payload, True)]

    def _state(self, message: dict[str, Any], phone: dict[str, Any]) -> list[Publish]:
        phone_id = phone["id"]
        controls = []
        for control in message.get("controls", []):
            if not isinstance(control, dict) or not isinstance(control.get("id"), str):
                continue
            if "value" in control:
                controls.append({"control": control["id"], "action": control.get("action"), "value": control["value"]})
            elif control.get("hold"):
                controls.append({"control": control["id"], "action": control.get("action"), "held": bool(control.get("held"))})
        calibration = message.get("calibration") if isinstance(message.get("calibration"), dict) else {}
        reference = calibration.get("reference") if isinstance(calibration.get("reference"), dict) else {}
        check = calibration.get("check") if isinstance(calibration.get("check"), dict) else {}
        state = {"phone": phone_id, "name": phone.get("name"), "connected": bool(phone.get("connected")), "controls": controls,
                 # `epoch` changes whenever the phone's frame does: re-anchor then. `mode` is the frame in use (none, quick or guided).
                 "calibration": {"status": calibration.get("status"), "epoch": calibration.get("epoch"), "mode": reference.get("mode"), "validated": check.get("passed")}}
        if self.states.get(phone_id) == state:
            return []
        self.states[phone_id] = state
        return [Publish(self.phone_topic(phone_id, "state"), "string", state, True)]

    def _pose(self, message: dict[str, Any]) -> list[Publish]:
        phone = message["phoneId"]
        out: list[Publish] = []
        state = "unavailable" if not message.get("heartbeat") else str(message.get("trackingState", "unavailable"))
        if self.tracking.get(phone) != state:
            self.tracking[phone] = state
            out.append(Publish(self.phone_topic(phone, "tracking"), "string", {"phone": phone, "state": state, "source": message.get("source")}, True))
        if message.get("heartbeat"):
            p, q = message["position"], message["rotation"]
            out.append(Publish(self.phone_topic(phone, "pose"), "pose", {
                "frame_id": f"{self.names.get(phone, slug(phone))}/operator",
                "position": {"x": p["x"], "y": p["y"], "z": p["z"]},
                "orientation": {"x": q["x"], "y": q["y"], "z": q["z"], "w": q["w"]},
                "tracking": message.get("trackingState"), "calibration": message.get("calibrationVersion"), "seq": message.get("seq"),
            }))
        return out

    def _button(self, message: dict[str, Any]) -> Publish:
        phone = message["phoneId"]
        event = {"phone": phone, "control": message.get("controlId"), "action": message.get("action"), "source": message.get("source"), "received_at_ms": message.get("receivedAt")}
        for key, name in (("value", "value"), ("renew", "repeat"), ("reason", "reason"), ("sentAt", "sent_at_ms")):
            if key in message:
                event[name] = message[key]
        return Publish(self.phone_topic(phone, "buttons"), "string", event)
