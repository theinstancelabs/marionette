"""The real gateway, on a free port, for tests."""

from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
import urllib.request
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from .. import gateway as runner


class Gateway:
    """The bundled gateway on a free port, with pairing off, Bonjour off and a temporary home and log directory.

        with Gateway() as gateway:
            link = RobotLink(gateway.url, "arm")
            …

    Also ``async with``. ``restart()`` brings it back on the same port as a new gateway session (phones get new
    ids, as after a real restart); its identity (id and pairing code) stays. ``log`` is everything it printed.
    """

    def __init__(
        self,
        *,
        port: int = 0,
        auth: runner.Auth = "off",
        token: str | None = None,
        name: str = "Marionette test",
        html: str | None = None,
        html_file: str | Path | None = None,
        env: Mapping[str, str] | None = None,
        echo: Callable[[str], None] | None = None,
    ) -> None:
        self.port = port
        self.auth = auth
        self.token = token
        self.name = name
        self.html_file = html_file
        self._env = {"MARIONETTE_ADDRESSES": "127.0.0.1", **({"MARIONETTE_HTML": html} if html is not None else {}), **(env or {})}
        self._echo = echo
        self._dir: Path | None = None
        self._process: runner.GatewayProcess | None = None
        self._logs: list[str] = []

    # -- life -------------------------------------------------------------------------------------------------------

    def start(self) -> Gateway:
        if self._process is not None and self._process.alive:
            return self
        if self._dir is None:
            self._dir = Path(tempfile.mkdtemp(prefix="marionette-gateway-"))
        self._process = runner.start(
            self.port,
            home=self._dir / "home",
            log_dir=self._dir / "logs",
            name=self.name,
            auth=self.auth,
            token=self.token,
            mdns=False,
            html_file=self.html_file,
            env=self._env,
            echo=self._echo,
        )
        self.port = self._process.port or self.port
        return self

    def stop(self) -> None:
        """Stop it (its temporary directory goes when the ``with`` block ends)."""
        if self._process is not None:
            self._process.stop()
            self._logs.append(self._process.log)
            self._process = None

    def restart(self) -> Gateway:
        """Stop and start again on the same port: a new session, the same id and pairing code."""
        self.stop()
        return self.start()

    def close(self) -> None:
        self.stop()
        if self._dir is not None:
            shutil.rmtree(self._dir, ignore_errors=True)
            self._dir = None

    def __enter__(self) -> Gateway:
        return self.start()

    def __exit__(self, *_: Any) -> None:
        self.close()

    async def __aenter__(self) -> Gateway:
        await asyncio.to_thread(self.start)
        return self

    async def __aexit__(self, *_: Any) -> None:
        await asyncio.to_thread(self.close)

    # -- where and what --------------------------------------------------------------------------------------------

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.alive

    @property
    def pid(self) -> int | None:
        return None if self._process is None else self._process.pid

    @property
    def url(self) -> str:
        """``ws://127.0.0.1:<port>/ws``."""
        return f"ws://127.0.0.1:{self.port}/ws"

    @property
    def address(self) -> str:
        """``127.0.0.1:<port>``, as an operator would type it."""
        return f"127.0.0.1:{self.port}"

    @property
    def http_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def log(self) -> str:
        """Everything it printed, across restarts."""
        current = [self._process.log] if self._process is not None else []
        return "\n".join(self._logs + current)

    @property
    def log_dir(self) -> Path | None:
        """Where its JSONL diagnostics logs are."""
        return None if self._dir is None else self._dir / "logs"

    def get(self, path: str) -> Any:
        """GET a JSON endpoint (``/health``, ``/api/state``, ``/api/pairing``)."""
        request = urllib.request.Request(self.http_url + path)
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def health(self) -> dict[str, Any]:
        return self.get("/health")

    def state(self) -> dict[str, Any]:
        """``/api/state``: every phone with its config, pose and link, the robots and the retained robot state."""
        return self.get("/api/state")

    @property
    def session(self) -> str:
        """The gateway's current session id."""
        return self.health()["sessionId"]
