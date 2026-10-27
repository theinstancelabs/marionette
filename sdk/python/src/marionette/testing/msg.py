"""Gateway messages, built the way the gateway builds them, so tests stop writing them by hand.

    from marionette.testing import msg
    tracker.apply(msg.config(phones=["phone-1"], phone="phone-1", controls=msg.default_controls()))
    tracker.apply(msg.input("phone-1", "teleop.deadman", True))
    tracker.apply(msg.pose("phone-1", position=(0.1, 0, 0)))

Every builder fills the fields the gateway always sends (``version``, ``receivedAt``, …) and takes the rest as
keyword arguments. Rotations may be a quaternion ``(x, y, z, w)``, a rotation vector or a 3×3 matrix.
"""

from __future__ import annotations

import copy
import itertools
from collections.abc import Iterable, Sequence
from typing import Any

import numpy as np

from ..protocol import PROTOCOL_VERSION, STICK_REST, wall_ms
from ..teleop import exp_rotation, matrix_to_quaternion

SESSION = "marionette-test"
"""The gateway session id the builders use unless told otherwise."""
COLORS = ("#c98200", "#b04fc4")
_seq = itertools.count(1)


def _drop_none(fields: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in fields.items() if value is not None}


def quaternion(rotation: Any) -> dict[str, float]:
    """A ``{x, y, z, w}`` from a quaternion, a rotation vector or a matrix (identity for None)."""
    if rotation is None:
        return {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}
    if isinstance(rotation, dict):
        return {key: float(rotation[key]) for key in "xyzw"}
    array = np.asarray(rotation, dtype=np.float64)
    if array.shape == (3, 3):
        q = matrix_to_quaternion(array)
    elif array.shape == (3,):
        q = matrix_to_quaternion(exp_rotation(array))
    elif array.shape == (4,):
        q = array / np.linalg.norm(array)
    else:
        raise ValueError("a rotation is a quaternion (x, y, z, w), a rotation vector or a 3×3 matrix")
    return dict(zip("xyzw", (float(v) for v in q), strict=True))


def vector(value: Any) -> dict[str, float]:
    if isinstance(value, dict):
        return {key: float(value[key]) for key in "xyz"}
    x, y, z = (float(v) for v in value)
    return {"x": x, "y": y, "z": z}


# -- controls -------------------------------------------------------------------------------------------------------


def button(id: str, action: str, *, label: str | None = None, hold: bool = False, held: bool | None = None, tone: str | None = None) -> dict[str, Any]:
    """A button control; ``hold=True`` for a hold button (``held`` is the gateway's view, in phone configs)."""
    return _drop_none({"id": id, "type": "button", "label": label or id, "action": action, "tone": tone, "hold": True if hold else None, "held": held})


def toggle(id: str, action: str, value: bool = False, *, label: str | None = None) -> dict[str, Any]:
    return {"id": id, "type": "toggle", "label": label or id, "action": action, "value": value}


def select(id: str, action: str, value: str, options: Iterable[str | tuple[str, str]], *, label: str | None = None) -> dict[str, Any]:
    """A select; ``options`` are values, or ``(label, value)`` pairs."""
    listed = [{"label": o[0], "value": o[1]} if isinstance(o, tuple) else {"label": o, "value": o} for o in options]
    return {"id": id, "type": "select", "label": label or id, "action": action, "value": value, "options": listed}


def slider(
    id: str, action: str, value: float, min: float, max: float, step: float, *, unit: str | None = None, live: bool | None = None, label: str | None = None
) -> dict[str, Any]:
    return _drop_none({"id": id, "type": "slider", "label": label or id, "action": action, "value": value, "min": min, "max": max, "step": step, "unit": unit, "live": live})


def joystick(id: str, action: str, value: dict[str, float] | None = None, *, live: bool | None = None, label: str | None = None) -> dict[str, Any]:
    return _drop_none({"id": id, "type": "joystick", "label": label or id, "action": action, "value": dict(value or STICK_REST), "live": live})


def default_controls() -> list[dict[str, Any]]:
    """The gateway's default layout (``defaultConfig`` in the protocol)."""
    return [
        button("deadman", "teleop.deadman", label="Hold to move", tone="accent", hold=True),
        button("grip", "gripper.hold", label="Grip", tone="accent", hold=True),
        toggle("estop", "safety.estop", label="Stop"),
        select("arm", "arm.select", "left", [("Left arm", "left"), ("Right arm", "right")], label="Active arm"),
        select("cameras", "camera.view", "head", [("Head cam", "head"), ("Arm cams", "arms")], label="Cameras"),
        toggle("lift", "lift.toggle", True, label="Include lift"),
        slider("sensitivity", "teleop.translationScale", 1, 0.1, 4, 0.1, unit="×", label="Translation scale"),
        joystick("drive", "base.drive", label="Drive"),
        button("turn-left", "base.turnLeft", label="Turn left", hold=True),
        button("turn-right", "base.turnRight", label="Turn right", hold=True),
        slider("speed-limit", "base.speedLimit", 50, 0, 100, 1, unit="%", label="Speed limit"),
        button("calibration-start", "calibration.start", label="Start guided calibration", tone="accent"),
        button("calibration", "calibration.capture", label="Capture current calibration step", tone="accent"),
        button("capture-origin", "calibration.captureOrigin", label="Quick capture origin", tone="accent"),
        button("calibration-cancel", "calibration.cancel", label="Cancel calibration"),
        button("reset-origin", "calibration.reset", label="Reset calibration"),
        button("calibration-check", "calibration.check", label="Validate calibration"),
    ]


