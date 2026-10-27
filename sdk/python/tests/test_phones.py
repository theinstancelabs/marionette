"""PhoneTracker: every rule Axol learned, through the message builders."""

from __future__ import annotations

import math
import threading
from typing import Any

import numpy as np
import pytest

from marionette import PhoneTracker
from marionette.teleop import rotation_vector
from marionette.testing import msg

CONTROLS = msg.default_controls() + [
    msg.button("reset-left", "arm.resetLeft"),
    msg.select("frame", "teleop.frame", "robot", ["robot", "head", "left"]),
    msg.slider("grip", "gripper.set", 0, 0, 1, 0.01),
]


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def tracker(clock: Clock) -> PhoneTracker:
    tracker = PhoneTracker(clock)
    tracker.apply(msg.config(["phone-1"], "phone-1", CONTROLS, {"status": "captured", "epoch": 2}, values={"arm.select": "right"}))
    return tracker


def send(tracker: PhoneTracker, action: str, value: Any = None, phone: str = "phone-1", **extra: Any) -> None:
    tracker.apply(msg.input(phone, action, value, **extra))


def test_config_sets_values_records_and_calibration(tracker: PhoneTracker) -> None:
    phone = tracker.get("phone-1")
    assert phone is not None and phone.connected and phone.name == "Phone 1"
    assert phone.value("arm.select") == "right" and phone.stop is False
    assert (phone.calibration, phone.epoch) == ("captured", 2)
    # Holds, drags and plain buttons come from the layout: nothing is hard-coded.
    assert set(phone.holds) == {"teleop.deadman", "gripper.hold", "base.turnLeft", "base.turnRight"}
    assert set(phone.drags) == {"teleop.translationScale", "base.drive", "base.speedLimit", "gripper.set"}
    assert phone.presses("arm.resetLeft") == 0
    assert phone.number("teleop.translationScale", 1.0, 0.05, 4.0) == 1.0
    assert phone.choice("teleop.frame", ("robot", "head"), "robot") == "robot"
    assert phone.flag("lift.toggle") is True
    assert phone.index == 1 and tracker.gateway == msg.SESSION


def test_poses_are_parsed_with_their_stamps(tracker: PhoneTracker, clock: Clock) -> None:
    tracker.offset = lambda: 5.0
    tracker._wall = lambda: 1_000_010.0  # type: ignore[method-assign]
    tracker.apply(msg.pose("phone-1", (0.1, 0.2, 0.3), (0, 0, 0.3), calibration="guided-v2:2", received_at=1_000_000.0, latency_ms=7.5, seq=4, monotonic=12.5))
    pose = tracker.get("phone-1").pose  # type: ignore[union-attr]
    assert pose is not None
    np.testing.assert_allclose(pose.position, [0.1, 0.2, 0.3])
    np.testing.assert_allclose(rotation_vector(pose.rotation), [0, 0, 0.3], atol=1e-9)
    assert (pose.received, pose.stamp, pose.seq, pose.calibration, pose.session) == (100.0, 12.5, 4, "guided-v2:2", "s1")
    # Phone → gateway 7.5 ms, gateway → here (our clock + offset − its receive stamp) 15 ms.
    assert (pose.latency_ms, pose.hop_ms, pose.delay_ms) == (7.5, 15.0, 22.5)
    clock.now += 0.1
    assert pose.age(clock.now) == pytest.approx(0.1225)
    with pytest.raises(ValueError):
        pose.position[0] = 1  # poses are immutable
    tracker.apply(msg.pose("phone-1", heartbeat=False, tracking="unavailable"))
    assert tracker.get("phone-1").pose is None  # type: ignore[union-attr]


