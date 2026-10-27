"""Small builders shared by the unit tests."""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from marionette.phones import Phone, Pose
from marionette.teleop import exp_rotation, matrix_to_quaternion


def pose(
    position: Any = (0.0, 0.0, 0.0),
    rotvec: Any = (0.0, 0.0, 0.0),
    *,
    tracking: str = "normal",
    source: str = "arkit",
    calibration: str = "guided-v2:1",
    session: str = "s1",
    received: float | None = None,
    stamp: float = 0.0,
    seq: int = 0,
    latency_ms: float | None = None,
    hop_ms: float | None = None,
) -> Pose:
    rotation = exp_rotation(np.asarray(rotvec, float))
    return Pose(
        position=np.asarray(position, float),
        rotation=rotation,
        quaternion=matrix_to_quaternion(rotation),
        tracking=tracking,
        source=source,
        heartbeat=True,
        calibration=calibration,
        session=session,
        seq=seq,
        received=time.monotonic() if received is None else received,
        stamp=stamp,
        latency_ms=latency_ms,
        hop_ms=hop_ms,
    )


def phone(pid: str = "phone-1", arm: str | None = "left", **pose_fields: Any) -> Phone:
    record = Phone(pid, pid.replace("phone-", "Phone "), connected=True, calibration="captured", epoch=1)
    if arm is not None:
        record.values["arm.select"] = arm
    record.pose = pose(**pose_fields)
    return record


def yaw(rotation: np.ndarray) -> float:
    return float(np.degrees(np.arctan2(rotation[1, 0], rotation[0, 0])))
