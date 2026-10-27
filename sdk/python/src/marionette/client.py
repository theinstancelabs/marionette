"""A reconnecting connection to a Marionette gateway.

:class:`GatewayClient` says hello as a console (it watches every phone) or as a robot (it also talks back), and then:

- delivers every message to its listeners (``on("message", …)``, or ``async for message in client.messages()``);
- reconnects for ever with backoff (0.5 s doubling to 5 s), more slowly when the pairing code is refused, and says
  why in :attr:`error`;
- pings the gateway every second to learn the clock offset between the two computers (:attr:`offset_ms`), so pose
  ages can be measured from when the phone sent them, and answers the gateway's own pings;
- sends through an outbox that is safe to fill from any thread. A message queued under a key replaces one still
  waiting under the same key, so a slow link carries the newest state or frame instead of a backlog; a message
  without a key (a notice) is never dropped that way. Camera frames wait until every small message has gone.

It runs either inside your asyncio code (``await client.run()``) or on its own thread for synchronous robot code
(``client.start()`` … ``client.stop()``, or ``with GatewayClient(…) as client:``). Listeners run on the client's
event loop: keep them short, and hand work to your own threads.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import inspect
import itertools
import json
import logging
import re
import threading
import time
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Literal

from .address import resolve
from .protocol import CLOSE_PAIRING, CLOSE_REPLACED, CLOSE_ROBOT_ID_IN_USE, PROTOCOL_VERSION, ROBOT_ID, dumps, wall_ms

_logger = logging.getLogger("marionette")

Role = Literal["console", "robot"]
Event = Literal["message", "connect", "lost"]
_MAX_MESSAGE_BYTES = 8 * 1024 * 1024
_MAX_UNKEYED = 2000
_SAMPLES = 16
# This computer's wall clock moving this much against its monotonic clock means it was set (NTP stepping it, say).
# Slewing moves it well under a millisecond a second.
_STEP_MS = 20.0


def _clocks() -> tuple[float, float]:
    """This computer's wall clock (as the protocol stamps it) and its monotonic clock, in ms."""
    return wall_ms(), time.monotonic() * 1000.0


def _connect_options() -> dict[str, Any]:
    from websockets.asyncio.client import connect

    options: dict[str, Any] = {
        "max_size": _MAX_MESSAGE_BYTES,
        "open_timeout": 5,
        "ping_interval": 2,
        "ping_timeout": 4,
        "close_timeout": 1,
        "compression": None,
    }
    # websockets 15 reads proxy settings from the environment; a gateway is reached directly.
    if "proxy" in inspect.signature(connect).parameters:
        options["proxy"] = None
    return options