def test_malformed_messages_are_ignored(tracker: PhoneTracker) -> None:
    tracker.apply(msg.pose("phone-1", (0.1, 0, 0)))
    before = tracker.get("phone-1").to_conformance()  # type: ignore[union-attr]
    bad_pose = msg.pose("phone-1")
    bad_pose["position"] = {"x": math.nan, "y": 0, "z": 0}
    for message in (None, 3, "x", [], {"type": "config", "phones": "nope", "phone": 7}, bad_pose, {**msg.pose("phone-1"), "trackingState": "great"},
                    msg.input("phone-1", "base.drive", {"x": "inf", "y": 0}, live=True), msg.input("phone-1", "gripper.set", math.inf),
                    msg.input("phone-1", "teleop.translationScale", 99, live=True), msg.input("phone-1", "teleop.deadman", "yes"),
                    {**msg.input("phone-1", "teleop.deadman", True), "source": "elsewhere"}, msg.input("phone-9", "teleop.deadman", True),
                    {"type": "input", "phoneId": "phone-1"}, {"type": "status", "message": "hi"}):
        tracker.apply(message)
    assert tracker.get("phone-1").to_conformance() == before  # type: ignore[union-attr]


def test_holds_count_presses_and_a_repeat_only_extends_a_hold_that_is_down(tracker: PhoneTracker, clock: Clock) -> None:
    send(tracker, "teleop.deadman", True)
    phone = tracker.get("phone-1")
    assert phone.hold("teleop.deadman").down and phone.presses("teleop.deadman") == 1  # type: ignore[union-attr]
    clock.now += 0.5
    send(tracker, "teleop.deadman", True, renew=True)
    phone = tracker.get("phone-1")
    assert phone.hold("teleop.deadman").at == clock.now and phone.presses("teleop.deadman") == 1  # type: ignore[union-attr]
    assert phone.holding("teleop.deadman", clock.now + 0.5, 0.6) and not phone.holding("teleop.deadman", clock.now + 0.7, 0.6)  # type: ignore[union-attr]
    tracker.apply(msg.let_go("phone-1", "teleop.deadman", False, reason="renewals stopped"))
    assert not tracker.get("phone-1").hold("teleop.deadman").down  # type: ignore[union-attr]
    send(tracker, "teleop.deadman", True, renew=True)  # a repeat never restarts a hold
    assert not tracker.get("phone-1").hold("teleop.deadman").down  # type: ignore[union-attr]
    send(tracker, "teleop.deadman", True)
    assert tracker.get("phone-1").presses("teleop.deadman") == 2  # type: ignore[union-attr]


def test_the_gateways_held_false_ends_a_hold_but_held_true_never_starts_one(tracker: PhoneTracker) -> None:
    send(tracker, "teleop.deadman", True)
    tracker.apply(msg.config(["phone-1"], "phone-1", CONTROLS, "captured"))
    assert not tracker.get("phone-1").hold("teleop.deadman").down  # type: ignore[union-attr]
    tracker.apply(msg.config(["phone-1"], "phone-1", CONTROLS, "captured", held=["teleop.deadman"]))
    assert not tracker.get("phone-1").hold("teleop.deadman").down  # type: ignore[union-attr]


def test_plain_button_press_edges_are_counted(tracker: PhoneTracker) -> None:
    send(tracker, "arm.resetLeft")
    send(tracker, "arm.resetLeft")
    send(tracker, "arm.resetLeft", renew=True)
    send(tracker, "horn.honk", "loud")  # an action no control declares: counted, and its value kept
    phone = tracker.get("phone-1")
    assert phone.presses("arm.resetLeft") == 2 and phone.presses("horn.honk") == 1  # type: ignore[union-attr]
    assert phone.value("horn.honk") == "loud"  # type: ignore[union-attr]


def test_stop_acts_from_the_press_itself(tracker: PhoneTracker) -> None:
    send(tracker, "safety.estop", True)
    assert tracker.get("phone-1").stop and tracker.any_stop()  # type: ignore[union-attr]
    send(tracker, "safety.estop", False)
    assert not tracker.any_stop()


