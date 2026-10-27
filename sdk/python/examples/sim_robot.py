#!/usr/bin/env python3
"""A simulated robot arm driven by Marionette phones: the Python SDK's parts in one small robot.

    python examples/sim_robot.py                                   # a gateway on this computer
    python examples/sim_robot.py --gateway 192.168.1.20 --token K7Q2-M9XD
    python examples/sim_robot.py --gateway "marionette://pair?…"   # or the gateway's pairing link

It connects as the robot ``sim-arm`` ("Sim arm") and:

- sends its own phone screen (``sim_robot.html``, on the screen kit; saving the file sends it again);
- drives a virtual gripper from the phones: a press of the hold-to-move pad engages the phone that pressed it
  (one phone at a time), and while the pad stays held the gripper follows the phone's motion through a
  :class:`Clutch`, scaled by the phone's Motion scale slider, inside a box around home, speed-limited;
- stops on any phone's Stop, a released or dropped pad, a failed gate (tracking, a stale pose, calibration), a new
  ARKit session or calibration, or an ARKit jump; only a fresh press engages again;
- publishes its state at 5 Hz (the gripper's position and rotation, who is driving, why not, its streams) and a
  notice for each event, and serves two WebRTC test-pattern cameras (front and top views of the gripper).

The control loop is this file's own (50 Hz); the SDK only supplies parts.
"""

from __future__ import annotations

import argparse
import logging
import math
import threading
import time
from pathlib import Path

import numpy as np

from marionette import Clutch, JumpDetector, PhoneTracker, PressTracker, RobotLink, gate
from marionette.teleop import exp_rotation, follow, matrix_to_quaternion, rotation_vector

ROBOT_ID, NAME = "sim-arm", "Sim arm"
STREAMS = ("sim-front", "sim-top")
DEADMAN, SCALE, HOME_ACTION = "teleop.deadman", "teleop.translationScale", "arm.home"
HOME = np.array([0.40, 0.0, 0.30])  # metres, in the robot's frame (REP-103: x forward, y left, z up)
BOX = np.array([0.25, 0.30, 0.25])  # the gripper stays within HOME ± BOX
RATE, MAX_SPEED, MAX_ACCEL, MAX_TURN, MAX_TURN_ACCEL = 50, 0.5, 3.0, 3.0, 20.0
log = logging.getLogger("sim_robot")


