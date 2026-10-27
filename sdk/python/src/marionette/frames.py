"""The gateway's pose conversions, ported from ``packages/protocol`` (``applyPhoneFrame``, ``applyPoseReference``,
``buildQuickReference``, ``buildGuidedReference``).

A phone sends raw ARKit camera poses; the gateway publishes them in the operator frame (REP-103: +X forward, +Y left,
+Z up). Robots never need this: they get published poses. It is here for :class:`~marionette.testing.SimPhone`,
which has to make raw ARKit poses from operator-frame targets, and for checking a raw log against what the gateway
published. Rotations are 3×3 matrices; quaternions are ``(x, y, z, w)``.

- ARKit's camera frame: +X toward the bottom of a portrait iPhone, +Y toward its right edge, +Z out of the screen.
- The phone's body frame: +X its top edge, +Y its left edge, +Z out of the screen (the camera turned 180° about Z).
- ARKit's world: +Y up (gravity), −Z its initial heading. Uncalibrated poses are that world in operator axes.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .teleop import ArrayLike

# The phone body in the camera frame: 180° about Z (its own inverse).
CAMERA_TO_BODY = np.diag([-1.0, -1.0, 1.0])
# ARKit world (x, y, z) → operator (−z, −x, y).
ARKIT_TO_OPERATOR = np.array([[0.0, 0.0, -1.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
UP = np.array([0.0, 1.0, 0.0])
MIN_STEP_M = 0.03
FLAT_TOLERANCE_DEG = 30.0


@dataclass(frozen=True)
class Reference:
    """A calibration: the raw ARKit sample it was taken at, and ``frame``, the operator axes in ARKit world."""

    position: np.ndarray
    rotation: np.ndarray
    frame: np.ndarray
    mode: str = "guided"
    epoch: int = 1

    @property
    def version(self) -> str:
        """The ``calibrationVersion`` poses carry under this calibration."""
        return f"{self.mode}-v2:{self.epoch}"


def apply_phone_frame(position: ArrayLike, rotation: ArrayLike) -> tuple[np.ndarray, np.ndarray]:
    """Uncalibrated: a raw ARKit camera pose re-expressed in operator axes (the phone's body, gravity-aligned)."""
    p = np.asarray(position, dtype=np.float64)
    r = np.asarray(rotation, dtype=np.float64)
    return ARKIT_TO_OPERATOR @ p, ARKIT_TO_OPERATOR @ r @ CAMERA_TO_BODY


def unapply_phone_frame(position: ArrayLike, rotation: ArrayLike) -> tuple[np.ndarray, np.ndarray]:
    """The raw ARKit camera pose that :func:`apply_phone_frame` turns into this uncalibrated pose."""
    p = np.asarray(position, dtype=np.float64)
    r = np.asarray(rotation, dtype=np.float64)
    return ARKIT_TO_OPERATOR.T @ p, ARKIT_TO_OPERATOR.T @ r @ CAMERA_TO_BODY


def apply_reference(position: ArrayLike, rotation: ArrayLike, reference: Reference) -> tuple[np.ndarray, np.ndarray]:
    """Calibrated: displacement since the reference sample in the calibrated frame, and the rotation since it, also
    in the calibrated frame (the reference reads as identity)."""
    to_operator = reference.frame.T
    since = np.asarray(rotation, dtype=np.float64) @ reference.rotation.T
    return to_operator @ (np.asarray(position, dtype=np.float64) - reference.position), to_operator @ since @ reference.frame


def _horizontal(v: np.ndarray) -> np.ndarray:
    return v - UP * float(np.dot(v, UP))


def _unit(v: np.ndarray) -> np.ndarray | None:
    n = float(np.linalg.norm(v))
    return v / n if n > 1e-6 else None


def operator_frame(forward: ArrayLike) -> np.ndarray:
    """The operator axes (columns: forward, left, up) in ARKit world, from a horizontal forward and gravity."""
    f = np.asarray(forward, dtype=np.float64)
    return np.column_stack([f, np.cross(UP, f), UP])


def quick_reference(position: ArrayLike, rotation: ArrayLike, epoch: int = 1) -> Reference:
    """Quick origin: zero here, up from gravity, forward from the phone's top edge (its back camera when upright)."""
    r = np.asarray(rotation, dtype=np.float64)
    top = _horizontal(r @ np.array([-1.0, 0.0, 0.0]))
    back = _horizontal(r @ np.array([0.0, 0.0, -1.0]))
    forward = _unit(top if np.linalg.norm(top) >= 0.5 else back)
    if forward is None:
        forward = np.array([0.0, 0.0, -1.0])
    return Reference(np.asarray(position, dtype=np.float64), r, operator_frame(forward), "quick", epoch)


def guided_reference(flat: ArrayLike, forward: ArrayLike, right: ArrayLike, flat_rotation: ArrayLike, epoch: int = 1) -> Reference | None:
    """The guided frame from the four captures' positions (flat, forward, right; up only checks the lift)."""
    p0 = np.asarray(flat, dtype=np.float64)
    f = _unit(_horizontal(np.asarray(forward, dtype=np.float64) - p0))
    r = _unit(_horizontal(np.asarray(right, dtype=np.float64) - p0))
    if f is None or r is None:
        return None
    heading = _unit(f + np.cross(UP, r))
    if heading is None:
        return None
    return Reference(p0, np.asarray(flat_rotation, dtype=np.float64), operator_frame(heading), "guided", epoch)


def operator_pose(position: ArrayLike, rotation: ArrayLike, reference: Reference | None = None) -> tuple[np.ndarray, np.ndarray]:
    """What the gateway publishes for a raw ARKit pose: calibrated with ``reference``, else uncalibrated."""
    return apply_reference(position, rotation, reference) if reference is not None else apply_phone_frame(position, rotation)