def test_slider_values_come_from_live_inputs(tracker: PhoneTracker, clock: Clock) -> None:
    send(tracker, "gripper.set", 0.4, live=True)
    send(tracker, "gripper.set", 0.4, live=True, renew=True)
    phone = tracker.get("phone-1")
    assert phone.value("gripper.set") == 0.4 and phone.drag("gripper.set").live  # type: ignore[union-attr]
    send(tracker, "base.speedLimit", 80, live=True)
    send(tracker, "teleop.translationScale", 0.5, live=True)
    # A config sent mid-drag (another phone joined) still says the drag's start; the samples are newer.
    tracker.apply(msg.config(["phone-1", "phone-2"], "phone-1", CONTROLS, "captured", values={"base.speedLimit": 60, "teleop.translationScale": 1}, live=["base.speedLimit", "teleop.translationScale", "gripper.set"]))
    phone = tracker.get("phone-1")
    assert phone.number("base.speedLimit", 50, 0, 100) == 80 and phone.number("teleop.translationScale", 1) == 0.5  # type: ignore[union-attr]
    send(tracker, "gripper.set", 0.7)
    phone = tracker.get("phone-1")
    assert phone.value("gripper.set") == 0.7 and not phone.drag("gripper.set").live  # type: ignore[union-attr]


def test_the_drive_stick_and_a_dead_source(tracker: PhoneTracker, clock: Clock) -> None:
    phone = tracker.get("phone-1")
    assert phone.stick("base.drive", clock.now) == (0.0, 0.0)  # type: ignore[union-attr]
    send(tracker, "base.drive", {"x": 0.6, "y": -0.2}, live=True)
    assert tracker.get("phone-1").stick("base.drive", clock.now) == (0.6, -0.2)  # type: ignore[union-attr]
    assert tracker.get("phone-1").stick("base.drive", clock.now + 0.3, 0.25) is None  # type: ignore[union-attr]
    clock.now += 0.2
    send(tracker, "base.drive", {"x": 0.6, "y": -0.2}, live=True, renew=True)
    assert tracker.get("phone-1").stick("base.drive", clock.now + 0.2) == (0.6, -0.2)  # type: ignore[union-attr]
    send(tracker, "base.drive", {"x": 0, "y": 0})
    assert tracker.get("phone-1").stick("base.drive", clock.now + 5) == (0.0, 0.0)  # type: ignore[union-attr]
    send(tracker, "base.drive", {"x": 0.3, "y": 0}, live=True, renew=True)  # a repeat never starts a drag
    assert not tracker.get("phone-1").drag("base.drive").live  # type: ignore[union-attr]


def test_a_drag_the_gateway_ended_stays_ended_until_the_finger_lifts(tracker: PhoneTracker) -> None:
    send(tracker, "base.drive", {"x": 1, "y": 0}, live=True)
    send(tracker, "gripper.set", 0.6, live=True)
    tracker.apply(msg.let_go("phone-1", "base.drive", {"x": 0, "y": 0}))
    tracker.apply(msg.let_go("phone-1", "gripper.set", 0.6))
    send(tracker, "base.drive", {"x": 1, "y": 0}, live=True)  # still touching
    send(tracker, "gripper.set", 0.9, live=True)
    phone = tracker.get("phone-1")
    assert phone.stick("base.drive") == (0.0, 0.0) and phone.drag("base.drive").dropped  # type: ignore[union-attr]
    assert phone.value("gripper.set") == 0.6 and phone.drag("gripper.set").dropped  # the slider keeps its value  # type: ignore[union-attr]
    send(tracker, "base.drive", {"x": 0, "y": 0})  # let go
    send(tracker, "base.drive", {"x": 0.5, "y": 0}, live=True)
    assert tracker.get("phone-1").stick("base.drive") == (0.5, 0.0)  # type: ignore[union-attr]
    # A drag the tracker never saw live (a mirror's, say) isn't dropped by the gateway's end.
    tracker.apply(msg.let_go("phone-1", "base.speedLimit", 50))
    assert not tracker.get("phone-1").drag("base.speedLimit").dropped  # type: ignore[union-attr]