class GatewayClient:
    """A reconnecting console or robot connection to one gateway.

    ``address`` is what an operator would type (``192.168.1.20``, ``robot.local:9000``, ``ws://…``) or a pairing
    link (``marionette://pair?…``), whose hosts are tried in turn and whose code is used unless ``token`` is given.
    A robot needs ``robot_id`` (lower-case letters, digits and dashes) and may give a display ``name``. ``cameras``
    asks for JPEG camera frames (off by default: most consumers don't want them).
    """

    def __init__(
        self,
        address: str = "localhost",
        *,
        role: Role = "console",
        robot_id: str | None = None,
        name: str | None = None,
        token: str | None = None,
        cameras: bool = False,
        session_id: str | None = None,
        hello: dict[str, Any] | None = None,
        on_message: Callable[[dict[str, Any]], Any] | None = None,
        on_connect: Callable[[], Any] | None = None,
        on_lost: Callable[[], Any] | None = None,
        ping_every: float = 1.0,
    ) -> None:
        if role not in ("console", "robot"):
            raise ValueError(f"role must be 'console' or 'robot', not {role!r}")
        if role == "robot" and (robot_id is None or not re.match(ROBOT_ID, robot_id)):
            raise ValueError(f"a robot needs a robot_id of lower-case letters, digits and dashes (got {robot_id!r})")
        if role == "console" and robot_id is not None:
            raise ValueError("only a robot has a robot_id")
        target = resolve(address)
        self.address = address
        self.urls = target.urls
        self.url = self.urls[0]
        self.role: Role = role
        self.robot_id = robot_id
        self.name = name
        self.token = token if token is not None else target.token
        self.cameras = cameras
        self.session_id = session_id or robot_id or "python"
        self.ping_every = ping_every
        self._hello_extra = dict(hello or {})

        self.connected = False
        """True from the gateway's first config until the connection drops."""
        self.error: str | None = None
        """Why the last attempt failed, in words an operator can act on; None once connected."""
        self.close_code: int | None = None
        self._offset_ms: float | None = None
        self.rtt_ms: float | None = None
        """The last measured round trip to the gateway, in ms."""
        self.config: dict[str, Any] | None = None
        """The gateway's latest own config (the layout, the roster, the robots), without a ``phone``."""
        self.html_config: dict[str, Any] | None = None
        """The screen the gateway is showing (its latest ``html_config``)."""

        self._listeners: dict[str, list[Callable[..., Any]]] = {"message": [], "connect": [], "lost": []}
        for event, callback in (("message", on_message), ("connect", on_connect), ("lost", on_lost)):
            if callback is not None:
                self.on(event, callback)  # type: ignore[arg-type]
        self._lock = threading.Lock()
        self._urgent: dict[str, str] = {}
        self._bulk: dict[str, str] = {}
        self._keys = itertools.count()
        self._samples: deque[tuple[float, float]] = deque(maxlen=_SAMPLES)
        self._in_flight: dict[int, tuple[float, float]] = {}
        self._skew: float | None = None
        """This computer's wall clock minus its monotonic clock (ms) at the last pong; a jump in it is a clock step."""
        self._remeasure: asyncio.Event | None = None
        self._ping_ids = itertools.count(1)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_thread: int | None = None
        self._wake: asyncio.Event | None = None
        self._stop: asyncio.Event | None = None
        self._ready: asyncio.Event | None = None
        self._finished: asyncio.Event | None = None
        self._connected_flag = threading.Event()
        self._stopping = False
        self._thread: threading.Thread | None = None
        self._ws: Any = None
        self._companions: list[Callable[[], Awaitable[Any]]] = []

    @property
    def offset_ms(self) -> float | None:
        """The gateway's clock minus this computer's, in ms (from the fastest of the last 16 pings); None until known,
        and from the moment this computer's clock is set until it is measured again (within a round trip)."""
        offset, skew = self._offset_ms, self._skew
        if offset is None or skew is None:
            return None
        wall, monotonic = _clocks()
        return offset if abs(wall - monotonic - skew) <= _STEP_MS else None

    # -- listeners ---------------------------------------------------------------------------------------------------

    def on(self, event: Event, callback: Callable[..., Any]) -> Callable[[], None]:
        """Call ``callback`` on every ``message`` (with the message), on ``connect`` and on ``lost`` (no arguments).
        Returns a function that removes it. Callbacks run on the client's event loop; one that raises is logged."""
        if event not in self._listeners:
            raise ValueError(f"event must be message, connect or lost, not {event!r}")
        self._listeners[event].append(callback)

        def off() -> None:
            if callback in self._listeners[event]:
                self._listeners[event].remove(callback)

        return off

    def background(self, factory: Callable[[], Awaitable[Any]]) -> None:
        """Run ``factory()`` on the client's event loop for as long as the client runs (connected or not), and cancel
        it when the client stops. For periodic work that belongs with the connection, like re-sending state."""
        self._companions.append(factory)

    def _emit(self, event: str, *args: Any) -> None:
        for callback in list(self._listeners[event]):
            try:
                result = callback(*args)
                if inspect.isawaitable(result):
                    asyncio.ensure_future(result)
            except Exception:  # noqa: BLE001 - one bad listener must not take the link down
                _logger.exception("marionette: a %s listener failed", event)

    async def messages(self, maxsize: int = 1000) -> AsyncIterator[dict[str, Any]]:
        """Every message from now on, as an async iterator (on the client's own event loop). If you fall more than
        ``maxsize`` behind, the oldest are dropped."""
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize)

        def put(message: dict[str, Any]) -> None:
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(message)

        off = self.on("message", put)
        try:
            while True:
                yield await queue.get()
        finally:
            off()

    # -- sending (any thread) ------------------------------------------------------------------------------------------

    def send(self, message: dict[str, Any], *, key: str | None = None, bulk: bool | None = None) -> bool:
        """Queue ``message`` for the gateway, from any thread. Returns False (and drops it) while disconnected.

        With ``key``, it replaces a message still waiting under the same key (newest wins). ``bulk`` messages (camera
        frames, by default) go after every other waiting message. Raises ValueError for anything that isn't JSON
        (NaN included)."""
        data = dumps(message)
        if not self.connected:
            return False
        if bulk is None:
            bulk = message.get("type") == "camera_frame"
        with self._lock:
            box = self._bulk if bulk else self._urgent
            if key is None:
                key = f"\0{next(self._keys)}"
                if len(box) >= _MAX_UNKEYED:
                    box.pop(next(iter(box)))
                    _logger.warning("marionette: the outbox is full; dropped the oldest message")
            box[key] = data
        self._kick()
        return True

    def queue(self, key: str, message: dict[str, Any], *, bulk: bool | None = None) -> bool:
        """``send(message, key=key)``: the newest message under ``key`` replaces one still waiting."""
        return self.send(message, key=key, bulk=bulk)

    def status(
        self,
        message: str,
        *,
        phone: str | None = None,
        control_id: str | None = None,
        values: dict[str, Any] | None = None,
        key: str | None = None,
    ) -> bool:
        """Send a ``status`` to one phone (and its mirrors), or every phone: a notice or feedback for the screens."""
        payload: dict[str, Any] = {"type": "status", "version": PROTOCOL_VERSION, "sessionId": self.session_id, "message": message}
        if control_id is not None:
            payload["controlId"] = control_id
        if values is not None:
            payload["values"] = values
        if phone is not None:
            payload["phoneId"] = phone
        return self.send(payload, key=key)

    def _kick(self) -> None:
        loop, wake = self._loop, self._wake
        if loop is None or wake is None or loop.is_closed():
            return
        if threading.get_ident() == self._loop_thread:
            wake.set()
        else:
            try:
                loop.call_soon_threadsafe(wake.set)
            except RuntimeError:  # the loop closed meanwhile
                pass

    def _next(self) -> str | None:
        with self._lock:
            for box in (self._urgent, self._bulk):
                if box:
                    return box.pop(next(iter(box)))
        return None

    def _clear(self) -> None:
        with self._lock:
            self._urgent.clear()
            self._bulk.clear()

    # -- running -------------------------------------------------------------------------------------------------------

    @property
    def loop(self) -> asyncio.AbstractEventLoop | None:
        """The event loop the client runs on (None until it runs)."""
        return self._loop

    def submit(self, coroutine: Awaitable[Any]) -> concurrent.futures.Future[Any]:
        """Run a coroutine on the client's event loop from any thread."""
        if self._loop is None:
            raise RuntimeError("the client isn't running")
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop)  # type: ignore[arg-type]

    async def run(self) -> None:
        """Connect, serve and reconnect until :meth:`stop` (or cancellation)."""
        self._loop = asyncio.get_running_loop()
        self._loop_thread = threading.get_ident()
        self._wake, self._stop, self._ready, self._finished = asyncio.Event(), asyncio.Event(), asyncio.Event(), asyncio.Event()
        self._remeasure = asyncio.Event()
        if self._stopping:
            self._stop.set()
        delay, attempt = 0.5, 0
        companions = [asyncio.ensure_future(factory()) for factory in self._companions]
        try:
            while not self._stopping:
                url = self.urls[attempt % len(self.urls)]
                self.url = url
                code: int | None = None
                was_connected = False
                try:
                    code, was_connected = await self._session(url)
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001 - reported, then retried
                    self._fail(f"Can't reach the Marionette gateway at {url} ({_describe(error)})")
                finally:
                    self._lost()
                if self._stopping:
                    break
                if was_connected:
                    delay = 0.5
                    # Stick with the address that worked.
                    self.urls.insert(0, self.urls.pop(attempt % len(self.urls)))
                    attempt = 0
                else:
                    attempt += 1
                if code == CLOSE_PAIRING:
                    # Five wrong codes a minute shut an address out for a minute: stay well under that.
                    delay = max(delay, 5.0)
                    wait, delay = delay, min(delay * 2, 30.0)
                else:
                    wait, delay = delay, min(delay * 2, 5.0)
                try:
                    await asyncio.wait_for(self._stop.wait(), wait)
                except TimeoutError:
                    pass
        finally:
            for companion in companions:
                companion.cancel()
            await asyncio.gather(*companions, return_exceptions=True)
            self._lost()
            self._finished.set()

    async def _session(self, url: str) -> tuple[int | None, bool]:
        from websockets.asyncio.client import connect
        from websockets.exceptions import ConnectionClosed

        assert self._stop is not None and self._wake is not None
        self.close_code = None
        async with connect(url, **_connect_options()) as ws:
            self._ws = ws
            self._samples.clear()
            self._in_flight.clear()
            self._offset_ms = None
            try:
                await ws.send(dumps(self._hello()))
            except ConnectionClosed:
                pass  # refused at once (a shut-out address): the close code below says why
            tasks = [
                asyncio.ensure_future(self._receive(ws)),
                asyncio.ensure_future(self._send_loop(ws)),
                asyncio.ensure_future(self._ping_loop(ws)),
                asyncio.ensure_future(self._stop.wait()),
            ]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    if not task.cancelled() and task.exception() is not None:
                        error = task.exception()
                        if not isinstance(error, ConnectionClosed):
                            raise error  # type: ignore[misc]
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                was_connected = self.connected
                if self._stopping:
                    await ws.close(1000, "client stopping")
                self._ws = None
            code, reason = _close_info(ws)
            self.close_code = code
            if not self._stopping:
                self._explain(url, code, reason, was_connected)
            return code, was_connected

    def _hello(self) -> dict[str, Any]:
        hello: dict[str, Any] = {"type": "hello", "version": PROTOCOL_VERSION, "role": self.role, "cameras": self.cameras}
        if self.role == "robot":
            hello["robotId"] = self.robot_id
            if self.name:
                hello["name"] = self.name
        if self.token:
            hello["token"] = self.token
        hello.update(self._hello_extra)
        return hello

    async def _receive(self, ws: Any) -> None:
        async for raw in ws:
            if not isinstance(raw, str):
                continue
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(message, dict):
                continue
            kind = message.get("type")
            if kind == "ping":
                if isinstance(message.get("id"), int) and isinstance(message.get("sentAt"), (int, float)):
                    pong = {"type": "pong", "version": PROTOCOL_VERSION, "id": message["id"], "sentAt": message["sentAt"], "at": wall_ms()}
                    await ws.send(dumps(pong))
                continue
            if kind == "pong":
                self._pong(message)
                continue
            if kind == "config" and "phone" not in message:
                self.config = message
            elif kind == "html_config":
                self.html_config = message
            elif kind == "status" and message.get("controlId") == "hello" and isinstance(message.get("values"), dict) and message["values"].get("accepted") is False:
                _logger.warning("marionette: the gateway refused the hello: %s", message.get("message"))
            if kind == "config" and not self.connected:
                self._connected()
            self._emit("message", message)

    def _connected(self) -> None:
        self.connected = True
        if self.error is not None:
            _logger.info("marionette: connected to %s", self.url)
        else:
            _logger.debug("marionette: connected to %s", self.url)
        self.error = None
        self._connected_flag.set()
        assert self._ready is not None and self._wake is not None
        self._ready.set()
        self._emit("connect")
        self._wake.set()

    def _lost(self) -> None:
        self._clear()
        self._in_flight.clear()
        if not self.connected:
            return
        self.connected = False
        self._connected_flag.clear()
        if self._ready is not None:
            self._ready.clear()
        if not self._stopping:
            _logger.warning("marionette: lost the gateway at %s", self.url)
        self._emit("lost")

    async def _send_loop(self, ws: Any) -> None:
        assert self._wake is not None
        while True:
            await self._wake.wait()
            self._wake.clear()
            if not self.connected:
                continue
            while (data := self._next()) is not None:
                await ws.send(data)

    async def _ping_loop(self, ws: Any) -> None:
        assert self._remeasure is not None
        while True:
            ping_id = next(self._ping_ids)
            sent, monotonic = _clocks()
            self._in_flight[ping_id] = (sent, monotonic)
            while len(self._in_flight) > _SAMPLES:
                self._in_flight.pop(next(iter(self._in_flight)))
            await ws.send(dumps({"type": "ping", "version": PROTOCOL_VERSION, "id": ping_id, "sentAt": sent}))
            # Every ping_every seconds, or at once when a clock step threw the samples away.
            try:
                await asyncio.wait_for(self._remeasure.wait(), self.ping_every)
            except TimeoutError:
                pass
            self._remeasure.clear()

    def _pong(self, message: dict[str, Any]) -> None:
        sent = self._in_flight.pop(message.get("id"), None)  # type: ignore[arg-type]
        at = message.get("at")
        if sent is None or not isinstance(at, (int, float)) or isinstance(at, bool):
            return
        (sent_wall, sent_monotonic), (wall, monotonic) = sent, _clocks()
        # The round trip on the monotonic clock: setting the wall clock meanwhile doesn't stretch or shrink it.
        rtt = monotonic - sent_monotonic
        self.rtt_ms = rtt
        skew = wall - monotonic
        if self._skew is not None and abs(skew - self._skew) > _STEP_MS:
            # This computer's clock was set since the last pong: every sample measured the old clock. Measure again.
            self._samples.clear()
            self._offset_ms = None
        self._skew = skew
        if abs(sent_wall - sent_monotonic - skew) > _STEP_MS:
            # Set during this round trip: the ping's stamp is on the old clock.
            if self._remeasure is not None:
                self._remeasure.set()
            return
        self._samples.append((rtt, at - (sent_wall + rtt / 2)))
        self._offset_ms = min(self._samples)[1]

    def _fail(self, message: str) -> None:
        if message != self.error:
            _logger.warning("marionette: %s", message)
        self.error = message

    def _explain(self, url: str, code: int | None, reason: str, was_connected: bool) -> None:
        if code == CLOSE_PAIRING:
            detail = f" ({reason})" if reason else ""
            self._fail(f"Pairing code missing or wrong{detail}: pass token= with the code the gateway prints, or its pairing link")
        elif code == CLOSE_ROBOT_ID_IN_USE:
            self._fail(f"Another robot with id {self.robot_id!r} is connected to {url}; retrying until it goes away")
        elif code == CLOSE_REPLACED:
            self._fail(f"Replaced by a newer connection to {url}")
        elif was_connected:
            self._fail(f"Lost the gateway at {url}{f' ({code} {reason})'.rstrip() if code not in (None, 1000, 1001, 1006) else ''}; reconnecting")
        else:
            self._fail(f"The gateway at {url} closed the connection ({code} {reason})".replace(" )", ")"))

    # -- background thread and context managers ---------------------------------------------------------------------

    def start(self) -> GatewayClient:
        """Run on a background thread with its own event loop (for synchronous robot code). Returns self."""
        if self._thread is not None:
            return self
        self._stopping = False
        started = threading.Event()

        def main() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop, self._loop_thread = loop, threading.get_ident()
            task = loop.create_task(self.run())
            started.set()
            try:
                loop.run_until_complete(task)
            except asyncio.CancelledError:
                pass
            finally:
                pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
                for leftover in pending:
                    leftover.cancel()
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                loop.run_until_complete(loop.shutdown_asyncgens())
                loop.close()

        self._thread = threading.Thread(target=main, name="marionette-client", daemon=True)
        self._thread.start()
        started.wait()
        return self

    def stop(self, timeout: float = 5.0) -> None:
        """Close the connection and stop reconnecting. From another thread it waits (up to ``timeout``) for the
        background thread to finish; on the client's own loop it only asks (await :meth:`aclose` there instead)."""
        loop = self._loop
        self._stopping = True
        if loop is not None and not loop.is_closed():
            if threading.get_ident() == self._loop_thread:
                self._request_stop()
            else:
                try:
                    loop.call_soon_threadsafe(self._request_stop)
                except RuntimeError:
                    pass
        thread = self._thread
        if thread is not None and threading.current_thread() is not thread:
            thread.join(timeout)
            self._thread = None

    def _request_stop(self) -> None:
        self._stopping = True
        if self._stop is not None:
            self._stop.set()

    async def aclose(self) -> None:
        """Stop from asyncio code and wait until the connection has closed."""
        self._request_stop()
        if self._finished is not None:
            await self._finished.wait()

    def wait_connected(self, timeout: float | None = None) -> bool:
        """Block until connected (from any thread but the client's own loop). False on timeout."""
        return self._connected_flag.wait(timeout)

    async def wait_connected_async(self, timeout: float | None = None) -> bool:
        """Wait until connected, on the client's event loop. False on timeout."""
        while self._ready is None:
            await asyncio.sleep(0.005)
        try:
            await asyncio.wait_for(self._ready.wait(), timeout)
            return True
        except TimeoutError:
            return False

    def __enter__(self) -> GatewayClient:
        return self.start()

    def __exit__(self, *_: Any) -> None:
        self.stop()

    async def __aenter__(self) -> GatewayClient:
        self._stopping = False
        self._task = asyncio.ensure_future(self.run())
        await asyncio.sleep(0)
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()
        await asyncio.gather(self._task, return_exceptions=True)


def _close_info(ws: Any) -> tuple[int | None, str]:
    code = getattr(ws, "close_code", None)
    reason = getattr(ws, "close_reason", None)
    if code is None:
        protocol = getattr(ws, "protocol", None)
        code = getattr(protocol, "close_code", None)
        reason = getattr(protocol, "close_reason", None)
    return code, reason or ""


def _describe(error: BaseException) -> str:
    text = str(error)
    return f"{type(error).__name__}: {text}" if text else type(error).__name__