class SimArm:
    """The virtual gripper and the decisions Marionette leaves to the robot."""

    def __init__(self, link: RobotLink, tracker: PhoneTracker, *, allow_synthetic: bool, require_calibration: bool) -> None:
        self.link, self.tracker = link, tracker
        self.gates = {"allow_synthetic": allow_synthetic, "require_calibration": require_calibration}
        self.position, self.rotation = HOME.copy(), np.eye(3)
        self.velocity, self.spin = np.zeros(3), np.zeros(3)
        self.target = (HOME.copy(), np.eye(3))
        self.clutch, self.jumps = Clutch(), JumpDetector()
        self.presses, self.homes = PressTracker(DEADMAN), PressTracker(HOME_ACTION)
        self.owner: str | None = None
        self.reasons: dict[str, str] = {}  # phone id → why it isn't moving, until its next press
        self.stopped_by: str | None = None

    def release(self, reason: str | None = None, phone_id: str | None = None) -> None:
        """Stop following (a reason, if any, goes to that phone); only a fresh press engages again."""
        if reason and phone_id is not None:
            self.reasons[phone_id] = reason
            self.link.notice(f"Stopped moving: {reason}", phone=phone_id)
        self.clutch.release()
        self.owner = None

    def step(self, now: float, dt: float) -> None:
        phones = self.tracker.snapshot()
        stops = self.tracker.stops()
        stopped_by = (stops[0].name + ("" if stops[0].connected else " (offline)")) if stops else None
        if stopped_by != self.stopped_by:
            self.link.notice(f"Stopped by {stopped_by}" if stopped_by else "Stop is off: press the pad to move again")
            self.stopped_by = stopped_by
        # The phone that engaged keeps the gripper while every check still passes.
        owner = phones.get(self.owner or "")
        if self.clutch.engaged:
            if owner is None or not owner.connected:
                self.release()
            elif stopped_by:
                self.release(f"stopped by {stopped_by}", owner.id)
            elif not owner.hold(DEADMAN).down:
                self.release()  # let go
            elif not owner.holding(DEADMAN, now):
                self.release("the connection dropped; press again", owner.id)
            elif not self.clutch.anchor_valid(owner.pose):
                self.release("tracking restarted or calibration changed; press again", owner.id)
            elif self.jumps.check(owner.pose):
                self.release("tracking jumped; press again", owner.id)
            elif reason := gate(owner, now, **self.gates):
                self.release(reason, owner.id)
        # Every press is consumed once, whatever happens to it.
        for phone in sorted(phones.values(), key=lambda p: p.index):
            if self.homes.pressed(phone) and not self.clutch.engaged and not stopped_by:
                self.target = (HOME.copy(), np.eye(3))
                self.link.notice(f"{phone.name} sent the gripper home")
            if not self.presses.pressed(phone):
                continue
            if self.clutch.engaged:
                self.reasons[phone.id] = f"{phones[self.owner].name} is moving the arm" if self.owner in phones else "another phone is moving the arm"
            elif stopped_by:
                self.reasons[phone.id] = f"stopped by {stopped_by}"
            elif reason := gate(phone, now, **self.gates):
                self.reasons[phone.id] = reason
            elif phone.holding(DEADMAN, now) and phone.pose is not None:
                self.clutch.engage(phone.pose, *self.target, scale=phone.number(SCALE, 1.0, 0.1, 3.0))
                self.jumps.reset(phone.pose)
                self.owner = phone.id
                self.reasons.pop(phone.id, None)
                self.link.notice(f"{phone.name} is moving the arm")
                continue
            if phone.id in self.reasons:
                self.link.notice(self.reasons[phone.id], phone=phone.id)
        owner = phones.get(self.owner or "")
        if self.clutch.engaged and owner is not None and owner.pose is not None:
            scale = owner.number(SCALE, 1.0, 0.1, 3.0)
            if scale != self.clutch.scale:
                self.clutch.rescale(owner.pose, scale)  # a new scale never moves the gripper by itself
            position, rotation = self.clutch.target(owner.pose)
            self.target = (np.clip(position, HOME - BOX, HOME + BOX), rotation)
        if stopped_by:
            self.target = (self.position.copy(), self.rotation.copy())
            self.velocity[:] = self.spin[:] = 0
        # Speed and acceleration limited, landing on the target without overshoot.
        self.velocity = follow(self.target[0] - self.position, self.velocity, MAX_SPEED, MAX_ACCEL, dt)
        self.spin = follow(rotation_vector(self.target[1] @ self.rotation.T), self.spin, MAX_TURN, MAX_TURN_ACCEL, dt)
        self.position = self.position + self.velocity * dt
        self.rotation = exp_rotation(self.spin * dt) @ self.rotation

    def publish(self) -> None:
        """Robot state: the whole of it every time (the gateway keeps the latest for late joiners)."""
        phones = self.tracker.snapshot()
        driver = phones.get(self.owner or "")
        self.link.state(
            {
                "gripper": {
                    "position": [round(float(v), 4) for v in self.position],
                    "rotation": [round(float(v), 4) for v in matrix_to_quaternion(self.rotation)],
                    "yawDeg": round(math.degrees(math.atan2(self.rotation[1, 0], self.rotation[0, 0])), 1),
                },
                "engaged": self.clutch.engaged,
                "driver": driver.name if driver else None,
                "stop": self.stopped_by,
                "scale": self.clutch.scale if self.clutch.engaged else None,
                "streams": list(STREAMS),
            }
        )
        for phone in phones.values():
            if phone.connected and not phone.stale:
                engaged = self.clutch.engaged and self.owner == phone.id
                self.link.state({"engaged": engaged, "reason": None if engaged else self.reasons.get(phone.id)}, phone=phone.id)
            else:
                self.link.clear_state(phone.id)  # stop re-sending to a phone that has gone


# -- test-pattern cameras ---------------------------------------------------------------------------------------

