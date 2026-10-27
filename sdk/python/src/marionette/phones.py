"""What each phone is doing, folded from the gateway's messages.

The gateway relays, per phone: its control values and which hold buttons and drags it reports (``config`` with
``phone``), its pose in the operator frame (``pose``), and every press verbatim (``input``). :class:`PhoneTracker`
folds them into one :class:`Phone` record per phone. It knows no actions by name: holds are the layout's buttons
with ``hold: true``, drags its sliders and sticks, and everything else is read by control type. It decides nothing
either; the robot reads the records (:meth:`PhoneTracker.snapshot`) every control tick and decides.

The rules, each learned the hard way on a robot:

- A repeat (``renew``) only extends a hold that is already down; it never starts one, so a repeat racing a release
  can't press the button again.
- Press edges are counted, for hold buttons and plain buttons alike, so a robot can consume each press once.
- A drag the gateway ended (its samples stopped) stays ended, ``dropped``, until the finger lifts, however many
  samples still arrive. A stick comes back to rest; a slider keeps its value.
- Slider and stick values come from the live inputs: the gateway's config only follows a drag's start and end.
- Stop acts from the press itself, not from the config that follows it.
- A lost gateway means everyone lets go, and a disconnected phone holds nothing.
- A restarted gateway names phones afresh, but a phone that was left with Stop on survives, offline, as
  ``<id>@<old gateway session>`` until :meth:`PhoneTracker.clear_stale_stops`.
- A desktop mirror of a phone's screen (the gateway's ``/screen``) acts as that phone. By default it may only turn
  Stop on (``mirror="stop-only"``): someone at a desk shouldn't drive a robot with a phone nobody may be holding.
"""

from __future__ import annotations

import copy
import math
import threading
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any, Literal

import numpy as np

from .protocol import CALIBRATION_STATUSES, STICK_REST, TRACKING_STATES, is_control_value, is_number, valid_value, wall_ms
from .teleop import quaternion_to_matrix

if TYPE_CHECKING:
    from .client import GatewayClient

MirrorPolicy = Literal["allow", "stop-only", "deny"]
MIRROR_POLICIES = ("allow", "stop-only", "deny")
DEFAULT_STOP = "safety.estop"


@dataclass(frozen=True)
class Pose:
    """One pose in the phone's operator frame (+X forward, +Y left, +Z up, metres), as the gateway published it.

    ``received`` is the tracker's clock (``time.monotonic()`` by default) when it arrived. ``latency_ms`` is the
    gateway's estimate of phone → gateway, ``hop_ms`` this client's estimate of gateway → here (from its pings);
    either is None until known. :meth:`age` adds both to the time since arrival.
    """

    position: np.ndarray
    rotation: np.ndarray
    quaternion: np.ndarray
    tracking: str
    source: str
    heartbeat: bool
    calibration: str
    session: str
    seq: int
    received: float
    stamp: float
    sent_at: float | None = None
    received_at: float | None = None
    latency_ms: float | None = None
    hop_ms: float | None = None

    @property
    def delay_ms(self) -> float | None:
        """Phone send → arrival here, when both legs are known."""
        if self.latency_ms is None or self.hop_ms is None:
            return None
        return self.latency_ms + self.hop_ms

    def age(self, now: float) -> float:
        """Seconds since the phone sent this pose (``now`` on the tracker's clock), as far as the stamps tell."""
        return now - self.received + ((self.latency_ms or 0.0) + (self.hop_ms or 0.0)) / 1000.0


@dataclass
class Hold:
    """A hold button: pressed, repeated every 200 ms while it stays pressed, released."""

    down: bool = False
    at: float = -math.inf
    """When it was last pressed or repeated (tracker clock)."""
    presses: int = 0
    """Press edges so far."""

    def live(self, now: float, timeout: float = 0.6) -> bool:
        """Down, and its repeats still arriving."""
        return self.down and now - self.at <= timeout


