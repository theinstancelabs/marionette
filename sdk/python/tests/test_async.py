"""The asyncio forms: GatewayClient.run(), the message iterator, RobotLink.run() and AsyncSimPhone."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from marionette import GatewayClient, PhoneTracker, RobotLink
from marionette.testing import AsyncSimPhone, Gateway


@pytest.mark.asyncio
async def test_the_client_runs_in_asyncio_and_iterates_messages() -> None:
    async with Gateway() as gateway:
        client = GatewayClient(gateway.url)
        task = asyncio.ensure_future(client.run())
        try:
            assert await client.wait_connected_async(5)
            assert client.config is not None and client.config["sessionId"] == gateway.session
            seen: list[str] = []

            async def watch() -> None:
                async for message in client.messages():
                    if message.get("type") == "config" and isinstance(message.get("phone"), dict):
                        seen.append(message["phone"]["id"])
                        return

            watcher = asyncio.ensure_future(watch())
            async with AsyncSimPhone(gateway) as phone:
                await asyncio.wait_for(watcher, 5)
                assert seen == [phone.phone_id]
        finally:
            await client.aclose()
            await task
        assert not client.connected


@pytest.mark.asyncio
async def test_a_robot_link_and_phones_in_one_event_loop() -> None:
    async with Gateway() as gateway:
        tracker = PhoneTracker()
        link = RobotLink(gateway.url, "async-arm", tracker=tracker, every=0.1)
        async with link:
            assert await link.client.wait_connected_async(5)
            async with AsyncSimPhone(gateway) as phone:
                await phone.calibrate()
                await phone.press("teleop.deadman")
                await phone.move_by((0.05, 0, 0), seconds=0.2)

                def engaged(_: Any) -> bool:
                    record = tracker.get(phone.phone_id)  # type: ignore[arg-type]
                    return record is not None and record.hold("teleop.deadman").down and record.pose is not None and record.pose.position[0] > 0.04

                await phone.wait_for(engaged, 3, "the tracker to follow")
                link.state({"x": float(tracker.get(phone.phone_id).pose.position[0])}, phone=phone.phone_id)  # type: ignore[union-attr]
                await phone.wait_for(lambda p: any(s.get("phoneId") == p.phone_id for s in p.robot_states), 3, "the phone's state")
                await phone.release("teleop.deadman")
        assert not link.connected


@pytest.mark.asyncio
async def test_stop_before_run_returns_at_once() -> None:
    client = GatewayClient("127.0.0.1:9")
    client.stop()
    await asyncio.wait_for(client.run(), 2)
