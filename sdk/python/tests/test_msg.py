"""The message builders produce the gateway's own shapes (checked against messages the real gateway sent)."""

from __future__ import annotations

import time
from typing import Any

from marionette import GatewayClient, RobotLink
from marionette.testing import Gateway, SimPhone, msg, wait_until


def keys(message: dict[str, Any]) -> set[str]:
    return set(message)


def test_builders_match_what_the_gateway_sends(gateway: Gateway) -> None:
    seen: list[dict[str, Any]] = []
    with GatewayClient(gateway.url, on_message=seen.append) as console:
        assert console.wait_connected(5)
        link = RobotLink(gateway.url, "shape").start()
        try:
            assert link.wait_connected(5)
            with SimPhone(gateway) as phone:
                phone.press("teleop.deadman")
                time.sleep(0.25)
                with phone.renewals_paused():
                    wait_until(lambda: any(m.get("type") == "input" and m.get("source") == "gateway" for m in seen), 3, "a gateway release")
                link.state({"a": 1}, phone=phone.phone_id)
                link.notice("hi")
                wait_until(lambda: any(m.get("type") == "robot_state" for m in seen), 3, "robot state")
                wait_until(lambda: any(m.get("type") == "pose" and "latencyMs" in m for m in seen), 4, "a stamped pose")
                pid = phone.phone_id
        finally:
            link.stop()

    def real(predicate: Any) -> dict[str, Any]:
        return next(m for m in seen if predicate(m))

    gateway_config = real(lambda m: m["type"] == "config" and "phone" not in m)
    phone_config = real(lambda m: m["type"] == "config" and "phone" in m)
    assert keys(msg.config(["phone-1"])) == keys(gateway_config)
    assert keys(msg.config(["phone-1"], "phone-1")) == keys(phone_config)
    assert keys(msg.config(["phone-1"], "phone-1")["phone"]) <= keys(phone_config["phone"]) | {"sessionId"}
    assert [c["id"] for c in msg.default_controls()] == [c["id"] for c in gateway_config["controls"]]
    for built, sent in zip(msg.default_controls(), gateway_config["controls"], strict=True):
        assert built == sent
    pose = real(lambda m: m["type"] == "pose" and "latencyMs" in m)
    assert keys(msg.pose(pid, sent_at=1.0, latency_ms=1.0)) == keys(pose)
    press = real(lambda m: m["type"] == "input" and m.get("source") == "phone" and "latencyMs" in m and not m.get("renew"))
    assert keys(msg.input(pid, "teleop.deadman", True, sent_at=1.0, latency_ms=1.0)) == keys(press)
    released = real(lambda m: m["type"] == "input" and m.get("source") == "gateway")
    assert keys(msg.let_go(pid, "teleop.deadman", False, reason="renewals stopped", control="deadman")) | {"sessionId"} == keys(released) | {"sessionId"}
    state = real(lambda m: m["type"] == "robot_state")
    assert keys(msg.robot_state("shape", {"a": 1}, phone=pid, every_ms=200, sent_at=1.0)) == keys(state)
