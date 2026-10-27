"""Teleop math: rotations, the clutch (with property-style checks), gates, jumps, presses, follow, owners."""

from __future__ import annotations

import math

import numpy as np
import pytest

from helpers import phone, pose, yaw
from marionette.teleop import (
    Clutch,
    JumpDetector,
    PressTracker,
    camera_frame,
    exp_rotation,
    follow,
    gate,
    matrix_to_quaternion,
    owners,
    quaternion_to_matrix,
    rotation_vector,
    unwrap_turn,
)

RNG = np.random.default_rng(20261027)
# A camera looking along the robot's left (+y), upright: the image's right is forward, its down is down.
LOOKING_LEFT = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])


def random_rotation() -> np.ndarray:
    axis = RNG.normal(size=3)
    return exp_rotation(axis / np.linalg.norm(axis) * RNG.uniform(0, math.pi))


def angle_between(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(rotation_vector(a @ b.T)))


# -- rotations --------------------------------------------------------------------------------------------------


def test_rotation_vectors_round_trip_everywhere_including_near_half_a_turn() -> None:
    for _ in range(300):
        axis = RNG.normal(size=3)
        axis /= np.linalg.norm(axis)
        for angle in (RNG.uniform(0, math.pi - 1e-3), 1e-9, math.pi - 1e-7):
            vector = axis * angle
            np.testing.assert_allclose(rotation_vector(exp_rotation(vector)), vector, atol=1e-6)
    # Exactly half a turn: either axis sign is the same rotation.
    half = rotation_vector(exp_rotation([0, 0, math.pi]))
    np.testing.assert_allclose(np.abs(half), [0, 0, math.pi], atol=1e-9)


def test_quaternions_and_matrices_round_trip() -> None:
    for _ in range(200):
        rotation = random_rotation()
        q = matrix_to_quaternion(rotation)
        assert q[3] >= 0 and abs(np.linalg.norm(q) - 1) < 1e-12
        np.testing.assert_allclose(quaternion_to_matrix(q), rotation, atol=1e-12)
        np.testing.assert_allclose(quaternion_to_matrix(-q), rotation, atol=1e-12)
    np.testing.assert_allclose(quaternion_to_matrix({"x": 0, "y": 0, "z": 0, "w": 2}), np.eye(3))
    np.testing.assert_allclose(quaternion_to_matrix((0, 0, 0, 0)), np.eye(3))


def test_a_turn_past_half_a_turn_stays_continuous() -> None:
    z = np.array([0.0, 0.0, 1.0])
    np.testing.assert_allclose(unwrap_turn(0.3 * z, np.zeros(3)), 0.3 * z)
    flipped = rotation_vector(exp_rotation(1.01 * math.pi * z))
    np.testing.assert_allclose(flipped, -0.99 * math.pi * z, atol=1e-9)
    np.testing.assert_allclose(unwrap_turn(flipped, 0.99 * math.pi * z), 1.01 * math.pi * z, atol=1e-9)
    np.testing.assert_allclose(unwrap_turn(np.zeros(3), 1.98 * math.pi * z), 2 * math.pi * z, atol=1e-9)
    assert np.all(unwrap_turn(np.zeros(3), np.zeros(3)) == 0)


def test_camera_frames_map_forward_to_the_view_and_left_and_up_to_the_image() -> None:
    for _ in range(200):
        optical = random_rotation()
        frame = camera_frame(optical)
        np.testing.assert_allclose(frame @ [1, 0, 0], optical @ [0, 0, 1], atol=1e-12)  # forward: along the view
        np.testing.assert_allclose(frame @ [0, 1, 0], optical @ [-1, 0, 0], atol=1e-12)  # left: the image's left
        np.testing.assert_allclose(frame @ [0, 0, 1], optical @ [0, -1, 0], atol=1e-12)  # up: the image's up
        assert abs(np.linalg.det(frame) - 1) < 1e-9
    np.testing.assert_allclose(camera_frame(LOOKING_LEFT), [[0, -1, 0], [1, 0, 0], [0, 0, 1]], atol=1e-12)


# -- the clutch -------------------------------------------------------------------------------------------------


