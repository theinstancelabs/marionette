"""WebRTC video end to end: a robot's VideoPublisher, the real gateway's signaling, and an aiortc viewer."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import numpy as np
import pytest

aiortc = pytest.importorskip("aiortc")

from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription  # noqa: E402

from marionette import RobotLink  # noqa: E402
from marionette.testing import Gateway  # noqa: E402
from marionette.video import VideoPublisher  # noqa: E402

SCREEN = """<!doctype html><html><head>
<script type="application/json" id="marionette-config">
{"cameraStreams": [{"id": "front", "label": "Front", "url": "webrtc://cam/front", "status": "live"},
                   {"id": "wrist", "label": "Wrist", "url": "webrtc://cam/wrist", "status": "live"}]}
</script></head><body>video robot</body></html>"""


class Viewer:
    """A desktop viewer: a console on the gateway that asks for a stream and answers the robot's offer."""

    def __init__(self, url: str) -> None:
        self.url = url
        self.messages: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.config: dict[str, Any] | None = None

    async def __aenter__(self) -> Viewer:
        from websockets.asyncio.client import connect

        self.ws = await connect(self.url)
        await self.ws.send(json.dumps({"type": "hello", "version": 1, "role": "console", "cameras": False}))
        self.reader = asyncio.ensure_future(self._read())
        return self

    async def __aexit__(self, *_: Any) -> None:
        self.reader.cancel()
        await self.ws.close()

    async def _read(self) -> None:
        async for raw in self.ws:
            message = json.loads(raw)
            if message.get("type") == "config" and "phone" not in message:
                self.config = message
            if message.get("type") == "rtc":
                await self.messages.put(message)

    async def send(self, **fields: Any) -> None:
        await self.ws.send(json.dumps({"type": "rtc", "version": 1, **fields}))

    async def next(self, kind: str, timeout: float = 10.0) -> dict[str, Any]:
        while True:
            message = await asyncio.wait_for(self.messages.get(), timeout)
            if message["kind"] == kind:
                return message


def negotiated(sdp: str) -> str:
    """The codec an answer settled on: the first payload type on its video line."""
    lines = sdp.splitlines()
    first = next(line for line in lines if line.startswith("m=video")).split()[3]
    name = next(line for line in lines if line.startswith(f"a=rtpmap:{first} ")).split()[1].split("/")[0]
    return f"video/{name}"


async def until(predicate: Any, timeout: float = 5.0) -> None:
    async def poll() -> None:
        while not predicate():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


@pytest.mark.asyncio
@pytest.mark.parametrize("codec, expect", [("h264", "video/H264"), ("vp8", "video/VP8")])
async def test_a_viewer_requests_gets_an_offer_answers_and_receives_frames(codec: str, expect: str) -> None:
    async with Gateway() as gateway:
        link = RobotLink(gateway.url, "cam", "Camera robot", screen=SCREEN)
        async with link:
            assert await link.client.wait_connected_async(5)
            video = VideoPublisher(link, ["front", "wrist"], fps=20, codec=codec)
            frame = np.zeros((240, 320, 3), dtype=np.uint8)
            frame[:, :160] = (200, 30, 30)
            video.push("front", frame)
            async with Viewer(gateway.url) as viewer:
                # The gateway lists the streams as published over WebRTC by the robot.
                await until(lambda: viewer.config and all(s.get("transport") == "webrtc" and s.get("publisher") == "cam" for s in viewer.config["cameraStreams"]))
                await viewer.send(kind="request", stream="front", peer="front-1")
                offer = await viewer.next("offer")
                assert offer["peer"] == "front-1" and offer["stream"] == "front" and "a=candidate" in offer["sdp"]  # complete, no trickle
                assert offer["sdp"].index("H264" if codec == "h264" else "VP8") < offer["sdp"].index("VP8" if codec == "h264" else "H264")
                # No STUN (aiortc's default asks Google's), like a viewer on the robot's LAN.
                receiver = RTCPeerConnection(RTCConfiguration(iceServers=[]))
                received: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

                @receiver.on("track")
                def on_track(track: Any) -> None:
                    async def pull() -> None:
                        for _ in range(3):  # skip the first frames while the encoder starts
                            await track.recv()
                        received.set_result(await track.recv())

                    asyncio.ensure_future(pull())

                await receiver.setRemoteDescription(RTCSessionDescription(offer["sdp"], "offer"))
                await receiver.setLocalDescription(await receiver.createAnswer())
                await viewer.send(kind="answer", to=offer["from"], peer="front-1", sdp=receiver.localDescription.sdp)
                got = await asyncio.wait_for(received, 15)
                assert (got.width, got.height) == (320, 240)
                image = got.to_ndarray(format="rgb24")
                assert image[:, :120, 0].mean() > 150 and image[:, 200:, 0].mean() < 60  # the left half is red
                assert negotiated(receiver.localDescription.sdp) == expect
                assert video.peers == 1
                await viewer.send(kind="close", to=offer["from"], peer="front-1")
                await until(lambda: video.peers == 0)
                await receiver.close()
            await video.aclose()
        assert video.peers == 0


@pytest.mark.asyncio
async def test_requests_for_unpublished_streams_and_a_viewer_leaving() -> None:
    async with Gateway() as gateway:
        link = RobotLink(gateway.url, "cam", screen=SCREEN)
        async with link:
            assert await link.client.wait_connected_async(5)
            video = VideoPublisher(link, ["front"], fps=10)
            async with Viewer(gateway.url) as viewer:
                await until(lambda: viewer.config and any(s.get("transport") == "webrtc" for s in viewer.config["cameraStreams"]))
                await viewer.send(kind="request", stream="wrist", peer="w-1")
                error = await viewer.next("error")
                assert "Nobody publishes" in error["message"]
                await viewer.send(kind="request", stream="front", peer="f-1")
                await viewer.next("offer")
                await until(lambda: video.peers == 1)
            # The viewer went away without a close: the gateway tells the robot, and its peer closes.
            await until(lambda: video.peers == 0)
            await video.aclose()
            with pytest.raises(KeyError):
                video.push("nope", np.zeros((2, 2, 3), np.uint8))
