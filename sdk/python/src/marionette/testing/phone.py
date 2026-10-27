"""A scriptable phone that talks to a real gateway the way the iPhone app does.

:class:`AsyncSimPhone` (asyncio) and :class:`SimPhone` (blocking, on its own thread) say hello with a device id,
stream raw ARKit camera poses at about 60 Hz, answer the gateway's pings (so poses get latency stamps), and press,
hold, drag and set controls with the app's repeats (a held button every 200 ms, a resting drag every 50 ms).

Poses are scripted in the operator's own frame (REP-103: +X forward, +Y left, +Z up, metres): ``move_to`` and
``move_by`` set where the phone is in the room, and the phone turns that into what ARKit would report. ARKit's world
is turned ``heading`` degrees from the operator's forward, as on a real phone that started tracking facing elsewhere,
so uncalibrated poses come out turned by ``heading``; after :meth:`AsyncSimPhone.calibrate` (the guided four steps,
with real moves) the gateway publishes the operator frame itself, measured from the spot where calibration began.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import secrets
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator
from typing import Any

import numpy as np

from ..address import resolve
from ..frames import ARKIT_TO_OPERATOR, CAMERA_TO_BODY
from ..protocol import HOLD_RENEW_S, PROTOCOL_VERSION, STICK_REST, STREAM_RENEW_S, dumps, wall_ms
from ..teleop import exp_rotation, matrix_to_quaternion, quaternion_to_matrix, rotation_vector

_TRACKING_COVARIANCE = {"normal": [0.0025] * 3 + [0.01] * 3, "unavailable": [1e6] * 6}


class CalibrationRefused(RuntimeError):
    """The gateway refused a calibration step; the message is its reason."""


def _rotation(value: Any) -> np.ndarray:
    if value is None:
        return np.eye(3)
    if isinstance(value, dict):
        return quaternion_to_matrix(value)
    array = np.asarray(value, dtype=np.float64)
    if array.shape == (3, 3):
        return array.copy()
    if array.shape == (3,):
        return exp_rotation(array)
    if array.shape == (4,):
        return quaternion_to_matrix(array)
    raise ValueError("a rotation is a 3×3 matrix, a rotation vector (3) or a quaternion (x, y, z, w)")


def _rz(degrees: float) -> np.ndarray:
    a = math.radians(degrees)
    return np.array([[math.cos(a), -math.sin(a), 0.0], [math.sin(a), math.cos(a), 0.0], [0.0, 0.0, 1.0]])


class AsyncSimPhone:
    """A scripted phone on the running event loop. ``gateway`` is a URL, an address, a pairing link or anything with
    a ``url`` (a :class:`~marionette.testing.Gateway`)."""

    def __init__(
        self,
        gateway: Any,
        *,
        device_id: str | None = None,
        token: str | None = None,
        heading: float = 30.0,
        origin: Any = (0.2, -0.1, 0.3),
        rate: float = 60.0,
        tracking: str = "normal",
        source: str = "arkit",
        clock_skew_ms: float = 0.0,
    ) -> None:
        target = resolve(gateway if isinstance(gateway, str) else gateway.url)
        self.url = target.urls[0]
        self.token = token if token is not None else target.token
        self.device_id = device_id or f"sim-{secrets.token_hex(4)}"
        self.rate = rate
        self.tracking_state = tracking
        self.source = source
        self.clock_skew_ms = clock_skew_ms
        # Operator frame → ARKit world (ARKit's forward is `heading` degrees from the operator's), and where the
        # operator's origin sits in ARKit's world.
        self.world = ARKIT_TO_OPERATOR.T @ _rz(heading)
        self.origin = np.asarray(origin, dtype=np.float64)
        self.position = np.zeros(3)
        self.rotation = np.eye(3)
        self.session = f"sim-session-{secrets.token_hex(3)}"
        self.seq = 0
        self.phone_id: str | None = None
        self.config: dict[str, Any] | None = None
        """This phone's latest own config (its values, holds, drags and calibration)."""
        self.gateway_config: dict[str, Any] | None = None
        self.html: dict[str, Any] | None = None
        self.statuses: list[dict[str, Any]] = []
        self.robot_states: list[dict[str, Any]] = []
        self.messages: deque[dict[str, Any]] = deque(maxlen=2000)
        self.connected = False
        self.close_code: int | None = None
        self._ws: Any = None
        self._tasks: list[asyncio.Task[Any]] = []
        self._motion: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, float, float] | None = None
        self._holds: dict[str, tuple[str, float]] = {}
        self._drags: dict[str, tuple[str, Any, float]] = {}
        self._paused = False
        self._sent_motion = 0

    # -- connection -------------------------------------------------------------------------------------------------

    async def connect(self, timeout: float = 5.0) -> AsyncSimPhone:
        """Connect, say hello and start streaming; returns once the gateway has named the phone."""
        await self._open(resume=False)
        await self.wait_for(lambda phone: phone.phone_id is not None and phone.config is not None, timeout, "the phone's config")
        return self

    async def _open(self, resume: bool) -> None:
        from websockets.asyncio.client import connect

        from ..client import _connect_options

        self._ws = await connect(self.url, **_connect_options())
        self.connected = True
        self.close_code = None
        hello: dict[str, Any] = {"type": "hello", "version": PROTOCOL_VERSION, "role": "phone", "deviceId": self.device_id}
        if resume:
            hello["sessionId"] = self.session
        if self.token:
            hello["token"] = self.token
        await self._ws.send(dumps(hello))
        self._tasks = [asyncio.ensure_future(self._receive()), asyncio.ensure_future(self._stream()), asyncio.ensure_future(self._renew())]

    async def disconnect(self) -> None:
        """Close the connection (as the app does when it drops: holds and drags end there)."""
        self._holds.clear()
        self._drags.clear()
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        if self._ws is not None:
            await self._ws.close()
            self._ws = None
        self.connected = False

    async def reconnect(self, same_session: bool = True, timeout: float = 5.0) -> AsyncSimPhone:
        """Connect again with the same device id. ``same_session`` keeps the ARKit session (and so the calibration,
        on a gateway that supports reconnecting in place); otherwise ARKit starts a new world."""
        await self.disconnect()
        if not same_session:
            self.new_session()
        self.phone_id = None
        self.config = None
        await self._open(resume=same_session)
        await self.wait_for(lambda phone: phone.phone_id is not None and phone.config is not None, timeout, "the phone's config")
        return self

    def new_session(self) -> None:
        """ARKit restarts its world (a new session id; sequence numbers start again)."""
        self.session = f"sim-session-{secrets.token_hex(3)}"
        self.seq = 0

    async def close(self) -> None:
        await self.disconnect()

    async def __aenter__(self) -> AsyncSimPhone:
        return await self.connect()

    async def __aexit__(self, *_: Any) -> None:
        await self.close()

    async def _send(self, message: dict[str, Any]) -> None:
        if self._ws is None:
            raise RuntimeError("the phone isn't connected")
        await self._ws.send(dumps(message))

    def _now_ms(self) -> float:
        return wall_ms() + self.clock_skew_ms

    async def _receive(self) -> None:
        from websockets.exceptions import ConnectionClosed

        ws = self._ws
        try:
            async for raw in ws:
                message = json.loads(raw)
                if not isinstance(message, dict):
                    continue
                kind = message.get("type")
                if kind == "ping":
                    await self._send({"type": "pong", "version": PROTOCOL_VERSION, "id": message["id"], "sentAt": message["sentAt"], "at": self._now_ms()})
                    continue
                self.messages.append(message)
                if kind == "config":
                    if isinstance(message.get("phone"), dict):
                        self.config = message
                        self.phone_id = message["phone"]["id"]
                    else:
                        self.gateway_config = message
                elif kind == "status":
                    self.statuses.append(message)
                elif kind == "robot_state":
                    self.robot_states.append(message)
                elif kind == "html_config":
                    self.html = message
        except ConnectionClosed:
            pass
        finally:
            self.close_code = getattr(ws, "close_code", None)
            self.connected = False

    # -- poses ------------------------------------------------------------------------------------------------------

    def tracking(self, state: str, source: str | None = None) -> None:
        """Set ARKit's tracking state (``normal``, ``limited``, ``initializing``, …) and optionally the source."""
        self.tracking_state = state
        if source is not None:
            self.source = source

    def pose(self) -> tuple[np.ndarray, np.ndarray]:
        """Where the phone is now in the operator's frame (position, rotation), mid-move included."""
        motion = self._motion
        if motion is None:
            return self.position.copy(), self.rotation.copy()
        p0, r0, p1, r1, start, seconds = motion
        t = 1.0 if seconds <= 0 else min(1.0, (time.monotonic() - start) / seconds)
        turn = rotation_vector(r1 @ r0.T)
        return p0 + (p1 - p0) * t, exp_rotation(turn * t) @ r0

    def arkit(self) -> tuple[np.ndarray, np.ndarray]:
        """The raw ARKit camera pose (position, rotation in ARKit's world) for where the phone is now."""
        position, rotation = self.pose()
        return self.origin + self.world @ position, self.world @ rotation @ CAMERA_TO_BODY

    async def _stream(self) -> None:
        period = 1.0 / self.rate
        while True:
            settled = self._motion is None or time.monotonic() - self._motion[4] >= self._motion[5]
            position, rotation = self.arkit()
            quaternion = matrix_to_quaternion(rotation)
            await self._send(
                {
                    "type": "pose",
                    "version": PROTOCOL_VERSION,
                    "sessionId": self.session,
                    "seq": self.seq,
                    "monotonicTs": time.monotonic(),
                    "position": dict(zip("xyz", map(float, position), strict=True)),
                    "rotation": dict(zip("xyzw", map(float, quaternion), strict=True)),
                    "covariance": _TRACKING_COVARIANCE.get(self.tracking_state, [0.25] * 3 + [1.0] * 3),
                    "source": self.source,
                    "trackingState": self.tracking_state,
                    "calibrationVersion": "arkit-v1",
                    "heartbeat": True,
                    "sentAt": self._now_ms(),
                }
            )
            self.seq += 1
            if settled:
                self._sent_motion += 1
            await asyncio.sleep(period)

    async def move_to(self, position: Any = None, rotation: Any = None, seconds: float = 0.0) -> None:
        """Move to ``position`` (operator frame, metres) and turn to ``rotation`` (a matrix, rotation vector or
        quaternion); either may be None to keep it. With ``seconds``, glide there like a hand at the pose rate.
        Returns once a pose at the destination has gone out."""
        start_position, start_rotation = self.pose()
        end_position = start_position if position is None else np.asarray(position, dtype=np.float64)
        end_rotation = start_rotation if rotation is None else _rotation(rotation)
        self.position, self.rotation = end_position.copy(), end_rotation.copy()
        self._motion = (start_position, start_rotation, end_position, end_rotation, time.monotonic(), max(0.0, seconds))
        if seconds > 0:
            await asyncio.sleep(seconds)
        await self._settle()

    async def move_by(self, delta: Any = (0.0, 0.0, 0.0), turn: Any = None, seconds: float = 0.0) -> None:
        """Move by ``delta`` (operator frame) and turn by ``turn`` (a rotation vector, in the operator frame)."""
        position, rotation = self.pose()
        await self.move_to(position + np.asarray(delta, dtype=np.float64), None if turn is None else exp_rotation(turn) @ rotation, seconds)

    async def _settle(self) -> None:
        """Wait until a pose at the destination has been sent (so an action sent next is measured there)."""
        if not self.connected:
            return
        self._sent_motion = 0
        await self.wait_for(lambda phone: phone._sent_motion >= 1, 2.0, "a pose at the destination")

    # -- controls ---------------------------------------------------------------------------------------------------

    def control(self, name: str) -> dict[str, Any] | None:
        """The control with this action (or id) in the phone's layout."""
        controls = (self.config or self.gateway_config or {}).get("controls") or []
        return next((c for c in controls if c.get("action") == name), None) or next((c for c in controls if c.get("id") == name), None)

    def value(self, name: str) -> Any:
        """The gateway's value for a control, from this phone's latest config."""
        control = self.control(name)
        return None if control is None else control.get("value")

    async def action(self, name: str, value: Any = None, *, renew: bool = False, live: bool = False) -> tuple[str, str]:
        """Send one action as the app would (no repeats). ``name`` is an action or control id; an action the layout
        doesn't declare is sent as is. Returns ``(control id, action)``."""
        control = self.control(name)
        control_id, action = (control["id"], control["action"]) if control else (name.rsplit(".", 1)[-1], name)
        message: dict[str, Any] = {"type": "action", "version": PROTOCOL_VERSION, "sessionId": self.session, "controlId": control_id, "action": action, "sentAt": self._now_ms()}
        if value is not None:
            message["value"] = value
        if renew:
            message["renew"] = True
        if live:
            message["live"] = True
        await self._send(message)
        return control_id, action

    async def press(self, name: str, value: Any = None) -> None:
        """Press a button. A hold button stays pressed, repeated every 200 ms, until :meth:`release`."""
        control = self.control(name)
        if control is not None and control.get("type") == "button" and control.get("hold"):
            control_id, action = await self.action(name, True)
            self._holds[action] = (control_id, time.monotonic())
        else:
            await self.action(name, value)

    async def release(self, name: str) -> None:
        """Release a hold button."""
        control = self.control(name)
        action = control["action"] if control else name
        self._holds.pop(action, None)
        await self.action(name, False)

    async def hold(self, name: str, seconds: float) -> None:
        """Hold a button for ``seconds``, then release it."""
        await self.press(name)
        await asyncio.sleep(seconds)
        await self.release(name)

    async def set(self, name: str, value: Any) -> None:
        """Set a toggle, select or slider (a slider's final value, no drag)."""
        await self.action(name, value)

    async def drag(self, name: str, values: Any, interval: float = 1 / 30, let_go: bool = True) -> None:
        """Drag a slider or stick through ``values`` (live samples, ``interval`` apart). With ``let_go``, lift the
        finger afterwards: a stick returns to rest and a slider keeps its last value. Otherwise the finger stays,
        repeated every 50 ms, until :meth:`let_go`."""
        last: Any = None
        for value in values:
            last = value
            await self._sample(name, value)
            await asyncio.sleep(interval)
        if let_go and last is not None:
            await self.let_go(name)

    async def stick(self, x: float, y: float, name: str = "base.drive") -> None:
        """Push a stick to ``(x forward, y left)`` and keep the finger there (repeated) until :meth:`let_go`."""
        await self._sample(name, {"x": x, "y": y})

    async def _sample(self, name: str, value: Any) -> None:
        control_id, action = await self.action(name, value, live=True)
        self._drags[action] = (control_id, value, time.monotonic())

    async def let_go(self, name: str | None = None, value: Any = None) -> None:
        """Lift the finger from a drag (or every drag): the final sample, a stick at rest or a slider's last value."""
        for action in [name] if name is not None else list(self._drags):
            control = self.control(action)
            key = control["action"] if control else action
            entry = self._drags.pop(key, None)
            final = value
            if final is None:
                final = dict(STICK_REST) if control is not None and control.get("type") == "joystick" else (entry[1] if entry else None)
            await self.action(key, final)

    def pause_renewals(self) -> None:
        """Stop the repeats of held buttons and drags while the finger stays down: the gateway then ends them
        ("renewals stopped" / "samples stopped") and counts a still-touched drag as dropped until it is let go."""
        self._paused = True

    def resume_renewals(self) -> None:
        self._paused = False

    @contextlib.contextmanager
    def renewals_paused(self) -> Iterator[None]:
        self.pause_renewals()
        try:
            yield
        finally:
            self.resume_renewals()

    async def _renew(self) -> None:
        while True:
            await asyncio.sleep(STREAM_RENEW_S / 2)
            if self._paused or self._ws is None:
                continue
            now = time.monotonic()
            for action, (control_id, at) in list(self._holds.items()):
                if now - at >= HOLD_RENEW_S:
                    self._holds[action] = (control_id, now)
                    await self._send({"type": "action", "version": PROTOCOL_VERSION, "sessionId": self.session, "controlId": control_id, "action": action, "value": True, "renew": True, "sentAt": self._now_ms()})
            for action, (control_id, value, at) in list(self._drags.items()):
                if now - at >= STREAM_RENEW_S:
                    self._drags[action] = (control_id, value, now)
                    await self._send({"type": "action", "version": PROTOCOL_VERSION, "sessionId": self.session, "controlId": control_id, "action": action, "value": value, "live": True, "renew": True, "sentAt": self._now_ms()})

    # -- calibration ------------------------------------------------------------------------------------------------

    @property
    def calibration(self) -> dict[str, Any]:
        """This phone's calibration as the gateway reports it."""
        return dict((self.config or {}).get("calibration") or {"status": "uncalibrated", "epoch": 0})

    async def _calibration_step(self, action: str, value: Any = None, timeout: float = 5.0) -> str:
        control = self.control(action)
        control_id = control["id"] if control else action.rsplit(".", 1)[-1]
        before = len(self.statuses)
        await self.action(action, value)

        def answered(phone: AsyncSimPhone) -> bool:
            return any(s.get("controlId") == control_id and s.get("phoneId") == phone.phone_id for s in phone.statuses[before:])

        await self.wait_for(answered, timeout, f"the gateway's answer to {action}")
        reply = next(s for s in self.statuses[before:] if s.get("controlId") == control_id and s.get("phoneId") == self.phone_id)
        values = reply.get("values") or {}
        if values.get("accepted") is not True:
            raise CalibrationRefused(reply.get("message", "refused"))
        return str(reply.get("message", ""))

    async def calibrate(self, distance: float = 0.1, lift: float = 0.12, seconds: float = 0.25) -> dict[str, Any]:
        """Guided calibration with real moves: flat here (screen up, top edge forward), then forward, right and up
        by ``distance``/``lift`` metres and back, capturing each. Returns the calibration; raises
        :class:`CalibrationRefused` with the gateway's reason if a step is refused."""
        here, _ = self.pose()
        await self.move_to(here, np.eye(3), seconds)
        await self._calibration_step("calibration.start")
        await self._calibration_step("calibration.capture", "flat")
        for step, offset in (("forward", (distance, 0, 0)), ("right", (0, -distance, 0)), ("up", (0, 0, lift))):
            await self.move_to(here + np.asarray(offset, dtype=np.float64), None, seconds)
            await self._calibration_step("calibration.capture", step)
            await self.move_to(here, None, seconds)
        await self.wait_for(lambda phone: phone.calibration.get("status") == "captured", 5.0, "the calibrated config")
        return self.calibration

    async def quick_origin(self) -> dict[str, Any]:
        """Quick origin here (forward is where the phone's top edge points)."""
        epoch = self.calibration.get("epoch", 0)
        await self._calibration_step("calibration.captureOrigin")
        await self.wait_for(lambda phone: phone.calibration.get("status") == "captured" and phone.calibration.get("epoch", 0) > epoch, 5.0, "the calibrated config")
        return self.calibration

    async def reset_calibration(self) -> None:
        await self._calibration_step("calibration.reset")

    # -- waiting ----------------------------------------------------------------------------------------------------

    async def wait_for(self, predicate: Callable[[AsyncSimPhone], Any], timeout: float = 5.0, what: str = "a condition") -> Any:
        """Wait until ``predicate(phone)`` is truthy; returns its value. Raises TimeoutError saying what it waited for."""
        deadline = time.monotonic() + timeout
        while True:
            result = predicate(self)
            if result:
                return result
            if time.monotonic() > deadline:
                raise TimeoutError(f"timed out after {timeout} s waiting for {what}")
            await asyncio.sleep(0.005)

    def last_status(self, control: str | None = None) -> dict[str, Any] | None:
        """The last status this phone got (for one control id, if given)."""
        return next((s for s in reversed(self.statuses) if control is None or s.get("controlId") == control), None)


