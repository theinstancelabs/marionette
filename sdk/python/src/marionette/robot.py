"""A robot's own connection: its phone screen, its state, notices and camera frames.

:class:`RobotLink` is a :class:`~marionette.client.GatewayClient` with ``role="robot"`` and the things a robot says
back, each re-sent the right way after every reconnect:

- **Its screen**, an HTML string or a file (``watch=True`` sends it again whenever the file is saved), pushed on
  every connect. The gateway answers; :attr:`RobotLink.screen_accepted` and :attr:`RobotLink.screen_error` hold
  the answer.
- **Its state**, any JSON object, for every phone or for one (``state(…, phone=…)``). The gateway keeps the latest of
  each and gives it to whoever connects later, so send the whole state every time, not changes. The link sends it
  at once when it changes and again every ``every`` seconds, so a screen can tell a robot that stopped answering
  (after ``max(1.5 s, 3 × every)`` of silence).
- **Notices** (``notice("Lift at its top")``), never merged or dropped for a newer one, but dropped while the gateway
  is away: they are about now.
- **JPEG frames** per stream, newest only, dropped while disconnected.

Give it a :class:`~marionette.phones.PhoneTracker` and it feeds it.
"""

from __future__ import annotations

import asyncio
import base64
import copy
import logging
import threading
import time
from pathlib import Path
from typing import Any

from .client import GatewayClient
from .phones import PhoneTracker
from .protocol import MAX_ROBOT_STATE_BYTES, MAX_SCREEN_BYTES, MAX_STATUS_VALUES_BYTES, PROTOCOL_VERSION, dumps, wall_ms

_logger = logging.getLogger("marionette")
NOTICE = "robot.notice"


