"""The example robot (examples/sim_robot.py) end to end: the real gateway, the robot as its own process, a SimPhone."""

from __future__ import annotations

import math
import signal
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from marionette.teleop import exp_rotation
from marionette.testing import Gateway, SimPhone, wait_until

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "sim_robot.py"


@pytest.fixture
def sim_arm(gateway: Gateway) -> Iterator[subprocess.Popen[str]]:
    process = subprocess.Popen([sys.executable, str(EXAMPLE), "--gateway", gateway.url], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        yield process
    finally:
        process.send_signal(signal.SIGINT)
        try:
            process.wait(10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def arm_state(phone: Any) -> dict[str, Any] | None:
    states = [s for s in phone.robot_states if s.get("robotId") == "sim-arm" and "phoneId" not in s]
    return states[-1]["state"] if states else None


def unwrap(degrees: list[float]) -> list[float]:
    out = [degrees[0]]
    for value in degrees[1:]:
        out.append(out[-1] + (value - out[-1] + 180) % 360 - 180)
    return out


def test_the_sim_arm_follows_a_phone_scaled_turns_on_and_stops(gateway: Gateway, sim_arm: subprocess.Popen[str]) -> None:
    with SimPhone(gateway) as phone:
        phone.wait_for(lambda p: p.html and p.html.get("source", {}).get("robotId") == "sim-arm", 10, "the robot's screen")
        phone.wait_for(lambda p: (c := p.control("teleop.translationScale")) and c["max"] == 3, 5, "the robot's layout")
        # Its streams are published over WebRTC, and its state comes at 5 Hz.
        wait_until(lambda: all(s.get("publisher") == "sim-arm" for s in gateway.get("/api/config")["cameraStreams"]), 10, "the WebRTC streams")
        phone.wait_for(arm_state, 5, "robot state")
        count = len(phone.robot_states)
        time.sleep(1.0)
        global_states = [s for s in phone.robot_states[count:] if "phoneId" not in s]
        assert 4 <= len(global_states) <= 7
        start = np.array(arm_state(phone)["gripper"]["position"])  # type: ignore[index]

        phone.calibrate()
        phone.set("teleop.translationScale", 2.0)
        phone.press("teleop.deadman")
        phone.wait_for(lambda p: (s := arm_state(p)) and s["engaged"] and s["driver"] == "Phone 1", 3, "engaged")
        phone.move_by((0.05, 0.02, 0.0), seconds=0.5)
        # The gripper moves twice as far: 10 cm forward, 4 cm left.
        phone.wait_for(lambda p: np.allclose(np.array(arm_state(p)["gripper"]["position"]) - start, [0.10, 0.04, 0.0], atol=0.003), 5, "the scaled move")

        # A half-scale 400° turn turns the gripper 200°, continuously (the bug a shared clutch prevents).
        phone.set("teleop.translationScale", 0.5)
        time.sleep(0.2)
        yaws: list[float] = []
        here, rotation = phone.pose()
        for degrees in range(0, 401, 8):
            phone.move_to(here, exp_rotation([0, 0, math.radians(degrees)]) @ rotation, seconds=1 / 60)
            state = arm_state(phone)
            yaws.append(state["gripper"]["yawDeg"])  # type: ignore[index]
        phone.wait_for(lambda p: abs(unwrap([*yaws, arm_state(p)["gripper"]["yawDeg"]])[-1] - 200) < 3, 5, "the 200° turn")  # type: ignore[index]
        # Sampled at the state's 5 Hz: always forward, never a flip.
        steps = np.diff(unwrap(yaws))
        assert np.all(steps > -1) and np.all(steps < 60) and steps.sum() > 100

        # Stop on the phone stops it, says why, and only a fresh press moves it again.
        phone.set("safety.estop", True)
        phone.wait_for(lambda p: (s := arm_state(p)) and s["stop"] == "Phone 1" and not s["engaged"], 3, "Stop")
        phone.wait_for(lambda p: any("Stopped by Phone 1" in s.get("message", "") for s in p.statuses), 3, "the Stop notice")
        phone.set("safety.estop", False)
        phone.wait_for(lambda p: (s := arm_state(p)) and s["stop"] is None, 3, "Stop off")
        time.sleep(0.3)
        assert not arm_state(phone)["engaged"]  # type: ignore[index]
        phone.release("teleop.deadman")
        phone.press("teleop.deadman")
        phone.wait_for(lambda p: arm_state(p)["engaged"], 3, "engaged again")  # type: ignore[index]
        phone.release("teleop.deadman")
        phone.wait_for(lambda p: not arm_state(p)["engaged"], 3, "released")  # type: ignore[index]
    assert sim_arm.poll() is None, sim_arm.stdout.read() if sim_arm.stdout else ""
