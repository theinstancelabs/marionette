"""GatewayClient without a gateway: the outbox, errors, backoff, and the background thread."""

from __future__ import annotations

import json
import math
import time

import pytest

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