@dataclass
class Drag:
    """A slider or stick: its value, and whether a finger is dragging it."""

    value: Any = None
    live: bool = False
    dropped: bool = False
    """The gateway ended the drag while the finger was still on it; it counts again after the finger lifts."""
    at: float = -math.inf
    """When the last sample arrived (tracker clock)."""

    def fresh(self, now: float, timeout: float = 0.25) -> bool:
        """Live, not dropped, and its samples (or repeats) still arriving."""
        return self.live and not self.dropped and now - self.at <= timeout


@dataclass
class Phone:
    """One phone as the gateway last described it. Read it from :meth:`PhoneTracker.snapshot` (a copy)."""

    id: str
    name: str = ""
    color: str = "#6b6f73"
    connected: bool = False
    session: str | None = None
    """The phone's current ARKit session, as the roster reports it."""
    calibration: str = "uncalibrated"
    """``uncalibrated``, ``capturing`` or ``captured``."""
    epoch: int = 0
    """Changes whenever the phone's published frame changes: re-anchor when it does."""
    pose: Pose | None = None
    values: dict[str, Any] = field(default_factory=dict)
    """Every toggle, select, slider and stick value by action, and values of undeclared actions."""
    holds: dict[str, Hold] = field(default_factory=dict)
    drags: dict[str, Drag] = field(default_factory=dict)
    press_counts: dict[str, int] = field(default_factory=dict)
    """Presses of plain buttons (and of actions no control declares), by action; holds count in ``holds``."""
    stop_action: str = DEFAULT_STOP
    gateway: str | None = None
    """The gateway session this id belongs to."""
    stale: bool = False
    """Kept from an earlier gateway (or a phone gone from the roster) because its Stop was on."""
    _stop_known: bool = field(default=False, repr=False)
    _stop_cleared: bool = field(default=False, repr=False)

    def copy(self) -> Phone:
        """A copy that shares nothing mutable with this one (poses are immutable)."""
        return replace(
            self,
            values=copy.deepcopy(self.values),
            holds={action: replace(hold) for action, hold in self.holds.items()},
            drags={action: replace(drag, value=copy.deepcopy(drag.value)) for action, drag in self.drags.items()},
            press_counts=dict(self.press_counts),
        )

    # -- reading -------------------------------------------------------------------------------------------------

    @property
    def index(self) -> int:
        """The gateway numbers phones in connection order: ``phone-2`` is 2 (a large number if it isn't one)."""
        try:
            return int(self.id.split("@", 1)[0].rsplit("-", 1)[1])
        except (IndexError, ValueError):
            return 1_000_000

    @property
    def stop(self) -> bool:
        """This phone's Stop is on (its stop toggle, or a stop hold button held)."""
        hold = self.holds.get(self.stop_action)
        return self.values.get(self.stop_action) is True or (hold is not None and hold.down)

    def value(self, action: str, default: Any = None) -> Any:
        """The current value of ``action`` (a copy), or ``default``."""
        return copy.deepcopy(self.values[action]) if action in self.values else default

    def number(self, action: str, default: float, lo: float = -math.inf, hi: float = math.inf) -> float:
        """A numeric value clamped to ``[lo, hi]``; ``default`` when it is missing or not a finite number."""
        value: Any = self.values.get(action)
        if not is_number(value):
            return default
        return min(max(float(value), lo), hi)

    def choice(self, action: str, options: Iterable[Any], default: Any) -> Any:
        """The value if it is one of ``options``, else ``default`` (a select whose options the robot narrowed)."""
        value = self.values.get(action)
        return value if value in tuple(options) else default

    def flag(self, action: str, default: bool = False) -> bool:
        """A toggle's value; ``default`` when it isn't a boolean."""
        value = self.values.get(action)
        return value if isinstance(value, bool) else default

    def hold(self, action: str) -> Hold:
        """A hold button's state (a copy; an idle hold if the phone has none)."""
        return replace(self.holds.get(action) or Hold())

    def holding(self, action: str, now: float, timeout: float = 0.6) -> bool:
        """The hold button is down and its repeats are still arriving (``now`` on the tracker's clock)."""
        hold = self.holds.get(action)
        return hold is not None and hold.live(now, timeout)

    def drag(self, action: str) -> Drag:
        """A slider's or stick's drag state (a copy; an idle drag if the phone has none)."""
        drag = self.drags.get(action)
        return replace(drag, value=copy.deepcopy(drag.value)) if drag is not None else Drag()

    def presses(self, action: str) -> int:
        """Press edges of ``action`` so far: a hold button's, or a plain button's. Pair it with ``PressTracker``."""
        hold = self.holds.get(action)
        return hold.presses if hold is not None else self.press_counts.get(action, 0)

    def stick(self, action: str, now: float | None = None, timeout: float = 0.25) -> tuple[float, float] | None:
        """Where a stick is pushed: ``(x forward, y left)`` while it is dragged, ``(0, 0)`` when it isn't.

        With ``now``, a drag whose samples stopped for ``timeout`` seconds is a dead source and gives None: stop at
        once, as when a link drops (the gateway ends it a little later, and it stays at rest until let go).
        """
        drag = self.drags.get(action)
        if drag is None or not drag.live or drag.dropped:
            return (0.0, 0.0)
        if now is not None and now - drag.at > timeout:
            return None
        value = drag.value
        if not isinstance(value, dict) or not is_number(value.get("x")) or not is_number(value.get("y")):
            return (0.0, 0.0)
        return (float(value["x"]), float(value["y"]))

    def age(self, now: float) -> float | None:
        """Seconds since the phone sent its current pose, or None without one."""
        return None if self.pose is None else self.pose.age(now)

    def to_conformance(self) -> dict[str, Any]:
        """The shape the conformance fixtures compare (``sdk/conformance/tracker``), the same in every SDK."""
        pose = self.pose
        return {
            "id": self.id,
            "connected": self.connected,
            "calibration": self.calibration,
            "epoch": self.epoch,
            "stop": self.stop,
            "values": copy.deepcopy(self.values),
            "holds": {action: {"down": hold.down, "presses": hold.presses} for action, hold in self.holds.items()},
            "drags": {
                action: {"live": drag.live, "dropped": drag.dropped, "value": copy.deepcopy(drag.value)}
                for action, drag in self.drags.items()
            },
            "presses": {**self.press_counts, **{action: hold.presses for action, hold in self.holds.items()}},
            "pose": None
            if pose is None
            else {"session": pose.session, "tracking": pose.tracking, "source": pose.source, "calibration": pose.calibration},
        }