DIGITS = {"0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111", "4": "101101111001001",
          "5": "111100111001111", "6": "111100111101111", "7": "111001001001001", "8": "111101111101111", "9": "111101111001111",
          ":": "000010000010000", ".": "000000000000010", " ": "000000000000000"}


def draw_text(image: np.ndarray, text: str, x: int, y: int, size: int = 4) -> None:
    for i, char in enumerate(text):
        glyph = np.array([int(c) for c in DIGITS.get(char, DIGITS[" "])], dtype=bool).reshape(5, 3)
        block = np.kron(glyph, np.ones((size, size), dtype=bool))
        left = x + i * 4 * size
        image[y : y + 5 * size, left : left + 3 * size][block] = 255


def pattern(stream: str, arm: SimArm, t: float, width: int = 320, height: int = 180) -> np.ndarray:
    """A moving gradient, the gripper as a dot (front: y and z; top: y and x), and the time."""
    columns, rows = np.meshgrid(np.arange(width), np.arange(height))
    image = np.zeros((height, width, 3), dtype=np.uint8)
    image[..., 0] = (columns + t * 60) % 256 // 2
    image[..., 1] = rows * 255 // height // 2
    image[..., 2] = 90 if stream == "sim-front" else 150
    offset = (arm.position - HOME) / BOX  # -1..1 on each axis
    across, along = -offset[1], (-offset[2] if stream == "sim-front" else -offset[0])
    cx, cy = int((across + 1) / 2 * (width - 1)), int((along + 1) / 2 * (height - 1))
    dot = (columns - cx) ** 2 + (rows - cy) ** 2 < 64
    image[dot] = (240, 200, 40) if arm.clutch.engaged else (230, 230, 230)
    draw_text(image, time.strftime("%H:%M:%S") + f".{int(t * 10) % 10}", 8, height - 28)
    return image


def run_cameras(video: object, arm: SimArm, stop: threading.Event, fps: float = 30.0) -> None:
    while not stop.wait(1 / fps):
        t = time.time()
        for stream in STREAMS:
            video.push(stream, pattern(stream, arm, t))  # type: ignore[attr-defined]


def main() -> None:
    parser = argparse.ArgumentParser(description="A simulated arm driven by Marionette phones.")
    parser.add_argument("--gateway", default="localhost", help="gateway address or pairing link (default: this computer)")
    parser.add_argument("--token", help="the gateway's pairing code, if it isn't in the link")
    parser.add_argument("--no-video", action="store_true", help="don't serve the WebRTC test cameras")
    parser.add_argument("--allow-synthetic", action="store_true", help="let simulated phone motion drive the arm")
    parser.add_argument("--require-calibration", action="store_true", help="refuse phones that haven't calibrated")
    parser.add_argument("--mirror", choices=("allow", "stop-only", "deny"), default="stop-only", help="what a desktop /screen mirror may do")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s")

    tracker = PhoneTracker(mirror=args.mirror)
    link = RobotLink(args.gateway, ROBOT_ID, NAME, token=args.token, screen=Path(__file__).with_name("sim_robot.html"), watch=True, every=0.2, tracker=tracker)
    arm = SimArm(link, tracker, allow_synthetic=args.allow_synthetic, require_calibration=args.require_calibration)
    link.start()
    stop, video, cameras = threading.Event(), None, None
    if not args.no_video:
        from marionette.video import VideoPublisher

        video = VideoPublisher(link, STREAMS, fps=30)
        cameras = threading.Thread(target=run_cameras, args=(video, arm, stop), daemon=True)
        cameras.start()
    log.info("connecting to %s as %s", link.client.url, ROBOT_ID)
    tick, period, error = 0, 1.0 / RATE, None
    try:
        next_at = time.monotonic()
        while True:
            now = time.monotonic()
            arm.step(now, period)
            if tick % (RATE // 5) == 0:
                arm.publish()  # 5 Hz
                if link.error != error:
                    error = link.error
                    log.info("%s", error or "connected")
            tick += 1
            next_at += period
            time.sleep(max(0.0, next_at - time.monotonic()))
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        if video is not None:
            video.close()  # type: ignore[attr-defined]
        link.stop()


if __name__ == "__main__":
    main()
