"""Teleop math and safety checks, as parts a robot's own control loop picks up.

Marionette decides nothing about motion: the robot does. These are the pieces every robot ends up writing, written
once and tested (numpy only):

- :func:`gate` says why a phone can't drive right now (offline, calibrating, no fresh pose, too slow a link,
  simulated motion, degraded tracking), in plain words a phone screen can show.
- :class:`Clutch` is relative teleop: press to anchor, then the target moves by the phone's motion since the anchor,
  scaled and turned into the robot's frame::

      p = E0.p + s · F · (P.p − P0.p)
      R = exp(r · s · F · θ) · E0.R,     θ = the phone's turn since P0 (a rotation vector, unwrapped)

  ``s`` is the motion scale (it scales turns as well as moves), ``r`` the rotation scale, and ``F`` the frame the
  phone's operator axes (+X forward, +Y left, +Z up) map into: the identity when the operator calibrated facing
  the robot's forward, or :func:`camera_frame` to move in a camera's view. A turn is followed continuously past half
  a turn (:func:`unwrap_turn`), so a scaled turn never flips; :meth:`Clutch.rescale` and :meth:`Clutch.reframe`
  take up a new scale or frame without moving the target.
- :class:`JumpDetector` catches ARKit correcting itself in a step while still reporting normal tracking.
- :class:`PressTracker` turns press counts into "pressed since I last looked", each press consumed once.
- :func:`follow` is a speed and acceleration limiter that lands on its target without overshoot.
- :func:`owners` (opt-in) decides which phone has each robot resource (an arm, the base).
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Mapping
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    from .phones import Phone, Pose

ArrayLike = Any

# ---------------------------------------------------------------------------------------------------------------
# Rotations
# ---------------------------------------------------------------------------------------------------------------


def quaternion_to_matrix(q: ArrayLike) -> np.ndarray:
    """The rotation matrix of a quaternion ``(x, y, z, w)`` (a sequence, an array or a ``{x, y, z, w}`` dict).
    The quaternion is normalized first; a zero quaternion is the identity."""
    if isinstance(q, Mapping):
        q = (q["x"], q["y"], q["z"], q["w"])
    x, y, z, w = (float(v) for v in q)
    norm = math.sqrt(x * x + y * y + z * z + w * w)
    if not math.isfinite(norm) or norm < 1e-12:
        return np.eye(3)
    x, y, z, w = x / norm, y / norm, z / norm, w / norm
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def matrix_to_quaternion(rotation: ArrayLike) -> np.ndarray:
    """The unit quaternion ``(x, y, z, w)`` of a rotation matrix, with ``w >= 0``."""
    m = np.asarray(rotation, dtype=np.float64)
    trace = m[0, 0] + m[1, 1] + m[2, 2]
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    out = np.array(q)
    out /= np.linalg.norm(out)
    return -out if out[3] < 0 else out


def rotation_vector(rotation: ArrayLike) -> np.ndarray:
    """The rotation vector (axis × angle, angle in [0, π]) of a rotation matrix. Exact near zero and near π."""
    x, y, z, w = matrix_to_quaternion(rotation)
    v = np.array([x, y, z])
    s = float(np.linalg.norm(v))
    if s < 1e-12:
        return 2.0 * v
    return (2.0 * math.atan2(s, w) / s) * v


def exp_rotation(vector: ArrayLike) -> np.ndarray:
    """The rotation matrix of a rotation vector (Rodrigues)."""
    v = np.asarray(vector, dtype=np.float64).reshape(3)
    angle = float(np.linalg.norm(v))
    if angle < 1e-12:
        return np.eye(3) + _skew(v)
    k = _skew(v / angle)
    return np.eye(3) + math.sin(angle) * k + (1 - math.cos(angle)) * (k @ k)


def _skew(v: np.ndarray) -> np.ndarray:
    return np.array([[0.0, -v[2], v[1]], [v[2], 0.0, -v[0]], [-v[1], v[0], 0.0]])


def unwrap_turn(turn: ArrayLike, previous: ArrayLike) -> np.ndarray:
    """The rotation vector for ``turn``'s rotation that is closest to ``previous``.

    A rotation vector is unique only up to whole turns about its axis, and past half a turn its axis flips. Scaled,
    that flip would jump the target by a large angle; picking the representation nearest the last one follows a
    turn of any size smoothly, as long as it turns less than half a turn between two calls.
    """
    turn = np.asarray(turn, dtype=np.float64)
    previous = np.asarray(previous, dtype=np.float64)
    angle = float(np.linalg.norm(turn))
    if angle > 1e-9:
        axis = turn / angle
    else:
        size = float(np.linalg.norm(previous))
        if size < 1e-9:
            return turn.copy()
        axis, angle = previous / size, 0.0
    whole = round((float(np.dot(previous, axis)) - angle) / (2.0 * math.pi))
    return (angle + 2.0 * math.pi * whole) * axis


# The phone's operator axes (+X forward, +Y left, +Z up) in a camera's ROS optical frame (+Z along the view, +X to
# the image's right, +Y down it): forward is along the view, left and up are the image's left and up.
_PHONE_IN_OPTICAL = np.array([[0.0, -1.0, 0.0], [0.0, 0.0, -1.0], [1.0, 0.0, 0.0]])


def camera_frame(optical_rotation: ArrayLike) -> np.ndarray:
    """``F`` for moving in a camera's view, from the rotation of the camera's ROS optical frame in the robot's frame.

    With it, pushing the phone forward moves the target along the camera's view, and left and up are the image's,
    so an operator watching that camera moves what they see the way they move the phone.
    """
    return np.asarray(optical_rotation, dtype=np.float64) @ _PHONE_IN_OPTICAL


# ---------------------------------------------------------------------------------------------------------------
# Gates
# ---------------------------------------------------------------------------------------------------------------


def gate(
    phone: Phone,
    now: float,
    *,
    pose_timeout: float = 0.25,
    max_latency_ms: float | None = None,
    allow_synthetic: bool = False,
    require_calibration: bool = False,
) -> str | None:
    """Why this phone's pose can't drive anything right now, or None when it can.

    ``now`` is the tracker's clock (``time.monotonic()`` by default). The pose must be younger than
    ``pose_timeout`` seconds, counted from when the phone sent it when the latency stamps allow. ``max_latency_ms``
    refuses a pose that took longer than that to arrive (unknown latency passes: older apps don't stamp).
    ``require_calibration`` refuses an uncalibrated phone, whose forward is wherever ARKit started. Simulated motion
    is refused unless ``allow_synthetic`` (a simulator), which also lets it through with limited tracking.
    """
    if not phone.connected:
        return "This phone is offline."
    if phone.calibration == "capturing":
        return "Finish or cancel calibration first."
    if require_calibration and phone.calibration != "captured":
        return "Calibrate this phone first, facing the way the robot faces."
    pose = phone.pose
    if pose is None or pose.age(now) > pose_timeout:
        return "No pose from this phone. Keep the app open."
    delay = pose.delay_ms if pose.delay_ms is not None else pose.latency_ms
    if max_latency_ms is not None and delay is not None and delay > max_latency_ms:
        return f"The link is too slow ({delay:.0f} ms). Move closer to the Wi-Fi."
    synthetic = pose.source == "synthetic"
    if synthetic and not allow_synthetic:
        return "Simulated motion can't move the robot."
    if pose.source not in ("arkit", "synthetic"):
        return "This phone has no ARKit tracking."
    if pose.tracking == "initializing":
        return "Tracking is starting. Move the phone gently."
    if pose.tracking == "relocalizing":
        return "Tracking is finding its place. Hold still for a moment."
    if pose.tracking != "normal" and not synthetic:
        return "Tracking is limited. Point the camera at something with texture."
    return None


# ---------------------------------------------------------------------------------------------------------------
# Clutch
# ---------------------------------------------------------------------------------------------------------------


class Clutch:
    """Relative teleop for one target (an arm's tip, a camera, a virtual gripper).

    :meth:`engage` records the phone pose ``P0`` and the target ``E0`` and moves nothing. :meth:`target` then gives
    ``E0`` moved by the phone's motion since ``P0`` (see the module docstring). It is not thread-safe: use it from
    the control loop that owns the target. Call :meth:`target` every tick while engaged, so a long turn is followed
    continuously.
    """

    def __init__(self) -> None:
        self.engaged = False
        self._pose: Pose | None = None
        self._origin: tuple[np.ndarray, np.ndarray] | None = None
        self._turn = np.zeros(3)
        self.scale = 1.0
        self.rotation_scale = 1.0
        self.frame = np.eye(3)

    @property
    def anchor(self) -> Pose | None:
        """The phone pose the clutch is anchored to (``P0``), or None."""
        return self._pose

    @property
    def origin(self) -> tuple[np.ndarray, np.ndarray] | None:
        """The target the clutch is anchored to (``E0``: position, rotation), or None."""
        return None if self._origin is None else (self._origin[0].copy(), self._origin[1].copy())

    @property
    def turn(self) -> np.ndarray:
        """The phone's turn since the anchor, unwrapped (the last one :meth:`target` saw)."""
        return self._turn.copy()

    def engage(
        self,
        pose: Pose,
        robot_position: ArrayLike,
        robot_rotation: ArrayLike | None = None,
        *,
        scale: float = 1.0,
        rotation_scale: float = 1.0,
        frame: ArrayLike | None = None,
    ) -> None:
        """Anchor ``pose`` to the target's current position and rotation (identity when None)."""
        self._pose = pose
        self._origin = (
            np.asarray(robot_position, dtype=np.float64).reshape(3).copy(),
            np.eye(3) if robot_rotation is None else np.asarray(robot_rotation, dtype=np.float64).reshape(3, 3).copy(),
        )
        self._turn = np.zeros(3)
        self.scale = float(scale)
        self.rotation_scale = float(rotation_scale)
        self.frame = np.eye(3) if frame is None else np.asarray(frame, dtype=np.float64).reshape(3, 3).copy()
        self.engaged = True

    def release(self) -> None:
        """Stop following; the next :meth:`engage` anchors afresh."""
        self.engaged = False
        self._pose = None
        self._origin = None
        self._turn = np.zeros(3)

    def anchor_valid(self, pose: Pose | None) -> bool:
        """Whether ``pose`` is in the same ARKit world and calibration as the anchor. When it isn't (the phone
        restarted tracking, or was calibrated again), positions no longer compare: release and re-engage."""
        anchor = self._pose
        return (
            self.engaged
            and anchor is not None
            and pose is not None
            and pose.session == anchor.session
            and pose.calibration == anchor.calibration
        )

    def target(self, pose: Pose) -> tuple[np.ndarray, np.ndarray]:
        """The target (position, rotation) for ``pose``. Follows the turn on from the last call."""
        if self._pose is None or self._origin is None:
            raise RuntimeError("Clutch.target() before engage()")
        anchor = self._pose
        self._turn = unwrap_turn(rotation_vector(pose.rotation @ anchor.rotation.T), self._turn)
        return self._map(pose.position - anchor.position, self._turn)

    def _map(self, moved: np.ndarray, turn: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        assert self._origin is not None
        position = self._origin[0] + self.scale * (self.frame @ moved)
        rotation = exp_rotation(self.rotation_scale * self.scale * (self.frame @ turn)) @ self._origin[1]
        return position, rotation

    def rescale(self, pose: Pose, scale: float, rotation_scale: float | None = None) -> None:
        """Take up a new motion scale (and rotation scale) from here on, without moving the target."""
        self._reanchor(pose)
        self.scale = float(scale)
        if rotation_scale is not None:
            self.rotation_scale = float(rotation_scale)

    def reframe(self, pose: Pose, frame: ArrayLike | None) -> None:
        """Take up a new frame ``F`` (None: identity) from here on, without moving the target."""
        self._reanchor(pose)
        self.frame = np.eye(3) if frame is None else np.asarray(frame, dtype=np.float64).reshape(3, 3).copy()

    def _reanchor(self, pose: Pose) -> None:
        here = self.target(pose)
        self._pose = pose
        self._origin = (here[0], here[1])
        self._turn = np.zeros(3)


# ---------------------------------------------------------------------------------------------------------------
# Jumps, presses, rate limits, owners
# ---------------------------------------------------------------------------------------------------------------


class JumpDetector:
    """Notices ARKit correcting itself in a step.

    Now and then ARKit snaps its estimate while still reporting normal tracking. A step longer than ``distance``
    metres covered faster than ``speed`` m/s, or a turn larger than ``angle`` radians faster than ``turn_speed``
    rad/s, is not a hand: :meth:`check` says so, and the robot should stop rather than follow it. Speeds use the
    phone's own clock (``Pose.stamp``), so network jitter doesn't look like a jump.
    """

    def __init__(self, distance: float = 0.04, angle: float = 0.5, speed: float = 4.0, turn_speed: float = 20.0) -> None:
        self.distance = distance
        self.angle = angle
        self.speed = speed
        self.turn_speed = turn_speed
        self._last: Pose | None = None

    def reset(self, pose: Pose | None = None) -> None:
        """Start comparing from ``pose`` (call it when engaging)."""
        self._last = pose

    def check(self, pose: Pose | None) -> bool:
        """Whether ``pose`` jumped from the last pose checked. A pose already seen, or a new session, isn't a jump."""
        last = self._last
        if pose is None:
            return False
        if last is None or pose.session != last.session:
            self._last = pose
            return False
        if pose.seq == last.seq and pose.stamp == last.stamp:
            return False
        self._last = pose
        dt = max(pose.stamp - last.stamp, 1e-3)
        moved = float(np.linalg.norm(pose.position - last.position))
        turned = float(np.linalg.norm(rotation_vector(pose.rotation @ last.rotation.T)))
        return (moved > self.distance and moved / dt > self.speed) or (turned > self.angle and turned / dt > self.turn_speed)


class PressTracker:
    """Press edges of one action, consumed once per phone.

    ``pressed(phone)`` says how many times the phone pressed ``action`` since the last call for that phone. Every
    press is consumed whatever the robot does with it, so a press refused (Stop on, bad tracking) never acts later
    on its own. The first sight of a phone counts nothing: a button already held when the robot started isn't a press.
    """

    def __init__(self, action: str) -> None:
        self.action = action
        self._seen: dict[str, int] = {}

    def pressed(self, phone: Phone) -> int:
        """New presses since the last look (0 for none, and on first sight)."""
        count = phone.presses(self.action)
        seen = self._seen.get(phone.id)
        self._seen[phone.id] = count
        return 0 if seen is None else max(0, count - seen)

    def forget(self, phone: Phone) -> None:
        """Mark the phone's presses as seen without acting on them."""
        self._seen[phone.id] = phone.presses(self.action)

    def reset(self, phone_id: str | None = None) -> None:
        """Forget a phone (or every phone): its next look counts as first sight."""
        if phone_id is None:
            self._seen.clear()
        else:
            self._seen.pop(phone_id, None)


def follow(error: ArrayLike, velocity: ArrayLike, top: float, accel: float, dt: float) -> np.ndarray:
    """The next velocity toward a target ``error`` away.

    It speeds up and slows down at ``accel`` at most, never goes faster than ``top``, and slows in time to stop at the
    target instead of overshooting; within one tick of it, it lands there. Integrate it yourself
    (``position += velocity * dt``). Works in any number of dimensions (a position, a rotation vector).
    """
    error = np.asarray(error, dtype=np.float64)
    velocity = np.asarray(velocity, dtype=np.float64)
    distance = float(np.linalg.norm(error))
    if distance < 1e-9:
        return np.zeros_like(error)
    direction = error / distance
    speed = min(top, math.sqrt(2.0 * accel * distance), distance / dt)
    change = direction * speed - velocity
    size = float(np.linalg.norm(change))
    step = accel * dt
    if size > step:
        change = change * (step / size)
    new = velocity + change
    if float(np.dot(new, direction)) * dt > distance:
        new = direction * (distance / dt)
    return new


def owners(
    phones: Iterable[Phone],
    resources: Iterable[str],
    select: str | Callable[[Phone], str | None],
    current: Mapping[str, str | None] | None = None,
) -> dict[str, Phone | None]:
    """Which connected phone has each resource (an arm, the base, a camera).

    ``select`` is the action whose value names the resource a phone wants (``"arm.select"``), or a function of the
    phone. ``current`` maps each resource to the phone id that has it now (the one that engaged it last), which keeps
    it while it still selects it. Otherwise the lowest-numbered phone selecting it has it. Taking a resource over
    from a phone that is still moving it is a policy for the robot to decide (on a fresh press, say).
    """
    pick = (lambda phone: phone.value(select)) if isinstance(select, str) else select
    connected = [phone for phone in phones if phone.connected]
    current = current or {}
    result: dict[str, Phone | None] = {}
    for resource in resources:
        candidates = [phone for phone in connected if pick(phone) == resource]
        keep = next((phone for phone in candidates if phone.id == current.get(resource)), None)
        if keep is None and candidates:
            keep = min(candidates, key=lambda phone: phone.index)
        result[resource] = keep
    return result
