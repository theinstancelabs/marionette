"""Protocol constants and the few value rules the SDK shares with the gateway.

The authoritative protocol is ``packages/protocol/src/index.ts``; this module mirrors only what the Python parts need,
so they judge a value the same way the gateway does (a slider value off its step is refused by both, say).
"""

from __future__ import annotations

import json
import math
import time
from typing import Any

PROTOCOL_VERSION = 1
DEFAULT_PORT = 8787

# WebSocket close codes the gateway uses.
CLOSE_REPLACED = 4001
CLOSE_PAIRING = 4401
CLOSE_ROBOT_ID_IN_USE = 4409
CLOSE_CODES = {"replaced": CLOSE_REPLACED, "pairingRequired": CLOSE_PAIRING, "robotIdInUse": CLOSE_ROBOT_ID_IN_USE}

TRACKING_STATES = ("initializing", "normal", "limited", "relocalizing", "unavailable")
POSE_SOURCES = ("arkit", "device-motion", "synthetic")
CALIBRATION_STATUSES = ("uncalibrated", "capturing", "captured")
ROBOT_ID = r"^[a-z0-9][a-z0-9-]{0,63}$"
MAX_ROBOT_STATE_BYTES = 65_536
MAX_STATUS_VALUES_BYTES = 16_384
MAX_SCREEN_BYTES = 512_000
STICK_REST = {"x": 0, "y": 0}
# The app repeats a held press every 200 ms, and the latest sample of a resting drag every 50 ms.
HOLD_RENEW_S = 0.2
STREAM_RENEW_S = 0.05

ControlValue = str | int | float | bool | dict[str, float]


def wall_ms() -> float:
    """This computer's wall clock in milliseconds, with fractions (the protocol's time stamps)."""
    return time.time_ns() / 1e6


def stale_after_ms(every_ms: float | None) -> float:
    """How long a screen waits for robot state before calling the robot unresponsive."""
    return max(1500.0, 3.0 * (every_ms or 0.0))


def is_number(value: Any) -> bool:
    """A finite int or float, and not a bool (JSON has no separate bool-as-number)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def is_stick(value: Any) -> bool:
    """A stick value ``{"x", "y"}`` (nothing else in it), both finite numbers."""
    return isinstance(value, dict) and len(value) == 2 and is_number(value.get("x")) and is_number(value.get("y"))


def is_stick_in_range(value: Any) -> bool:
    """A stick value a control can hold: each axis within -1..1 and the push no longer than 1."""
    return (
        is_stick(value)
        and abs(value["x"]) <= 1
        and abs(value["y"]) <= 1
        and math.hypot(value["x"], value["y"]) <= 1 + 1e-6
    )


def is_control_value(value: Any) -> bool:
    """A value an action may carry: a string, a finite number, a boolean, or a stick."""
    return isinstance(value, (str, bool)) or is_number(value) or is_stick(value)


def valid_value(control: dict[str, Any], value: Any) -> bool:
    """Whether ``value`` suits a declared control, by the gateway's rules (it keeps only values that do)."""
    kind = control.get("type")
    if kind == "toggle":
        return isinstance(value, bool)
    if kind == "select":
        options = control.get("options") or []
        return isinstance(value, str) and any(isinstance(o, dict) and o.get("value") == value for o in options)
    if kind == "slider":
        low: Any = control.get("min")
        high: Any = control.get("max")
        step: Any = control.get("step")
        if not (is_number(value) and is_number(low) and is_number(high) and is_number(step) and step > 0):
            return False
        if not low <= value <= high:
            return False
        steps = (value - low) / step
        return abs(steps - round(steps)) < 1e-6
    if kind == "joystick":
        return is_stick_in_range(value)
    if kind == "button":
        return isinstance(value, bool) if control.get("hold") else True
    return False


def json_size(value: Any) -> int:
    """UTF-8 bytes of ``value`` as compact JSON; raises ValueError for NaN, infinities or anything not JSON."""
    return len(dumps(value).encode())


def dumps(value: Any) -> str:
    """Compact JSON, refusing NaN and infinities (the gateway would refuse them anyway)."""
    return json.dumps(value, separators=(",", ":"), allow_nan=False, ensure_ascii=False)