# -- phones and configs ---------------------------------------------------------------------------------------------


def phone_info(id: str = "phone-1", *, name: str | None = None, color: str | None = None, connected: bool = True, session: str | None = None) -> dict[str, Any]:
    """A roster entry (``PhoneInfo``)."""
    try:
        number = int(id.rsplit("-", 1)[1])
    except (IndexError, ValueError):
        number = 99
    return _drop_none(
        {
            "id": id,
            "name": name or f"Phone {number}",
            "color": color or (COLORS[number - 1] if 1 <= number <= len(COLORS) else "#6b6f73"),
            "connected": connected,
            "sessionId": session,
        }
    )


def config(
    phones: Sequence[str | dict[str, Any]] = (),
    phone: str | dict[str, Any] | None = None,
    controls: Sequence[dict[str, Any]] | None = None,
    calibration: str | dict[str, Any] | None = None,
    *,
    values: dict[str, Any] | None = None,
    held: Iterable[str] = (),
    live: Iterable[str] = (),
    session: str = SESSION,
    server_name: str = "Marionette test",
    robots: Sequence[dict[str, Any]] | None = None,
    camera_streams: Sequence[dict[str, Any]] | None = None,
    camera_views: Sequence[dict[str, Any]] | None = None,
    gateway_id: str = "gw-test",
    auth: bool = False,
) -> dict[str, Any]:
    """A ``config``: the gateway's own view, or with ``phone`` one phone's view.

    ``phones`` is the roster (ids or :func:`phone_info` dicts); ``phone`` (an id or a dict) makes it that phone's
    config, which also lists it in the roster if it isn't. In a phone config, ``values`` sets control values by action,
    ``held`` the hold actions the gateway has as held and ``live`` the drags it hears (the others are false).
    ``calibration`` is a status or a ``{status, epoch, …}`` dict.
    """
    roster = [phone_info(p) if isinstance(p, str) else dict(p) for p in phones]
    own: dict[str, Any] | None = None
    if phone is not None:
        own = next((dict(p) for p in roster if p["id"] == phone), None) if isinstance(phone, str) else dict(phone)
        if own is None:
            own = phone_info(phone)  # type: ignore[arg-type]
        if not any(p["id"] == own["id"] for p in roster):
            roster.append(own)
    layout = copy.deepcopy(list(controls) if controls is not None else default_controls())
    if own is not None:
        held_set, live_set, values = set(held), set(live), values or {}
        for control in layout:
            action = control["action"]
            if action in values and control["type"] != "button":
                control["value"] = copy.deepcopy(values[action])
            if control["type"] == "button" and control.get("hold"):
                control.setdefault("held", action in held_set)
            elif control["type"] in ("slider", "joystick"):
                control.setdefault("live", action in live_set)
    calibration_state = {"status": calibration, "epoch": 0} if isinstance(calibration, str) else dict(calibration or {"status": "uncalibrated", "epoch": 0})
    calibration_state.setdefault("epoch", 0)
    message: dict[str, Any] = {
        "type": "config",
        "version": PROTOCOL_VERSION,
        "sessionId": session,
        "serverName": server_name,
        "controls": layout,
        "cameraStreams": list(camera_streams) if camera_streams is not None else [],
        "cameraViews": list(camera_views) if camera_views is not None else [],
        "calibration": calibration_state if own is not None else {"status": "uncalibrated", "epoch": 0},
        "phones": roster,
        "robots": list(robots or []),
        "gatewayId": gateway_id,
        "auth": auth,
    }
    if own is not None:
        message["phone"] = own
    return message


def pose(
    phone: str = "phone-1",
    position: Any = (0.0, 0.0, 0.0),
    rotation: Any = None,
    *,
    session: str = "s1",
    seq: int | None = None,
    tracking: str = "normal",
    source: str = "arkit",
    calibration: str = "guided-v2:1",
    heartbeat: bool = True,
    monotonic: float | None = None,
    sent_at: float | None = None,
    received_at: float | None = None,
    latency_ms: float | None = None,
) -> dict[str, Any]:
    """A forwarded ``pose`` in the operator frame (``phoneId``, ``receivedAt`` and ``latencyMs`` as the gateway adds them)."""
    covariance = {"normal": [0.0025] * 3 + [0.01] * 3, "unavailable": [1e6] * 6}.get(tracking, [0.25] * 3 + [1.0] * 3)
    number = next(_seq)
    return _drop_none(
        {
            "type": "pose",
            "version": PROTOCOL_VERSION,
            "sessionId": session,
            "seq": number if seq is None else seq,
            "monotonicTs": (number / 60.0) if monotonic is None else monotonic,
            "position": vector(position),
            "rotation": quaternion(rotation),
            "covariance": covariance,
            "source": source,
            "trackingState": tracking,
            "calibrationVersion": calibration,
            "heartbeat": heartbeat,
            "phoneId": phone,
            "sentAt": sent_at,
            "receivedAt": wall_ms() if received_at is None else received_at,
            "latencyMs": latency_ms,
        }
    )


