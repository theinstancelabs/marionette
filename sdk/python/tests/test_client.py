"""GatewayClient without a gateway: the outbox, errors, backoff, and the background thread."""

from __future__ import annotations

import asyncio
import json
import math
import time

import pytest

import marionette.client as client_module
from marionette import GatewayClient
from marionette.testing import wait_until


def queued(client: GatewayClient) -> list[dict]:
    out = []
    while (data := client._next()) is not None:
        out.append(json.loads(data))
    return out


def test_the_outbox_coalesces_by_key_never_drops_notices_and_sends_frames_last() -> None:
    client = GatewayClient("localhost")
    client.connected = True  # pretend, to fill the outbox without a socket
    assert client.queue("frame:front", {"type": "camera_frame", "n": 1})
    assert client.queue("state:", {"type": "robot_state", "n": 1})
    assert client.send({"type": "status", "n": 1})
    assert client.queue("state:", {"type": "robot_state", "n": 2})  # replaces n 1, keeps its place
    assert client.send({"type": "status", "n": 2})
    assert client.queue("frame:front", {"type": "camera_frame", "n": 2})
    assert client.send({"type": "status", "n": 3}, bulk=True)
    assert [(m["type"], m["n"]) for m in queued(client)] == [
        ("robot_state", 2), ("status", 1), ("status", 2), ("camera_frame", 2), ("status", 3)]


def test_sending_while_disconnected_drops_and_bad_json_raises() -> None:
    client = GatewayClient("localhost")
    assert client.send({"type": "status"}) is False and queued(client) == []
    with pytest.raises(ValueError):
        client.send({"type": "robot_state", "state": {"x": math.nan}})


def test_roles_and_ids_are_checked() -> None:
    with pytest.raises(ValueError, match="robot_id"):
        GatewayClient("localhost", role="robot", robot_id="Not OK")
    with pytest.raises(ValueError):
        GatewayClient("localhost", robot_id="arm")
    with pytest.raises(ValueError):
        GatewayClient("not an address!")
    robot = GatewayClient("marionette://pair?host=10.0.0.2,10.0.0.3&port=9000&code=abcd-efgh", role="robot", robot_id="arm", name="Arm")
    assert robot.urls == ["ws://10.0.0.2:9000/ws", "ws://10.0.0.3:9000/ws"] and robot.token == "ABCDEFGH"
    assert robot._hello() == {"type": "hello", "version": 1, "role": "robot", "cameras": False, "robotId": "arm", "name": "Arm", "token": "ABCDEFGH"}


def test_an_unreachable_gateway_is_reported_and_retried_until_stopped() -> None:
    # Port 9 (discard) on loopback refuses connections; nothing listens there.
    client = GatewayClient("127.0.0.1:9").start()
    try:
        wait_until(lambda: client.error and "Can't reach the Marionette gateway at ws://127.0.0.1:9/ws" in client.error, 5, "the error")
        assert not client.connected and not client.wait_connected(0.05)
    finally:
        started = time.monotonic()
        client.stop()
        assert time.monotonic() - started < 2
        assert client._thread is None


def test_listeners_can_be_removed_and_a_failing_one_is_contained() -> None:
    client = GatewayClient("localhost")
    seen: list[dict] = []
    off = client.on("message", seen.append)
    client.on("message", lambda m: 1 / 0)
    client._emit("message", {"type": "x"})
    off()
    client._emit("message", {"type": "y"})
    assert seen == [{"type": "x"}]
    with pytest.raises(ValueError):
        client.on("nonsense", print)  # type: ignore[arg-type]


def test_a_clock_step_throws_the_offset_samples_away(monkeypatch: pytest.MonkeyPatch) -> None:
    clocks = {"wall": 1_793_000_000_000.0, "monotonic": 5_000.0}
    monkeypatch.setattr(client_module, "_clocks", lambda: (clocks["wall"], clocks["monotonic"]))
    client = GatewayClient("localhost")
    client._remeasure = asyncio.Event()
    truth = {"offset": 250.0}  # the gateway's clock minus ours

    def elapse(ms: float) -> None:
        clocks["wall"] += ms
        clocks["monotonic"] += ms

    def ping(ping_id: int) -> float:
        client._in_flight[ping_id] = (clocks["wall"], clocks["monotonic"])
        return clocks["wall"]

    def pong(ping_id: int, sent: float, rtt: float) -> None:
        elapse(rtt / 2)
        at = clocks["wall"] + truth["offset"]  # the gateway answers half way
        elapse(rtt / 2)
        client._pong({"type": "pong", "version": 1, "id": ping_id, "sentAt": sent, "at": at})

    for n in range(6):
        pong(n, ping(n), rtt=4.0 + n)
        elapse(1000)
    assert client.offset_ms == pytest.approx(250.0) and client.rtt_ms == pytest.approx(9.0)
    # NTP steps this computer's clock back 2 s: the offset is stale at once, not for the next 16 pings.
    clocks["wall"] -= 2000
    truth["offset"] += 2000
    assert client.offset_ms is None
    pong(10, ping(10), rtt=30.0)  # one slow round trip after the step is still the best there is
    assert client.offset_ms == pytest.approx(2250.0) and client.rtt_ms == pytest.approx(30.0)
    # Set forward 1 s while a ping is out: its round trip is timed right, but its stamp is on the old clock.
    sent = ping(11)
    clocks["wall"] += 1000
    truth["offset"] -= 1000
    pong(11, sent, rtt=6.0)
    assert client.rtt_ms == pytest.approx(6.0) and client.offset_ms is None and client._remeasure.is_set()
    pong(12, ping(12), rtt=6.0)
    assert client.offset_ms == pytest.approx(1250.0)
    # Slewing (a fraction of a millisecond a second) is no step.
    for n in range(13, 20):
        clocks["wall"] += 0.4
        pong(n, ping(n), rtt=6.0)
        elapse(1000)
    assert len(client._samples) == 8