class RobotLink:
    """A robot-role connection that keeps the robot's screen and state on the phones.

    ``screen`` is HTML (a string that starts with ``<``) or a path to an HTML file. ``every`` is how often state is
    re-sent unchanged, in seconds. Everything else is passed to :class:`GatewayClient` (``token``, ``cameras``,
    ``on_message``, …).
    """

    def __init__(
        self,
        address: str = "localhost",
        robot_id: str = "robot",
        name: str | None = None,
        *,
        screen: str | Path | None = None,
        title: str | None = None,
        watch: bool = False,
        every: float = 0.2,
        tracker: PhoneTracker | None = None,
        **client: Any,
    ) -> None:
        if not 0.01 <= every <= 60:
            raise ValueError("every must be between 0.01 and 60 seconds")
        self.client = GatewayClient(address, role="robot", robot_id=robot_id, name=name, **client)
        self.robot_id = robot_id
        self.every = every
        self.tracker = tracker
        if tracker is not None:
            tracker.attach(self.client)
        self._lock = threading.Lock()
        self._states: dict[str | None, tuple[str, dict[str, Any]]] = {}
        self._sent: dict[str | None, float] = {}
        self._screen_html: str | None = None
        self._screen_path: Path | None = None
        self._screen_mtime: float | None = None
        self._title = title
        self._watch = watch
        self.screen_accepted: bool | None = None
        """The gateway's answer to the last screen sent: True, False, or None while waiting (or with no screen)."""
        self.screen_error: str | None = None
        """Why the last screen was refused, in the gateway's words."""
        self.screen_warnings: list[str] = []
        self._screen_answer = threading.Event()
        self.client.on("connect", self._on_connect)
        self.client.on("message", self._on_message)
        self.client.background(self._tick)
        if screen is not None:
            self.set_screen(screen, title=title, watch=watch)

    # -- delegation ----------------------------------------------------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self.client.connected

    @property
    def error(self) -> str | None:
        return self.client.error

    def on(self, event: str, callback: Any) -> Any:
        """Listen to the connection (see :meth:`GatewayClient.on`)."""
        return self.client.on(event, callback)  # type: ignore[arg-type]

    def send(self, message: dict[str, Any], **options: Any) -> bool:
        """Send any message (see :meth:`GatewayClient.send`)."""
        return self.client.send(message, **options)

    def start(self) -> RobotLink:
        """Run on a background thread (see :meth:`GatewayClient.start`)."""
        self.client.start()
        return self

    def stop(self, timeout: float = 5.0) -> None:
        self.client.stop(timeout)

    async def run(self) -> None:
        """Run inside your asyncio code until stopped (see :meth:`GatewayClient.run`)."""
        await self.client.run()

    async def aclose(self) -> None:
        await self.client.aclose()

    def wait_connected(self, timeout: float | None = None) -> bool:
        return self.client.wait_connected(timeout)

    def __enter__(self) -> RobotLink:
        return self.start()

    def __exit__(self, *_: Any) -> None:
        self.stop()

    async def __aenter__(self) -> RobotLink:
        self._task = asyncio.ensure_future(self.run())
        await asyncio.sleep(0)
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()
        await asyncio.gather(self._task, return_exceptions=True)

    # -- the screen ----------------------------------------------------------------------------------------------------

    def set_screen(self, screen: str | Path, *, title: str | None = None, watch: bool | None = None) -> None:
        """Show ``screen`` (HTML, or a path to a file) on the phones, now if connected and on every connect."""
        if isinstance(screen, Path) or not str(screen).lstrip().startswith("<"):
            path = Path(screen).expanduser().resolve()
            self._screen_path = path
            self._screen_mtime = path.stat().st_mtime
            html = path.read_text(encoding="utf-8")
        else:
            self._screen_path = None
            html = str(screen)
        if len(html.encode()) > MAX_SCREEN_BYTES:
            raise ValueError(f"the screen is {len(html.encode()) // 1000} KB; the gateway takes at most 512 KB")
        if title is not None:
            self._title = title
        if watch is not None:
            self._watch = watch
        self._screen_html = html
        self._push_screen()

    def wait_screen(self, timeout: float | None = 5.0) -> bool | None:
        """Wait for the gateway's answer to the screen; returns :attr:`screen_accepted` (None on timeout)."""
        self._screen_answer.wait(timeout)
        return self.screen_accepted

    def _push_screen(self) -> None:
        if self._screen_html is None:
            return
        message: dict[str, Any] = {"type": "screen", "version": PROTOCOL_VERSION, "html": self._screen_html}
        if self._title:
            message["title"] = self._title[:128]
        if self.client.queue("screen", message):
            self.screen_accepted = None
            self._screen_answer.clear()

    def _check_screen_file(self) -> None:
        path = self._screen_path
        if path is None or not self._watch:
            return
        try:
            mtime = path.stat().st_mtime
            if mtime == self._screen_mtime:
                return
            self._screen_mtime = mtime
            html = path.read_text(encoding="utf-8")
        except OSError as error:
            _logger.warning("marionette: can't read the screen %s (%s)", path, error)
            return
        if html != self._screen_html and html.strip():
            _logger.info("marionette: %s changed; sending it again", path.name)
            self._screen_html = html
            self._push_screen()

    # -- state, notices, frames ----------------------------------------------------------------------------------------

    def state(self, state: dict[str, Any], phone: str | None = None) -> None:
        """Set the robot's state for every phone, or for one ``phone``. Sent at once if it changed, and re-sent every
        :attr:`every` seconds. Nested JSON is fine (``None`` for unknown); at most 64 KB."""
        if not isinstance(state, dict):
            raise TypeError("state must be a dict")
        text = dumps(state)
        if len(text.encode()) > MAX_ROBOT_STATE_BYTES:
            raise ValueError(f"the state is {len(text.encode())} bytes; the gateway takes at most 64 KB")
        with self._lock:
            previous = self._states.get(phone)
            self._states[phone] = (text, copy.deepcopy(state))
            changed = previous is None or previous[0] != text
        if changed:
            self._send_state(phone)

    def clear_state(self, phone: str | None = None) -> None:
        """Stop re-sending the state for ``phone`` (a phone that has gone, say). The gateway keeps the last one."""
        with self._lock:
            self._states.pop(phone, None)
            self._sent.pop(phone, None)

    def states(self) -> dict[str | None, dict[str, Any]]:
        """The state the link is keeping, by phone (None for every phone)."""
        with self._lock:
            return {phone: copy.deepcopy(entry[1]) for phone, entry in self._states.items()}

    def _send_state(self, phone: str | None) -> None:
        # Read and queue under one lock: otherwise the periodic re-send, reading the state just before the control
        # thread changes it, could queue the old state over the new one (Stop on, overwritten by Stop off).
        with self._lock:
            entry = self._states.get(phone)
            if entry is None:
                return
            message: dict[str, Any] = {
                "type": "robot_state",
                "version": PROTOCOL_VERSION,
                "state": entry[1],
                "everyMs": round(self.every * 1000),
                "sentAt": wall_ms(),
            }
            if phone is not None:
                message["phoneId"] = phone
            if self.client.queue(f"state:{phone or ''}", message):
                self._sent[phone] = time.monotonic()

    def notice(self, message: str, phone: str | None = None, **values: Any) -> bool:
        """A one-off notice for every phone, or one: a ``status`` with ``controlId: "robot.notice"``. ``values`` may
        be any JSON (at most 16 KB). Returns False if it was dropped because the gateway is away."""
        if values and len(dumps(values).encode()) > MAX_STATUS_VALUES_BYTES:
            raise ValueError("notice values are limited to 16 KB")
        return self.client.status(message, phone=phone, control_id=NOTICE, values=values or None)

    def send_jpeg(self, stream: str, jpeg: bytes, captured_ms: float | None = None) -> bool:
        """Queue a JPEG frame for ``stream`` (declared by the screen); a newer frame of the stream replaces it.
        Dropped while disconnected."""
        message = {
            "type": "camera_frame",
            "version": PROTOCOL_VERSION,
            "sessionId": self.robot_id,
            "cameraId": stream,
            "dataUrl": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii"),
            "capturedAt": wall_ms() if captured_ms is None else captured_ms,
        }
        return self.client.queue(f"frame:{stream}", message)

    # -- connection events ---------------------------------------------------------------------------------------------

    def _on_connect(self) -> None:
        self._push_screen()
        with self._lock:
            phones = list(self._states)
        for phone in phones:
            self._send_state(phone)

    def _on_message(self, message: dict[str, Any]) -> None:
        if message.get("type") == "status" and message.get("controlId") == "screen" and "phoneId" not in message:
            raw = message.get("values")
            values: dict[str, Any] = raw if isinstance(raw, dict) else {}
            accepted = values.get("accepted")
            if not isinstance(accepted, bool):
                return
            self.screen_accepted = accepted
            self.screen_error = None if accepted else str(message.get("message") or "Screen refused")
            warnings = values.get("warnings")
            self.screen_warnings = [str(w) for w in warnings] if isinstance(warnings, list) else []
            if not accepted:
                _logger.warning("marionette: %s", self.screen_error)
            for warning in self.screen_warnings:
                _logger.warning("marionette: screen: %s", warning)
            self._screen_answer.set()

    async def _tick(self) -> None:
        """Re-send state every :attr:`every` seconds, and watch the screen file."""
        last_check = 0.0
        while True:
            await asyncio.sleep(min(self.every / 2, 0.1))
            now = time.monotonic()
            if self.client.connected:
                with self._lock:
                    due = [phone for phone in self._states if now - self._sent.get(phone, 0.0) >= self.every]
                for phone in due:
                    self._send_state(phone)
            if now - last_check >= 0.5:
                last_check = now
                self._check_screen_file()