def _let_go(phone: Phone, layout: dict[str, dict[str, Any]]) -> None:
    """A phone that is gone holds nothing and touches nothing; a stick goes back to rest."""
    phone.pose = None
    for hold in phone.holds.values():
        hold.down = False
    for action, drag in phone.drags.items():
        drag.live = False
        drag.dropped = False
        if layout.get(action, {}).get("type") == "joystick":
            drag.value = dict(STICK_REST)
            phone.values[action] = dict(STICK_REST)


def _vector(value: Any, keys: str) -> np.ndarray | None:
    if not isinstance(value, dict) or not all(is_number(value.get(key)) for key in keys):
        return None
    return np.array([float(value[key]) for key in keys])


class PhoneTracker:
    """Phones by id, folded from gateway messages. Thread-safe: feed it from the connection, read it anywhere.

    ``clock`` is the time base for ``received`` and every ``now`` argument (monotonic seconds by default).
    ``mirror`` is the policy for a desktop mirror's presses: ``allow`` (like the phone's own), ``stop-only`` (it may
    only turn Stop on) or ``deny``. ``stop_action`` names Stop. ``offset`` gives the gateway's clock minus this
    computer's in milliseconds (a :class:`GatewayClient` measures it; :meth:`attach` wires it up), so pose ages
    include the hop from the gateway.
    """

    def __init__(
        self,
        clock: Callable[[], float] = time.monotonic,
        *,
        mirror: MirrorPolicy = "stop-only",
        stop_action: str = DEFAULT_STOP,
        offset: Callable[[], float | None] | None = None,
        wall: Callable[[], float] = wall_ms,
    ) -> None:
        if mirror not in MIRROR_POLICIES:
            raise ValueError(f"mirror must be one of {', '.join(MIRROR_POLICIES)}, not {mirror!r}")
        self._clock = clock
        self._wall = wall
        self.offset = offset
        self.mirror: MirrorPolicy = mirror
        self.stop_action = stop_action
        self._lock = threading.RLock()
        self._phones: dict[str, Phone] = {}
        self._layout: dict[str, dict[str, Any]] = {}
        self._gateway: str | None = None

    # -- wiring ----------------------------------------------------------------------------------------------------

    def attach(self, client: GatewayClient) -> None:
        """Follow a :class:`GatewayClient`: fold every message in, let go when it loses the gateway, and use its
        clock offset for pose ages."""
        client.on("message", self.apply)
        client.on("lost", self.lost_gateway)
        self.offset = lambda: client.offset_ms

    # -- reading ---------------------------------------------------------------------------------------------------

    @property
    def gateway(self) -> str | None:
        """The current gateway's session id (it changes when the gateway restarts)."""
        with self._lock:
            return self._gateway

    @property
    def layout(self) -> dict[str, dict[str, Any]]:
        """The screen's controls by action (the first control with each action), as the last config declared them."""
        with self._lock:
            return copy.deepcopy(self._layout)

    def snapshot(self) -> dict[str, Phone]:
        """A copy of every phone by id, safe to read without the lock."""
        with self._lock:
            return {phone_id: phone.copy() for phone_id, phone in self._phones.items()}

    def get(self, phone_id: str) -> Phone | None:
        """A copy of one phone, or None."""
        with self._lock:
            phone = self._phones.get(phone_id)
            return None if phone is None else phone.copy()

    def connected(self) -> list[Phone]:
        """Copies of the connected phones, lowest number first."""
        with self._lock:
            return sorted((p.copy() for p in self._phones.values() if p.connected), key=lambda p: p.index)

    def any_stop(self) -> bool:
        """Whether any phone (connected, offline, or kept from an earlier gateway) has Stop on."""
        with self._lock:
            return any(phone.stop for phone in self._phones.values())

    def stops(self) -> list[Phone]:
        """Copies of the phones with Stop on, connected ones first, then by number."""
        with self._lock:
            on = [phone.copy() for phone in self._phones.values() if phone.stop]
        return sorted(on, key=lambda p: (not p.connected, p.stale, p.index))

    # -- changes from the robot ------------------------------------------------------------------------------------

    def lost_gateway(self) -> None:
        """The gateway went away: nobody is connected, holding or dragging anything. Stops stay on."""
        with self._lock:
            for phone in self._phones.values():
                phone.connected = False
                phone._stop_known = False
                _let_go(phone, self._layout)

    def clear_stale_stops(self) -> list[str]:
        """Forget Stop on phones that can't turn it off themselves; returns their ids.

        Phones kept from an earlier gateway (``…@…``) are removed. Offline phones of this gateway get Stop off until
        they reconnect (then their own Stop, as their screen shows it, applies again). Call it when an operator at
        the robot clears Stop deliberately.
        """
        cleared: list[str] = []
        with self._lock:
            for phone_id, phone in list(self._phones.items()):
                if phone.stale:
                    del self._phones[phone_id]
                    cleared.append(phone_id)
                elif not phone.connected and phone.stop:
                    phone.values[self.stop_action] = False
                    hold = phone.holds.get(self.stop_action)
                    if hold is not None:
                        hold.down = False
                    phone._stop_cleared = True
                    cleared.append(phone_id)
        return cleared

    def forget(self, phone_id: str) -> None:
        """Drop one phone record (it comes back with the next config that names it)."""
        with self._lock:
            self._phones.pop(phone_id, None)

    # -- messages --------------------------------------------------------------------------------------------------

    def apply(self, message: Any) -> None:
        """Fold one gateway message in. Anything that isn't a well-formed config, pose or input is ignored."""
        if not isinstance(message, dict):
            return
        kind = message.get("type")
        with self._lock:
            if kind == "config":
                self._config(message)
            elif kind == "pose":
                self._pose(message)
            elif kind == "input":
                self._input(message)

    def _kind(self, action: str) -> str | None:
        control = self._layout.get(action)
        if control is None:
            return None
        kind = control.get("type")
        if kind == "button":
            return "hold" if control.get("hold") is True else "button"
        if kind in ("slider", "joystick"):
            return "drag"
        if kind in ("toggle", "select"):
            return "value"
        return None

    def _records(self, phone: Phone) -> None:
        """Make sure the phone has a record for every hold, drag and button the layout declares."""
        for action, control in self._layout.items():
            kind = self._kind(action)
            if kind == "hold":
                phone.holds.setdefault(action, Hold())
            elif kind == "button":
                phone.press_counts.setdefault(action, 0)
            elif kind == "drag":
                if action not in phone.drags:
                    phone.drags[action] = Drag(value=copy.deepcopy(control.get("value")))
                if "value" in control:
                    phone.values.setdefault(action, copy.deepcopy(control["value"]))
            elif kind == "value" and "value" in control:
                phone.values.setdefault(action, copy.deepcopy(control["value"]))

    def _new_phone(self, phone_id: str) -> Phone:
        phone = Phone(phone_id, phone_id, stop_action=self.stop_action, gateway=self._gateway)
        self._records(phone)
        self._phones[phone_id] = phone
        return phone

    def _learn_layout(self, controls: Sequence[Any]) -> None:
        layout: dict[str, dict[str, Any]] = {}
        for control in controls:
            if isinstance(control, dict) and isinstance(control.get("action"), str) and isinstance(control.get("type"), str):
                layout.setdefault(control["action"], control)
        if layout == self._layout:
            return
        self._layout = copy.deepcopy(layout)
        for phone in self._phones.values():
            self._records(phone)

    def _restart(self, old: str) -> None:
        """A new gateway session: its phone ids mean other phones. Keep only phones with Stop on, renamed."""
        kept: dict[str, Phone] = {}
        for phone_id, phone in self._phones.items():
            if phone.stale:
                kept[phone_id] = phone
            elif phone.stop:
                self._retire(phone, old)
                kept[phone.id] = phone
        self._phones = kept

    def _retire(self, phone: Phone, gateway: str | None) -> None:
        _let_go(phone, self._layout)
        phone.connected = False
        phone.stale = True
        phone.id = f"{phone.id}@{gateway or 'gone'}"
        phone.gateway = gateway

    def _info(self, info: Any) -> Phone | None:
        if not isinstance(info, dict) or not isinstance(info.get("id"), str) or not info["id"]:
            return None
        phone = self._phones.get(info["id"])
        if phone is None:
            phone = self._new_phone(info["id"])
        if isinstance(info.get("name"), str):
            phone.name = info["name"]
        if isinstance(info.get("color"), str):
            phone.color = info["color"]
        connected = info.get("connected") is True
        if not connected:
            _let_go(phone, self._layout)
        elif not phone.connected:
            phone._stop_cleared = False
        phone.connected = connected
        session = info.get("sessionId")
        phone.session = session if isinstance(session, str) else None
        return phone

    def _config(self, message: dict[str, Any]) -> None:
        gateway = message.get("sessionId")
        if isinstance(gateway, str) and gateway and gateway != self._gateway:
            if self._gateway is not None:
                self._restart(self._gateway)
            self._gateway = gateway
        controls = message.get("controls")
        if isinstance(controls, list):
            self._learn_layout(controls)
        own = message.get("phone")
        own_id = own.get("id") if isinstance(own, dict) else None
        roster = message.get("phones")
        if isinstance(roster, list):
            listed = {own_id}
            readable = True
            for info in roster:
                phone = self._info(info)
                if phone is not None:
                    listed.add(phone.id)
                else:
                    readable = False
            # A phone gone from the roster (an old app without a device id) is gone for good; keep its Stop. A roster
            # with an entry that can't be read isn't trusted to say who has gone.
            for phone_id, phone in list(self._phones.items()) if readable else []:
                if phone.stale or phone_id in listed:
                    continue
                del self._phones[phone_id]
                if phone.stop:
                    self._retire(phone, self._gateway)
                    self._phones[phone.id] = phone
        phone = self._info(own)
        if phone is None:
            return
        for control in controls if isinstance(controls, list) else []:
            if isinstance(control, dict) and isinstance(control.get("action"), str):
                self._config_control(phone, control)
        calibration = message.get("calibration")
        if isinstance(calibration, dict):
            if calibration.get("status") in CALIBRATION_STATUSES:
                phone.calibration = calibration["status"]
            epoch = calibration.get("epoch")
            if isinstance(epoch, int) and not isinstance(epoch, bool):
                phone.epoch = epoch

    def _config_control(self, phone: Phone, control: dict[str, Any]) -> None:
        """One control in a phone's own config: the gateway's view of its values, holds and drags."""
        action: str = control["action"]
        kind = control.get("type")
        if kind == "button":
            # The gateway's view only ever ends a hold (its repeats stopped); a press starts one, never a config.
            hold = phone.holds.get(action)
            if hold is not None and control.get("held") is False:
                hold.down = False
            return
        if "value" not in control or not valid_value(control, control["value"]):
            return
        value = control["value"]
        if kind in ("slider", "joystick"):
            drag = phone.drags.setdefault(action, Drag())
            if control.get("live") is False and drag.live:
                drag.live = False
            # While a drag is live its samples are newer than any config.
            if not drag.live:
                drag.value = copy.deepcopy(value)
                phone.values[action] = copy.deepcopy(value)
            return
        if action == self.stop_action:
            if value is True and phone._stop_cleared and not phone.connected:
                return
            # Past the first config, only a press turns Stop off (a mirror's can't, unless mirrors are allowed).
            if self.mirror != "allow" and phone._stop_known and value is not True and phone.values.get(action) is True:
                return
            phone._stop_known = True
        phone.values[action] = copy.deepcopy(value)

    def _pose(self, message: dict[str, Any]) -> None:
        phone = self._phones.get(message.get("phoneId"))  # type: ignore[arg-type]
        if phone is None or phone.stale:
            return
        if message.get("heartbeat") is False:
            phone.pose = None
            return
        position = _vector(message.get("position"), "xyz")
        quaternion = _vector(message.get("rotation"), "xyzw")
        tracking, source = message.get("trackingState"), message.get("source")
        session, calibration = message.get("sessionId"), message.get("calibrationVersion")
        if (
            position is None
            or quaternion is None
            or float(np.linalg.norm(quaternion)) < 1e-6
            or tracking not in TRACKING_STATES
            or not isinstance(source, str)
            or not isinstance(session, str)
            or not isinstance(calibration, str)
            or message.get("heartbeat") is not True
        ):
            return
        quaternion = quaternion / np.linalg.norm(quaternion)
        now = self._clock()
        received_at = message.get("receivedAt") if is_number(message.get("receivedAt")) else None
        latency = message.get("latencyMs") if is_number(message.get("latencyMs")) else None
        offset = self.offset() if self.offset is not None else None
        hop = max(0.0, self._wall() + offset - received_at) if offset is not None and received_at is not None else None
        rotation = quaternion_to_matrix(quaternion)
        for array in (position, quaternion, rotation):
            array.setflags(write=False)
        phone.pose = Pose(
            position=position,
            rotation=rotation,
            quaternion=quaternion,
            tracking=tracking,
            source=source,
            heartbeat=True,
            calibration=calibration,
            session=session,
            seq=message["seq"] if isinstance(message.get("seq"), int) else 0,
            received=now,
            stamp=float(message["monotonicTs"]) if is_number(message.get("monotonicTs")) else now,
            sent_at=message.get("sentAt") if is_number(message.get("sentAt")) else None,
            received_at=received_at,
            latency_ms=latency,
            hop_ms=hop,
        )

    def _input(self, message: dict[str, Any]) -> None:
        phone = self._phones.get(message.get("phoneId"))  # type: ignore[arg-type]
        action = message.get("action")
        source = message.get("source", "phone")
        if phone is None or phone.stale or not isinstance(action, str) or not action or source not in ("phone", "mirror", "gateway"):
            return
        value = message.get("value")
        renew, live = message.get("renew") is True, message.get("live") is True
        now = self._clock()
        if source == "mirror" and self.mirror != "allow":
            # From a desk, only Stop: turning it on, never off.
            if self.mirror == "stop-only" and action == self.stop_action and value is True:
                self._set_stop(phone, True, now)
            return
        kind = self._kind(action)
        control = self._layout.get(action, {})
        if action == self.stop_action and isinstance(value, bool) and kind != "hold":
            # Stop acts from the press itself; the config follows.
            self._set_stop(phone, value, now)
            return
        if kind == "hold":
            hold = phone.holds.setdefault(action, Hold())
            if source == "gateway" or value is not True:
                hold.down = False
            elif renew:
                # A repeat only extends a hold that is already down; it never presses again.
                if hold.down:
                    hold.at = now
            else:
                if not hold.down:
                    hold.presses += 1
                hold.down = True
                hold.at = now
            return
        if kind == "drag":
            self._drag(phone, action, control, value, source == "gateway", live, renew, now)
            return
        if source == "gateway":
            return
        if kind == "value":
            if valid_value(control, value):
                phone.values[action] = copy.deepcopy(value)
            return
        # A plain button, or an action no control declares: count presses (a repeat isn't one).
        if renew:
            return
        phone.press_counts[action] = phone.press_counts.get(action, 0) + 1
        if kind is None and is_control_value(value):
            phone.values[action] = copy.deepcopy(value)

    def _drag(self, phone: Phone, action: str, control: dict[str, Any], value: Any, ended: bool, live: bool, renew: bool, now: float) -> None:
        drag = phone.drags.setdefault(action, Drag())
        stick = control.get("type") == "joystick"
        if ended or not live:
            if ended:
                # The gateway stopped hearing it: it stays ended until the finger lifts, whatever samples still come.
                drag.dropped = drag.live or drag.dropped
            else:
                # Let go: the final value (a stick springs back to rest); samples count again from the next touch.
                drag.dropped = False
            drag.live = False
            final = dict(STICK_REST) if stick else value
            if valid_value(control, final):
                drag.value = copy.deepcopy(final)
                phone.values[action] = copy.deepcopy(final)
            return
        if drag.dropped or (renew and not drag.live) or not valid_value(control, value):
            return
        drag.live = True
        drag.at = now
        drag.value = copy.deepcopy(value)
        phone.values[action] = copy.deepcopy(value)

    def _set_stop(self, phone: Phone, on: bool, now: float) -> None:
        hold = phone.holds.get(self.stop_action)
        if hold is not None:
            if on and not hold.down:
                hold.presses += 1
            hold.down = on
            hold.at = now
        else:
            phone.values[self.stop_action] = on
        phone._stop_known = True
        if on:
            phone._stop_cleared = False
