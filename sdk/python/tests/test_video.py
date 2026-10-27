"""WebRTC video end to end: a robot's VideoPublisher, the real gateway's signaling, and an aiortc viewer."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import numpy as np
import pytest

aiortc = pytest.importorskip("aiortc")

from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription  # noqa: E402

import marionette.video as video_module  # noqa: E402
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


class Camera:
    """Pushes a frame to a stream at a steady rate while ``running``, as a robot's camera thread would."""

    def __init__(self, video: VideoPublisher, stream: str, frame: np.ndarray, fps: float = 20.0) -> None:
        self.video, self.stream, self.frame, self.fps = video, stream, frame, fps
        self.running = True
        self.task = asyncio.ensure_future(self._run())

    async def _run(self) -> None:
        while True:
            if self.running:
                self.video.push(self.stream, self.frame)
            await asyncio.sleep(1 / self.fps)

    def stop(self) -> None:
        self.task.cancel()


async def watch(viewer: Viewer, stream: str, peer: str, on_frame: Any) -> tuple[RTCPeerConnection, dict[str, Any]]:
    """Requests ``stream``, answers the robot's offer and calls ``on_frame(frame)`` for every decoded frame."""
    await viewer.send(kind="request", stream=stream, peer=peer)
    offer = await viewer.next("offer")
    # No STUN (aiortc's default asks Google's), like a viewer on the robot's LAN.
    receiver = RTCPeerConnection(RTCConfiguration(iceServers=[]))

    @receiver.on("track")
    def on_track(track: Any) -> None:
        async def pull() -> None:
            while True:
                try:
                    on_frame(await track.recv())
                except Exception:  # noqa: BLE001 - the track ended
                    return

        asyncio.ensure_future(pull())

    await receiver.setRemoteDescription(RTCSessionDescription(offer["sdp"], "offer"))
    await receiver.setLocalDescription(await receiver.createAnswer())
    await viewer.send(kind="answer", to=offer["from"], peer=peer, sdp=receiver.localDescription.sdp)
    return receiver, offer


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
            camera = Camera(video, "front", frame)
            async with Viewer(gateway.url) as viewer:
                # The gateway lists the streams as published over WebRTC by the robot.
                await until(lambda: viewer.config and all(s.get("transport") == "webrtc" and s.get("publisher") == "cam" for s in viewer.config["cameraStreams"]))
                frames: list[Any] = []
                receiver, offer = await watch(viewer, "front", "front-1", frames.append)
                assert offer["peer"] == "front-1" and offer["stream"] == "front" and "a=candidate" in offer["sdp"]  # complete, no trickle
                assert offer["sdp"].index("H264" if codec == "h264" else "VP8") < offer["sdp"].index("VP8" if codec == "h264" else "H264")
                await until(lambda: len(frames) >= 4, 15)  # skip the first frames while the encoder starts
                got = frames[3]
                assert (got.width, got.height) == (320, 240)
                image = got.to_ndarray(format="rgb24")
                assert image[:, :120, 0].mean() > 150 and image[:, 200:, 0].mean() < 60  # the left half is red
                assert negotiated(receiver.localDescription.sdp) == expect
                assert video.peers == 1
                await viewer.send(kind="close", to=offer["from"], peer="front-1")
                await until(lambda: video.peers == 0)
                await receiver.close()
            camera.stop()
            await video.aclose()
        assert video.peers == 0


@pytest.mark.asyncio
async def test_a_stalled_camera_stops_sending_until_its_frames_return(monkeypatch: pytest.MonkeyPatch) -> None:
    # What the track hands aiortc, which turns each frame's pts into its RTP timestamp (the receiver's decoder
    # renumbers the frames it decodes, so the gap only shows on this side).
    sent: list[tuple[float, int]] = []
    recv = video_module._LatestFrameTrack.recv

    async def spy(self: Any) -> Any:
        frame = await recv(self)
        sent.append((asyncio.get_running_loop().time(), frame.pts))
        return frame

    monkeypatch.setattr(video_module._LatestFrameTrack, "recv", spy)
    async with Gateway() as gateway:
        link = RobotLink(gateway.url, "cam", screen=SCREEN)
        async with link:
            assert await link.client.wait_connected_async(5)
            video = VideoPublisher(link, ["front"], fps=20, codec="vp8")
            camera = Camera(video, "front", np.full((120, 160, 3), 90, dtype=np.uint8))
            async with Viewer(gateway.url) as viewer:
                await until(lambda: viewer.config and any(s.get("transport") == "webrtc" for s in viewer.config["cameraStreams"]))
                loop = asyncio.get_running_loop()
                frames: list[float] = []
                receiver, _ = await watch(viewer, "front", "f-1", lambda f: frames.append(loop.time()))
                await until(lambda: len(frames) >= 10, 15)
                # The camera stalls: the last frame goes on for about a second (stale_after), then nothing.
                camera.running = False
                stalled = loop.time()
                await asyncio.sleep(2.5)
                late = [t for t in frames if t > stalled + 1.4]
                assert late == [], f"{len(late)} frames arrived more than 1.4 s into the stall"
                assert any(stalled + 0.6 < t <= stalled + 1.4 for t in frames)  # the last frame, repeated for a while
                before, sent_before = len(frames), len(sent)
                # Frames come back.
                camera.running = True
                resumed = loop.time()
                await until(lambda: len(frames) >= before + 10, 10)
                assert frames[before] - resumed < 1.0
                # The timestamps jumped over the gap, so RTP time stays in step with the clock, and only ever rose.
                (t0, pts0), (t1, pts1) = sent[sent_before - 1], sent[sent_before]
                assert t1 - t0 > 1.0 and abs((pts1 - pts0) / 90_000 - (t1 - t0)) < 0.05, (pts1 - pts0, t1 - t0)
                assert all(b[1] > a[1] for a, b in zip(sent, sent[1:]))
                await receiver.close()
            camera.stop()
            await video.aclose()


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