class SimPhone:
    """:class:`AsyncSimPhone` with blocking methods, on its own thread: for synchronous tests and scripts.

        with Gateway() as gateway, SimPhone(gateway) as phone:
            phone.calibrate()
            phone.press("teleop.deadman")
            phone.move_by((0.1, 0, 0), seconds=0.5)
    """

    def __init__(self, gateway: Any, **options: Any) -> None:
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="marionette-simphone", daemon=True)
        self._thread.start()
        self.phone = AsyncSimPhone(gateway, **options)

    def _run(self, coroutine: Any, timeout: float | None = 30.0) -> Any:
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop).result(timeout)

    def __getattr__(self, name: str) -> Any:
        # Plain attributes and non-async helpers come straight from the async phone.
        return getattr(self.phone, name)

    def connect(self, timeout: float = 5.0) -> SimPhone:
        self._run(self.phone.connect(timeout))
        return self

    def disconnect(self) -> None:
        self._run(self.phone.disconnect())

    def reconnect(self, same_session: bool = True, timeout: float = 5.0) -> SimPhone:
        self._run(self.phone.reconnect(same_session, timeout))
        return self

    def close(self) -> None:
        if self._loop.is_closed():
            return
        with contextlib.suppress(Exception):
            self._run(self.phone.close(), 5.0)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(5.0)
        self._loop.close()

    def __enter__(self) -> SimPhone:
        return self.connect()

    def __exit__(self, *_: Any) -> None:
        self.close()

    def move_to(self, position: Any = None, rotation: Any = None, seconds: float = 0.0) -> None:
        self._run(self.phone.move_to(position, rotation, seconds))

    def move_by(self, delta: Any = (0.0, 0.0, 0.0), turn: Any = None, seconds: float = 0.0) -> None:
        self._run(self.phone.move_by(delta, turn, seconds))

    def action(self, name: str, value: Any = None, *, renew: bool = False, live: bool = False) -> tuple[str, str]:
        return self._run(self.phone.action(name, value, renew=renew, live=live))

    def press(self, name: str, value: Any = None) -> None:
        self._run(self.phone.press(name, value))

    def release(self, name: str) -> None:
        self._run(self.phone.release(name))

    def hold(self, name: str, seconds: float) -> None:
        self._run(self.phone.hold(name, seconds))

    def set(self, name: str, value: Any) -> None:
        self._run(self.phone.set(name, value))

    def drag(self, name: str, values: Any, interval: float = 1 / 30, let_go: bool = True) -> None:
        self._run(self.phone.drag(name, list(values), interval, let_go))

    def stick(self, x: float, y: float, name: str = "base.drive") -> None:
        self._run(self.phone.stick(x, y, name))

    def let_go(self, name: str | None = None, value: Any = None) -> None:
        self._run(self.phone.let_go(name, value))

    def calibrate(self, distance: float = 0.1, lift: float = 0.12, seconds: float = 0.25) -> dict[str, Any]:
        return self._run(self.phone.calibrate(distance, lift, seconds))

    def quick_origin(self) -> dict[str, Any]:
        return self._run(self.phone.quick_origin())

    def reset_calibration(self) -> None:
        self._run(self.phone.reset_calibration())

    def wait_for(self, predicate: Callable[[AsyncSimPhone], Any], timeout: float = 5.0, what: str = "a condition") -> Any:
        return self._run(self.phone.wait_for(predicate, timeout, what), timeout + 5.0)