def test_mirror_policies() -> None:
    def tracker_with(policy: str) -> PhoneTracker:
        tracker = PhoneTracker(mirror=policy)  # type: ignore[arg-type]
        tracker.apply(msg.config(["phone-1"], "phone-1", CONTROLS))
        for action, value in (("teleop.deadman", True), ("base.drive", {"x": 1, "y": 0}), ("gripper.set", 1.0), ("arm.resetLeft", None), ("arm.select", "right")):
            tracker.apply(msg.input("phone-1", action, value, live=action in ("base.drive", "gripper.set"), source="mirror"))
        return tracker

    stop_only = tracker_with("stop-only")
    phone = stop_only.get("phone-1")
    assert not phone.hold("teleop.deadman").down and phone.stick("base.drive") == (0.0, 0.0)  # type: ignore[union-attr]
    assert phone.presses("arm.resetLeft") == 0 and phone.value("arm.select") == "left"  # type: ignore[union-attr]
    stop_only.apply(msg.input("phone-1", "safety.estop", True, source="mirror"))
    assert stop_only.any_stop()
    # A mirror can't turn Stop off, by its press or by the config that follows it.
    stop_only.apply(msg.input("phone-1", "safety.estop", False, source="mirror"))
    stop_only.apply(msg.config(["phone-1"], "phone-1", CONTROLS, values={"safety.estop": False}))
    assert stop_only.any_stop()
    stop_only.apply(msg.input("phone-1", "safety.estop", False))  # the phone itself can
    assert not stop_only.any_stop()

    allow = tracker_with("allow")
    phone = allow.get("phone-1")
    assert phone.hold("teleop.deadman").down and phone.stick("base.drive") == (1.0, 0.0) and phone.presses("arm.resetLeft") == 1  # type: ignore[union-attr]
    deny = tracker_with("deny")
    deny.apply(msg.input("phone-1", "safety.estop", True, source="mirror"))
    assert not deny.any_stop()
    with pytest.raises(ValueError):
        PhoneTracker(mirror="sometimes")  # type: ignore[arg-type]


def test_a_late_tracker_learns_stop_from_the_config() -> None:
    tracker = PhoneTracker()
    tracker.apply(msg.config(["phone-1"], "phone-1", CONTROLS, values={"safety.estop": True}))
    assert tracker.any_stop()


def test_disconnect_and_a_lost_gateway_let_go_of_everything(tracker: PhoneTracker) -> None:
    send(tracker, "teleop.deadman", True)
    send(tracker, "base.drive", {"x": 1, "y": 0}, live=True)
    tracker.apply(msg.pose("phone-1"))
    tracker.apply(msg.config([msg.phone_info("phone-1", connected=False)], controls=CONTROLS))
    phone = tracker.get("phone-1")
    assert not (phone.connected or phone.hold("teleop.deadman").down or phone.drag("base.drive").live or phone.pose)  # type: ignore[union-attr]
    tracker.apply(msg.config(["phone-1"], "phone-1", CONTROLS))
    send(tracker, "teleop.deadman", True)
    send(tracker, "safety.estop", True)
    tracker.lost_gateway()
    phone = tracker.get("phone-1")
    assert not phone.connected and not phone.hold("teleop.deadman").down and phone.stop  # type: ignore[union-attr]