def test_engaging_holds_the_target_where_it_is() -> None:
    clutch = Clutch()
    tip = (np.array([0.3, 0.2, 0.1]), random_rotation())
    anchor = pose([1.0, 1.0, 1.0], [0.1, 0.2, 0.3])
    clutch.engage(anchor, *tip, scale=2.0, rotation_scale=0.5, frame=random_rotation())
    p, r = clutch.target(anchor)
    np.testing.assert_allclose(p, tip[0], atol=1e-12)
    np.testing.assert_allclose(r, tip[1], atol=1e-12)


def test_moves_scale_and_turns_follow_the_same_world_axis() -> None:
    clutch = Clutch()
    tip = (np.array([0.3, 0.2, 0.1]), exp_rotation([0.0, 1.0, 0.0]))
    clutch.engage(pose([1.0, 2.0, 3.0], [0.0, 0.0, 0.5]), *tip, scale=2.0)
    p, r = clutch.target(pose([1.1, 1.95, 3.02], [0.0, 0.0, 0.5]))
    np.testing.assert_allclose(p, [0.5, 0.1, 0.14], atol=1e-12)
    np.testing.assert_allclose(r, tip[1], atol=1e-12)
    clutch.engage(pose(rotvec=[0, 0, 0.5]), np.zeros(3), np.eye(3), scale=0.5)
    p, r = clutch.target(pose([0.1, 0, 0], [0, 0, 0.9]))
    np.testing.assert_allclose(p, [0.05, 0, 0], atol=1e-12)
    np.testing.assert_allclose(rotation_vector(r), [0, 0, 0.2], atol=1e-9)  # the motion scale scales turns too
    clutch.engage(pose(rotvec=[0, 0, 0.5]), np.zeros(3), np.eye(3), scale=2.0, rotation_scale=0.5)
    _, r = clutch.target(pose(rotvec=[0, 0, 0.9]))
    np.testing.assert_allclose(rotation_vector(r), [0, 0, 0.4], atol=1e-9)


def test_in_a_camera_frame_forward_is_along_its_view() -> None:
    clutch = Clutch()
    tip = np.array([0.3, 0.2, 0.1])
    clutch.engage(pose(), tip, frame=camera_frame(LOOKING_LEFT))
    np.testing.assert_allclose(clutch.target(pose([0.1, 0, 0]))[0], [0.3, 0.3, 0.1], atol=1e-12)
    np.testing.assert_allclose(clutch.target(pose([0, 0.1, 0.05]))[0], [0.2, 0.2, 0.15], atol=1e-12)
    clutch.engage(pose(), tip, frame=camera_frame(LOOKING_LEFT))
    _, r = clutch.target(pose(rotvec=[0.2, 0, 0]))  # a roll about the phone's forward rolls about the view
    np.testing.assert_allclose(rotation_vector(r), [0, 0.2, 0], atol=1e-9)


@pytest.mark.parametrize("scale, rotation_scale", [(0.25, 1.0), (0.5, 1.0), (1.0, 1.0), (1.5, 1.0), (2.0, 0.5), (3.0, 0.3)])
def test_scaled_turns_from_0_to_720_degrees_stay_continuous(scale: float, rotation_scale: float) -> None:
    """Property: whatever the axis, frame, scale and starting rotations, every 4° of phone turn moves the target by
    exactly r·s·4°, all the way to two whole turns, and the target ends where the formula says."""
    step = 4.0
    for _ in range(12):
        axis = RNG.normal(size=3)
        axis /= np.linalg.norm(axis)
        start, frame, tip = random_rotation(), random_rotation(), random_rotation()
        clutch = Clutch()
        clutch.engage(pose(rotvec=rotation_vector(start)), np.zeros(3), tip, scale=scale, rotation_scale=rotation_scale, frame=frame)
        previous = tip
        for degrees in np.arange(step, 720 + step / 2, step):
            phone_rotation = exp_rotation(axis * math.radians(degrees)) @ start
            _, rotation = clutch.target(pose(rotvec=rotation_vector(phone_rotation)))
            assert angle_between(rotation, previous) == pytest.approx(math.radians(scale * rotation_scale * step), abs=1e-7)
            previous = rotation
        expected = exp_rotation(rotation_scale * scale * (frame @ axis) * math.radians(720)) @ tip
        np.testing.assert_allclose(previous, expected, atol=1e-7)
        np.testing.assert_allclose(clutch.turn, axis * math.radians(720), atol=1e-7)


