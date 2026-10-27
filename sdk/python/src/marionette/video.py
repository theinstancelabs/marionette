"""WebRTC video from a robot's cameras, straight to each viewer (``pip install "marionette-sdk[video]"``).

:class:`VideoPublisher` serves the camera streams a robot's screen declares. Push frames from any thread
(``push(stream, rgb)``: the newest frame per stream is kept); viewers (the phone screens, the desktop mirror, the
viewer) ask the gateway for a stream, and the publisher answers each request with its own aiortc peer connection:

1. On every connect it publishes its streams (``rtc publish``), so the gateway marks them ``transport: webrtc``.
2. A viewer's ``request`` gets a peer connection whose track serves the latest frame at ``fps``, H.264 preferred
   (VP8 as the fallback), and a complete (non-trickle) ``offer``.
3. The viewer's ``answer`` completes it; ``close`` (or the gateway going away) closes it.

The gateway only passes the signaling; the video goes from the robot to the viewer directly. There are no STUN
servers by default (phones and robots meet on a LAN or a tailnet); pass ``ice_servers`` to add some.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import fractions
import logging
import threading
import time
from collections.abc import Iterable
from typing import Any

import numpy as np

from .client import GatewayClient
from .protocol import PROTOCOL_VERSION, wall_ms

try:
    from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCRtpSender, RTCSessionDescription
    from aiortc.mediastreams import MediaStreamError, MediaStreamTrack
    from aiortc.sdp import candidate_from_sdp
    from av import VideoFrame
except ImportError as error:  # pragma: no cover - only without the extra
    raise ImportError('marionette.video needs aiortc: pip install "marionette-sdk[video]"') from error

_logger = logging.getLogger("marionette")
_CLOCK = 90_000
_TIME_BASE = fractions.Fraction(1, _CLOCK)


class _LatestFrameTrack(MediaStreamTrack):
    """A video track that serves the publisher's newest frame of one stream at a steady rate."""

    kind = "video"

    def __init__(self, publisher: VideoPublisher, stream: str) -> None:
        super().__init__()
        self._publisher = publisher
        self._stream = stream
        self._start: float | None = None
        self._count = 0

    async def recv(self) -> VideoFrame:
        if self.readyState != "live":
            raise MediaStreamError
        fps = self._publisher.fps
        if self._start is None:
            self._start = time.monotonic()
        else:
            self._count += 1
            wait = self._start + self._count / fps - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            elif wait < -0.5:
                # Fell far behind (a busy loop): pick up from now rather than racing to catch up.
                self._start = time.monotonic() - self._count / fps
        frame = VideoFrame.from_ndarray(self._publisher._latest(self._stream), format="rgb24")
        frame.pts = int(self._count * _CLOCK / fps)
        frame.time_base = _TIME_BASE
        return frame


class _Peer:
    def __init__(self, viewer: str, peer: str, stream: str, connection: RTCPeerConnection) -> None:
        self.viewer = viewer
        self.peer = peer
        self.stream = stream
        self.connection = connection