def test_a_restarted_gateway_forgets_its_phones_but_not_a_stop(tracker: PhoneTracker) -> None:
    tracker.apply(msg.config(["phone-1", "phone-2"], controls=CONTROLS))
    send(tracker, "safety.estop", True, phone="phone-2")
    tracker.lost_gateway()
    tracker.apply(msg.config(["phone-1"], "phone-1", CONTROLS, session="marionette-new"))
    phones = tracker.snapshot()
    stale = f"phone-2@{msg.SESSION}"
    assert sorted(phones) == ["phone-1", stale]
    assert phones[stale].stop and phones[stale].stale and not phones[stale].connected and phones[stale].index == 2
    assert not phones["phone-1"].stop and tracker.gateway == "marionette-new"
    # Inputs for the old id now mean another phone.
    send(tracker, "safety.estop", False, phone=stale)
    assert tracker.any_stop() and [p.id for p in tracker.stops()] == [stale]
    assert tracker.clear_stale_stops() == [stale]
    assert sorted(tracker.snapshot()) == ["phone-1"] and not tracker.any_stop()


def test_clearing_an_offline_phones_stop_holds_until_it_returns(tracker: PhoneTracker) -> None:
    send(tracker, "safety.estop", True)
    tracker.apply(msg.config([msg.phone_info("phone-1", connected=False)], controls=CONTROLS))
    assert tracker.clear_stale_stops() == ["phone-1"]
    # The gateway still republishes the offline phone's config with Stop on; it stays cleared while it is away.
    offline = msg.config([msg.phone_info("phone-1", connected=False)], msg.phone_info("phone-1", connected=False), CONTROLS, values={"safety.estop": True})
    tracker.apply(offline)
    assert not tracker.any_stop()
    tracker.apply(msg.config(["phone-1"], "phone-1", CONTROLS, values={"safety.estop": True}))
    assert tracker.any_stop()  # back: its own Stop, as its screen shows it


def test_a_phone_gone_from_the_roster_keeps_only_its_stop(tracker: PhoneTracker) -> None:
    tracker.apply(msg.config(["phone-1", "phone-2", "phone-3"], controls=CONTROLS))
    send(tracker, "safety.estop", True, phone="phone-3")
    tracker.apply(msg.config(["phone-1"], controls=CONTROLS))
    assert sorted(tracker.snapshot()) == ["phone-1", f"phone-3@{msg.SESSION}"]


def test_snapshots_are_copies_and_the_tracker_is_thread_safe(tracker: PhoneTracker) -> None:
    snapshot = tracker.snapshot()
    snapshot["phone-1"].values["arm.select"] = "left"
    snapshot["phone-1"].holds["teleop.deadman"].down = True
    assert tracker.get("phone-1").value("arm.select") == "right"  # type: ignore[union-attr]
    assert not tracker.get("phone-1").hold("teleop.deadman").down  # type: ignore[union-attr]
    errors: list[BaseException] = []

    def feed() -> None:
        try:
            for i in range(2000):
                send(tracker, "teleop.deadman", i % 2 == 0)
                tracker.apply(msg.pose("phone-1", (i * 1e-4, 0, 0)))
        except BaseException as error:  # noqa: BLE001
            errors.append(error)

    threads = [threading.Thread(target=feed) for _ in range(3)]
    for thread in threads:
        thread.start()
    for _ in range(500):
        tracker.snapshot()
        tracker.any_stop()
    for thread in threads:
        thread.join()
    assert not errors and tracker.get("phone-1").presses("teleop.deadman") > 0  # type: ignore[union-attr]


def test_to_conformance_shape(tracker: PhoneTracker) -> None:
    send(tracker, "teleop.deadman", True)
    send(tracker, "arm.resetLeft")
    tracker.apply(msg.pose("phone-1", session="s9", tracking="limited"))
    shape = tracker.get("phone-1").to_conformance()  # type: ignore[union-attr]
    assert set(shape) == {"id", "connected", "calibration", "epoch", "stop", "values", "holds", "drags", "presses", "pose"}
    assert shape["holds"]["teleop.deadman"] == {"down": True, "presses": 1}
    assert shape["drags"]["base.drive"] == {"live": False, "dropped": False, "value": {"x": 0, "y": 0}}
    assert shape["presses"]["arm.resetLeft"] == 1
    assert shape["pose"] == {"session": "s9", "tracking": "limited", "source": "arkit", "calibration": "guided-v2:1"}