def input(
    phone: str,
    action: str,
    value: Any = None,
    *,
    control: str | None = None,
    renew: bool = False,
    live: bool = False,
    source: str = "phone",
    reason: str | None = None,
    session: str | None = "s1",
    sent_at: float | None = None,
    received_at: float | None = None,
    latency_ms: float | None = None,
) -> dict[str, Any]:
    """An ``input``: a press, release, repeat (``renew``), drag sample (``live``) or value, from the phone, a mirror
    (``source="mirror"``) or the gateway (``source="gateway"`` with a ``reason``). ``control`` defaults to the
    action's last part."""
    return _drop_none(
        {
            "type": "input",
            "version": PROTOCOL_VERSION,
            "phoneId": phone,
            "sessionId": session,
            "controlId": control or action.rsplit(".", 1)[-1],
            "action": action,
            "value": copy.deepcopy(value),
            "renew": True if renew else None,
            "live": True if live else None,
            "source": source,
            "reason": reason,
            "sentAt": sent_at,
            "receivedAt": wall_ms() if received_at is None else received_at,
            "latencyMs": latency_ms,
        }
    )


def let_go(phone: str, action: str, value: Any = None, *, reason: str = "samples stopped", control: str | None = None) -> dict[str, Any]:
    """The gateway ending a hold (``value=False``) or a drag (a stick at rest, a slider's last value)."""
    return input(phone, action, value, control=control, source="gateway", reason=reason, session=None)


# -- robots, screens, clocks ----------------------------------------------------------------------------------------


def robot_info(id: str, *, name: str | None = None, connected: bool = True, screen: bool | None = None, streams: Sequence[str] | None = None) -> dict[str, Any]:
    return _drop_none({"id": id, "name": name or id, "connected": connected, "screen": screen, "streams": list(streams) if streams is not None else None})


def robot_state(
    robot: str, state: dict[str, Any], *, phone: str | None = None, every_ms: float | None = None, sent_at: float | None = None, received_at: float | None = None
) -> dict[str, Any]:
    """A relayed ``robot_state`` (``robotId`` and ``receivedAt`` filled in, as the gateway does)."""
    return _drop_none(
        {
            "type": "robot_state",
            "version": PROTOCOL_VERSION,
            "robotId": robot,
            "phoneId": phone,
            "state": copy.deepcopy(state),
            "everyMs": every_ms,
            "sentAt": sent_at,
            "receivedAt": wall_ms() if received_at is None else received_at,
        }
    )


def status(message: str, *, control: str | None = None, phone: str | None = None, values: dict[str, Any] | None = None, session: str = SESSION) -> dict[str, Any]:
    return _drop_none({"type": "status", "version": PROTOCOL_VERSION, "sessionId": session, "controlId": control, "message": message, "values": values, "phoneId": phone})


def html_config(html: str, *, title: str = "Marionette HTML controls", orientation: str | None = None, source: dict[str, Any] | None = None, session: str = SESSION) -> dict[str, Any]:
    return _drop_none(
        {
            "type": "html_config",
            "version": PROTOCOL_VERSION,
            "sessionId": session,
            "htmlVersion": 1,
            "bridgeVersion": 1,
            "html": html,
            "title": title,
            "orientation": orientation,
            "source": source or {"kind": "default"},
        }
    )


def hello(role: str = "console", **fields: Any) -> dict[str, Any]:
    """A ``hello``; ``robot_id``, ``device_id`` and ``session_id`` become ``robotId``, ``deviceId`` and ``sessionId``."""
    names = {"robot_id": "robotId", "device_id": "deviceId", "session_id": "sessionId"}
    return {"type": "hello", "version": PROTOCOL_VERSION, "role": role, **{names.get(k, k): v for k, v in fields.items() if v is not None}}


def ping(id: int, sent_at: float | None = None, rtt_ms: float | None = None) -> dict[str, Any]:
    return _drop_none({"type": "ping", "version": PROTOCOL_VERSION, "id": id, "sentAt": wall_ms() if sent_at is None else sent_at, "rttMs": rtt_ms})


def pong(id: int, sent_at: float, at: float | None = None) -> dict[str, Any]:
    return {"type": "pong", "version": PROTOCOL_VERSION, "id": id, "sentAt": sent_at, "at": wall_ms() if at is None else at}


def rtc(kind: str, **fields: Any) -> dict[str, Any]:
    """An ``rtc`` signaling message; ``from_`` becomes ``from``."""
    return {"type": "rtc", "version": PROTOCOL_VERSION, "kind": kind, **{k.rstrip("_"): v for k, v in fields.items() if v is not None}}