def test_a_half_scale_turn_past_half_a_turn_never_jumps() -> None:
    clutch = Clutch()
    clutch.engage(pose(), np.zeros(3), np.eye(3), scale=0.5)
    yaws = [yaw(clutch.target(pose(rotvec=[0, 0, math.radians(d)]))[1]) for d in range(0, 300, 5)]
    np.testing.assert_allclose(np.diff(yaws), 2.5, atol=1e-6)
    assert yaws[-1] == pytest.approx(147.5)


def test_rescale_and_reframe_never_move_the_target() -> None:
    """Property: at any point of a motion, a new scale or frame leaves the target where it is, and motion from then
    on uses the new scale and frame."""
    for _ in range(100):
        clutch = Clutch()
        start = pose(RNG.normal(size=3) * 0.1, RNG.normal(size=3) * 0.5)
        clutch.engage(start, RNG.normal(size=3), random_rotation(), scale=RNG.uniform(0.2, 3), rotation_scale=RNG.uniform(0.2, 1.5), frame=random_rotation())
        here = pose(start.position + RNG.normal(size=3) * 0.1, rotation_vector(exp_rotation(RNG.normal(size=3) * 0.8) @ start.rotation))
        before = clutch.target(here)
        if RNG.uniform() < 0.5:
            scale = RNG.uniform(0.2, 3)
            clutch.rescale(here, scale, RNG.uniform(0.2, 1.5))
        else:
            clutch.reframe(here, random_rotation())
        after = clutch.target(here)
        np.testing.assert_allclose(after[0], before[0], atol=1e-12)
        np.testing.assert_allclose(after[1], before[1], atol=1e-9)
        step = RNG.normal(size=3) * 0.05
        moved = clutch.target(pose(here.position + step, rotation_vector(here.rotation)))
        np.testing.assert_allclose(moved[0] - after[0], clutch.scale * (clutch.frame @ step), atol=1e-12)


def test_the_axol_reframe_case() -> None:
    clutch = Clutch()
    clutch.engage(pose(), np.array([0.3, 0.2, 0.1]), np.eye(3))
    here = pose([0.05, 0.02, 0.0], [0.0, 0.0, 0.3])
    before = clutch.target(here)
    clutch.rescale(here, 0.5)
    clutch.reframe(here, camera_frame(LOOKING_LEFT))
    np.testing.assert_allclose(clutch.target(here)[0], before[0], atol=1e-12)
    np.testing.assert_allclose(clutch.target(pose([0.15, 0.02, 0.0], [0.0, 0.0, 0.3]))[0] - before[0], [0.0, 0.05, 0.0], atol=1e-12)


def test_the_anchor_is_valid_only_in_the_same_session_and_calibration() -> None:
    clutch = Clutch()
    assert not clutch.anchor_valid(pose())
    clutch.engage(pose(), np.zeros(3))
    assert clutch.anchor_valid(pose([0.1, 0, 0]))
    assert not clutch.anchor_valid(pose(calibration="guided-v2:2"))
    assert not clutch.anchor_valid(pose(session="s2"))
    assert not clutch.anchor_valid(None)
    clutch.release()
    assert not clutch.engaged and not clutch.anchor_valid(pose())
    with pytest.raises(RuntimeError):
        clutch.target(pose())


# -- gates ------------------------------------------------------------------------------------------------------


def test_good_tracking_passes_and_every_failure_says_why() -> None:
    now = 100.0
    assert gate(phone(received=now), now) is None
    offline = phone(received=now)
    offline.connected = False
    calibrating = phone(received=now)
    calibrating.calibration = "capturing"
    cases = {
        "offline": offline,
        "calibration": calibrating,
        "No pose": phone(received=now - 1.0),
        "limited": phone(received=now, tracking="limited"),
        "starting": phone(received=now, tracking="initializing"),
        "finding its place": phone(received=now, tracking="relocalizing"),
        "Simulated motion": phone(received=now, source="synthetic"),
        "no ARKit": phone(received=now, source="device-motion"),
    }
    for word, record in cases.items():
        reason = gate(record, now)
        assert reason is not None and word in reason, (word, reason)
    no_pose = phone()
    no_pose.pose = None
    assert "No pose" in (gate(no_pose, now) or "")