class VideoPublisher:
    """Serves ``streams`` over WebRTC through a robot's connection (a :class:`~marionette.RobotLink` or a robot-role
    :class:`~marionette.GatewayClient`). Each stream must be declared in the robot's screen (``cameraStreams``).

    ``fps`` is the rate each viewer's track runs at, whatever rate frames are pushed. ``codec`` is ``"h264"``
    (preferred, VP8 as the fallback) or ``"vp8"``. Frames before the first push are black, ``size`` (width, height).
    """

    def __init__(
        self,
        link: Any,
        streams: Iterable[str],
        fps: float = 30.0,
        *,
        codec: str = "h264",
        size: tuple[int, int] = (640, 360),
        max_peers: int = 16,
        ice_servers: list[str] | None = None,
    ) -> None:
        client: GatewayClient = getattr(link, "client", link)
        if client.role != "robot":
            raise ValueError("only a robot connection publishes video (role='robot')")
        self.client = client
        self.streams = list(dict.fromkeys(streams))
        if not self.streams:
            raise ValueError("give at least one stream")
        self.fps = float(fps)
        self.codec = codec.lower()
        if self.codec not in ("h264", "vp8"):
            raise ValueError("codec is 'h264' or 'vp8'")
        self.max_peers = max_peers
        self._ice = [RTCIceServer(urls=url) for url in ice_servers or []]
        self._lock = threading.Lock()
        self._frames: dict[str, tuple[np.ndarray, float]] = {}
        self._black = np.zeros((size[1] - size[1] % 2, size[0] - size[0] % 2, 3), dtype=np.uint8)
        self._peers: dict[tuple[str, str], _Peer] = {}
        self._pending: dict[str, float] = {}
        self.publish_error: str | None = None
        """The gateway's last refusal of a publish (a stream the screen doesn't declare, say)."""
        self._closed = False
        self._off = [client.on("connect", self._on_connect), client.on("message", self._on_message), client.on("lost", self._on_lost)]
        if client.connected:
            self._publish(self.streams)

    # -- frames (any thread) -----------------------------------------------------------------------------------------

    def push(self, stream: str, rgb: np.ndarray, timestamp: float | None = None) -> None:
        """The newest frame of ``stream``: an ``(height, width, 3)`` uint8 RGB array (copied). ``timestamp`` is when it
        was captured (wall-clock ms; now by default). An odd width or height loses its last column or row (H.264)."""
        if stream not in self.streams:
            raise KeyError(f"{stream!r} isn't one of this publisher's streams ({', '.join(self.streams)})")
        frame = np.asarray(rgb)
        if frame.ndim != 3 or frame.shape[2] != 3:
            raise ValueError("a frame is an (height, width, 3) RGB array")
        height, width = frame.shape[0] - frame.shape[0] % 2, frame.shape[1] - frame.shape[1] % 2
        frame = np.array(frame[:height, :width], dtype=np.uint8, order="C", copy=True)
        with self._lock:
            self._frames[stream] = (frame, wall_ms() if timestamp is None else timestamp)

    def _latest(self, stream: str) -> np.ndarray:
        with self._lock:
            entry = self._frames.get(stream)
        return self._black if entry is None else entry[0]

    @property
    def peers(self) -> int:
        """Viewers connected or connecting."""
        return len(self._peers)

    # -- signaling (the client's loop) -------------------------------------------------------------------------------

    def _rtc(self, kind: str, **fields: Any) -> None:
        self.client.send({"type": "rtc", "version": PROTOCOL_VERSION, "kind": kind, **{k: v for k, v in fields.items() if v is not None}})

    def _publish(self, streams: list[str]) -> None:
        if streams and not self._closed:
            now = time.monotonic()
            self._pending.update({stream: now for stream in streams})
            self._rtc("publish", streams=streams)

    def _on_connect(self) -> None:
        self._pending.clear()
        self._publish(self.streams)

    def _on_lost(self) -> None:
        self._pending.clear()
        for key in list(self._peers):
            asyncio.ensure_future(self._close_peer(key, notify=False))

    def _on_message(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "config" and "phone" not in message:
            self._follow_config(message)
        elif kind == "rtc":
            self._signal(message)

    def _follow_config(self, config: dict[str, Any]) -> None:
        """Publish again whatever the gateway doesn't list as ours but the screen now declares (a screen change)."""
        declared = {s.get("id") for s in config.get("cameraStreams") or [] if isinstance(s, dict)}
        mine = next((r for r in config.get("robots") or [] if isinstance(r, dict) and r.get("id") == self.client.robot_id), None)
        listed = set(mine.get("streams") or []) if mine else set()
        now = time.monotonic()
        missing = [s for s in self.streams if s in declared and s not in listed and now - self._pending.get(s, -10.0) > 2.0]
        if missing and mine is not None and mine.get("connected"):
            self._publish(missing)

    def _signal(self, message: dict[str, Any]) -> None:
        kind, viewer, peer = message.get("kind"), message.get("from"), message.get("peer")
        if kind == "error" and peer is None:
            self.publish_error = str(message.get("message"))
            _logger.warning("marionette: video: %s", self.publish_error)
            return
        if kind == "error" and viewer is None and isinstance(message.get("to"), str) and isinstance(peer, str):
            # The gateway refused something we sent for this connection (the viewer has gone, say).
            asyncio.ensure_future(self._close_peer((message["to"], peer), notify=False))
            return
        if not isinstance(viewer, str) or not isinstance(peer, str):
            return
        key = (viewer, peer)
        if kind == "request":
            asyncio.ensure_future(self._offer(viewer, peer, str(message.get("stream"))))
        elif kind == "answer" and isinstance(message.get("sdp"), str):
            asyncio.ensure_future(self._answer(key, message["sdp"]))
        elif kind == "candidate" and isinstance(message.get("candidate"), dict):
            asyncio.ensure_future(self._candidate(key, message["candidate"]))
        elif kind in ("close", "error"):
            asyncio.ensure_future(self._close_peer(key, notify=False))

    def _preferences(self) -> list[Any]:
        codecs = RTCRtpSender.getCapabilities("video").codecs
        order = ["video/h264", "video/vp8"] if self.codec == "h264" else ["video/vp8", "video/h264"]
        ranked = [c for name in order for c in codecs if c.mimeType.lower() == name]
        return ranked + [c for c in codecs if c.mimeType.lower() == "video/rtx"]

    async def _offer(self, viewer: str, peer: str, stream: str) -> None:
        key = (viewer, peer)
        if stream not in self.streams:
            self._rtc("error", to=viewer, peer=peer, stream=stream, message=f"This robot doesn't publish {stream!r}")
            return
        if key in self._peers:
            await self._close_peer(key, notify=False)
        if len(self._peers) >= self.max_peers:
            self._rtc("error", to=viewer, peer=peer, stream=stream, message="Too many viewers; try again later")
            return
        connection = RTCPeerConnection(RTCConfiguration(iceServers=self._ice))
        self._peers[key] = _Peer(viewer, peer, stream, connection)

        @connection.on("connectionstatechange")
        async def changed() -> None:
            if connection.connectionState == "failed" and self._peers.get(key) is not None and self._peers[key].connection is connection:
                await self._close_peer(key, notify=True)

        try:
            transceiver = connection.addTransceiver(_LatestFrameTrack(self, stream), direction="sendonly")
            transceiver.setCodecPreferences(self._preferences())
            # aiortc gathers every candidate before the description is set, so the offer is complete.
            await connection.setLocalDescription(await connection.createOffer())
        except Exception as error:  # noqa: BLE001 - one viewer's failure is reported to it
            _logger.warning("marionette: video: couldn't offer %s to %s (%s)", stream, viewer, error)
            await self._close_peer(key, notify=False)
            self._rtc("error", to=viewer, peer=peer, stream=stream, message="The robot couldn't start this video")
            return
        if self._peers.get(key) is None or self._peers[key].connection is not connection:
            await connection.close()
            return
        self._rtc("offer", to=viewer, peer=peer, sdp=connection.localDescription.sdp)

    async def _answer(self, key: tuple[str, str], sdp: str) -> None:
        entry = self._peers.get(key)
        if entry is None:
            return
        try:
            await entry.connection.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="answer"))
        except Exception as error:  # noqa: BLE001
            _logger.warning("marionette: video: a bad answer from %s (%s)", key[0], error)
            await self._close_peer(key, notify=True)

    async def _candidate(self, key: tuple[str, str], candidate: dict[str, Any]) -> None:
        entry = self._peers.get(key)
        text = candidate.get("candidate")
        if entry is None or not isinstance(text, str) or not text.strip():
            return
        try:
            parsed = candidate_from_sdp(text.split(":", 1)[1] if text.startswith("candidate:") else text)
            parsed.sdpMid = candidate.get("sdpMid")
            parsed.sdpMLineIndex = candidate.get("sdpMLineIndex")
            await entry.connection.addIceCandidate(parsed)
        except Exception as error:  # noqa: BLE001 - a candidate we can't use is skipped
            _logger.debug("marionette: video: skipped a candidate (%s)", error)

    async def _close_peer(self, key: tuple[str, str], notify: bool) -> None:
        entry = self._peers.pop(key, None)
        if entry is None:
            return
        if notify:
            self._rtc("close", to=entry.viewer, peer=entry.peer)
        try:
            await entry.connection.close()
        except Exception:  # noqa: BLE001
            pass

    # -- shutdown ------------------------------------------------------------------------------------------------

    async def aclose(self) -> None:
        """Close every viewer's connection, stop publishing and stop listening (on the client's loop)."""
        if self._closed:
            return
        self._closed = True
        for off in self._off:
            off()
        await asyncio.gather(*(self._close_peer(key, notify=True) for key in list(self._peers)), return_exceptions=True)
        if self.client.connected:
            self._rtc("unpublish", streams=self.streams)

    def close(self, timeout: float = 5.0) -> None:
        """:meth:`aclose` from any other thread (it runs on the client's loop; on that loop it is only scheduled)."""
        loop = self.client.loop
        if loop is None or loop.is_closed() or not loop.is_running():
            self._closed = True
            for off in self._off:
                off()
            return
        if threading.get_ident() == self.client._loop_thread:
            asyncio.ensure_future(self.aclose())
            return
        try:
            self.client.submit(self.aclose()).result(timeout)
        except (concurrent.futures.TimeoutError, RuntimeError):
            pass