def test_calibration_synthetic_motion_and_latency_options() -> None:
    now = 50.0
    uncalibrated = phone(received=now)
    uncalibrated.calibration = "uncalibrated"
    assert gate(uncalibrated, now) is None
    assert "Calibrate" in (gate(uncalibrated, now, require_calibration=True) or "")
    assert gate(phone(received=now, source="synthetic", tracking="limited"), now, allow_synthetic=True) is None
    # Age counts from when the phone sent the pose: 200 ms since arrival plus 80 ms on the way is too old.
    assert "No pose" in (gate(phone(received=now - 0.2, latency_ms=50, hop_ms=30), now) or "")
    assert gate(phone(received=now - 0.2), now) is None
    slow = phone(received=now, latency_ms=90, hop_ms=40)
    assert "too slow (130 ms)" in (gate(slow, now, max_latency_ms=100) or "")
    assert gate(phone(received=now), now, max_latency_ms=100) is None  # unknown latency passes


# -- jumps, presses, follow, owners -----------------------------------------------------------------------------


def test_jumps_are_steps_faster_than_a_hand() -> None:
    jumps = JumpDetector()
    assert not jumps.check(pose(stamp=0.0, seq=0))
    assert not jumps.check(pose([0.01, 0, 0], stamp=1 / 60, seq=1))  # a hand: 0.6 m/s
    assert not jumps.check(pose([0.01, 0, 0], stamp=1 / 60, seq=1))  # the same pose again
    assert jumps.check(pose([0.16, 0, 0], stamp=2 / 60, seq=2))  # 15 cm in a frame
    assert not jumps.check(pose([0.30, 0, 0], stamp=3.0, seq=3))  # far, but slowly
    assert jumps.check(pose([0.30, 0, 0], [0, 0, 0.6], stamp=3.0 + 1 / 60, seq=4))  # a sudden turn
    assert not jumps.check(pose([5, 0, 0], stamp=3.1, session="s2"))  # a new world isn't a jump
    jumps.reset()
    assert not jumps.check(pose([9, 9, 9], stamp=3.2, session="s2", seq=9))
    assert not jumps.check(None)


def test_presses_are_consumed_once_and_first_sight_counts_nothing() -> None:
    record = phone()
    presses = PressTracker("teleop.deadman")
    record.holds["teleop.deadman"] = __import__("marionette").Hold(presses=3)
    assert presses.pressed(record) == 0
    assert presses.pressed(record) == 0
    record.holds["teleop.deadman"].presses = 5
    assert presses.pressed(record) == 2
    assert presses.pressed(record) == 0
    record.holds["teleop.deadman"].presses = 6
    presses.forget(record)
    assert presses.pressed(record) == 0
    record.press_counts["arm.reset"] = 1
    resets = PressTracker("arm.reset")
    assert resets.pressed(record) == 0
    record.press_counts["arm.reset"] = 2
    assert resets.pressed(record) == 1
    resets.reset(record.id)
    record.press_counts["arm.reset"] = 3
    assert resets.pressed(record) == 0


def test_follow_limits_speed_and_acceleration_and_lands_without_overshoot() -> None:
    for _ in range(50):
        target = RNG.normal(size=3)
        top, accel, dt = RNG.uniform(0.1, 1), RNG.uniform(0.5, 5), 1 / 125
        position, velocity = np.zeros(3), np.zeros(3)
        for _tick in range(20_000):
            new = follow(target - position, velocity, top, accel, dt)
            assert np.linalg.norm(new) <= top + 1e-9
            assert np.linalg.norm(new - velocity) <= accel * dt + 1e-9 or np.linalg.norm(target - position - new * dt) < 1e-9
            velocity = new
            before = np.linalg.norm(target - position)
            position = position + velocity * dt
            assert np.linalg.norm(target - position) <= before + 1e-9
            if np.linalg.norm(target - position) < 1e-9:
                break
        np.testing.assert_allclose(position, target, atol=1e-6)


def test_owners_keep_the_engaged_phone_else_the_lowest_number() -> None:
    one, two = phone("phone-1"), phone("phone-2")
    assert owners([two, one], ["left", "right"], "arm.select") == {"left": one, "right": None}
    assert owners([one, two], ["left", "right"], "arm.select", {"left": "phone-2"})["left"] is two
    two.values["arm.select"] = "right"
    result = owners([one, two], ["left", "right"], "arm.select", {"left": "phone-2"})
    assert result == {"left": one, "right": two}
    one.connected = False
    assert owners([one, two], ["left"], lambda p: "left")["left"] is two
