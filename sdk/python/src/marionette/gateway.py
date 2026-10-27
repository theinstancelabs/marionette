"""Runs the Marionette gateway that ships inside this package.

The gateway is a Node program; ``_gateway/marionette-gateway.mjs`` is its single-file bundle (every dependency, the
default screen and the screen kit inside), so a robot needs no copy of the Marionette repository and no npm. It runs
with Node 20 or later from ``PATH``, or with the ``nodejs-wheel-binaries`` package
(``pip install "marionette-sdk[gateway]"``) on a robot without Node.

    marionette-gateway --port 8787 --name "Lab robot"         # the console script
    python -m marionette.gateway --no-mdns

From Python, :func:`run` runs it in the foreground and :func:`start` in the background, returning a handle.
"""

from __future__ import annotations

import argparse
import atexit
import collections
import functools
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
from collections.abc import Callable, Mapping
from importlib import resources
from pathlib import Path
from typing import Literal

Auth = Literal["off", "on", "strict"]
_LISTENING = re.compile(r"listening on http://[^\s:]+:(\d+)")


def bundle_path() -> Path:
    """The bundled gateway (``marionette/_gateway/marionette-gateway.mjs``)."""
    path = Path(str(resources.files("marionette") / "_gateway" / "marionette-gateway.mjs"))
    if not path.is_file():
        raise RuntimeError(f"The bundled gateway is missing ({path}); run sdk/python/scripts/sync_gateway.py in the repository")
    return path


@functools.lru_cache(maxsize=8)
def _node_major(node: str) -> int | None:
    try:
        version = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.match(r"v?(\d+)\.", version)
    return int(match.group(1)) if match else None


def find_node(minimum: int = 20) -> str:
    """A Node executable new enough for the gateway: ``$MARIONETTE_NODE``, ``node`` on PATH (``minimum`` or later),
    else the one from ``nodejs-wheel-binaries``. Raises RuntimeError saying how to get one."""
    candidates: list[str] = []
    if os.environ.get("MARIONETTE_NODE"):
        candidates.append(os.environ["MARIONETTE_NODE"])
    on_path = shutil.which("node")
    if on_path:
        candidates.append(on_path)
    try:
        from nodejs_wheel import executable  # type: ignore[import-not-found]

        bundled = Path(executable.ROOT_DIR) / ("node.exe" if os.name == "nt" else "bin/node")
        if bundled.exists():
            candidates.append(str(bundled))
    except ImportError:
        pass
    found = []
    for node in candidates:
        major = _node_major(node)
        if major is not None and major >= minimum:
            return node
        found.append(f"{node} (v{major})" if major is not None else node)
    detail = f" Found {', '.join(found)}." if found else ""
    raise RuntimeError(
        f"The Marionette gateway needs Node {minimum} or later.{detail} Install Node, or "
        '`pip install "marionette-sdk[gateway]"` to bring one with the SDK.'
    )


def gateway_env(
    port: int = 8787,
    *,
    home: str | Path | None = None,
    name: str | None = None,
    auth: Auth | bool | None = None,
    token: str | None = None,
    mdns: bool | None = None,
    html_file: str | Path | None = None,
    log_dir: str | Path | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """The environment the gateway reads (see the README): ``PORT`` and the ``MARIONETTE_*`` variables, over this
    process's environment and ``env``. Paths are made absolute here, so the gateway's working directory doesn't
    matter. The diagnostics log goes to ``<home>/logs`` (``~/.marionette/logs``) unless ``log_dir`` or
    ``MARIONETTE_LOG_DIR`` says otherwise."""
    out = {**os.environ, **(env or {})}
    out.pop("INIT_CWD", None)
    out["PORT"] = str(int(port))
    if home is not None:
        out["MARIONETTE_HOME"] = str(Path(home).expanduser().resolve())
    if name is not None:
        out["MARIONETTE_NAME"] = name
    if auth is not None:
        out["MARIONETTE_AUTH"] = ("on" if auth else "off") if isinstance(auth, bool) else auth
    if token is not None:
        out["MARIONETTE_TOKEN"] = token
    if mdns is not None:
        out["MARIONETTE_MDNS"] = "on" if mdns else "off"
    if html_file is not None:
        out["MARIONETTE_HTML_FILE"] = str(Path(html_file).expanduser().resolve())
    if log_dir is not None:
        out["MARIONETTE_LOG_DIR"] = str(Path(log_dir).expanduser().resolve())
    elif "MARIONETTE_LOG_DIR" not in out:
        base = Path(out["MARIONETTE_HOME"]) if out.get("MARIONETTE_HOME") else Path.home() / ".marionette"
        out["MARIONETTE_LOG_DIR"] = str(base / "logs")
    return out


class GatewayProcess:
    """A gateway running in the background, started by :func:`start`."""

    def __init__(self, process: subprocess.Popen[str], lines: int = 2000, echo: Callable[[str], None] | None = None) -> None:
        self.process = process
        self.port: int | None = None
        self._lines: collections.deque[str] = collections.deque(maxlen=lines)
        self._echo = echo
        self._ready = threading.Event()
        self._reader = threading.Thread(target=self._read, name="marionette-gateway-log", daemon=True)
        self._reader.start()
        atexit.register(self.stop)

    def _read(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            line = line.rstrip("\n")
            self._lines.append(line)
            if self._echo is not None:
                self._echo(line)
            if self.port is None and (match := _LISTENING.search(line)):
                self.port = int(match.group(1))
                self._ready.set()
        self._ready.set()

    @property
    def pid(self) -> int:
        return self.process.pid

    @property
    def alive(self) -> bool:
        return self.process.poll() is None

    @property
    def log(self) -> str:
        """What the gateway printed (the last 2000 lines): the start line, pairing, joins, calibration, refusals."""
        return "\n".join(self._lines)

    @property
    def url(self) -> str:
        """The WebSocket URL on this computer."""
        return f"ws://127.0.0.1:{self.port}/ws"

    @property
    def http_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def wait_ready(self, timeout: float = 15.0) -> int:
        """Wait until it listens; returns the port. Raises RuntimeError (with its output) if it exits or hangs."""
        if not self._ready.wait(timeout) or self.port is None:
            self.stop()
            raise RuntimeError(f"The gateway didn't start:\n{self.log[-4000:]}")
        return self.port

    def wait(self, timeout: float | None = None) -> int | None:
        """Wait for it to exit; its exit code (None on timeout)."""
        try:
            return self.process.wait(timeout)
        except subprocess.TimeoutExpired:
            return None

    def stop(self, timeout: float = 5.0) -> None:
        """Ask it to stop (it sends the Bonjour goodbye first), and kill it if it doesn't within ``timeout``."""
        atexit.unregister(self.stop)
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self._reader.join(1.0)
        if self.process.stdout is not None:
            self.process.stdout.close()

    def __enter__(self) -> GatewayProcess:
        return self

    def __exit__(self, *_: object) -> None:
        self.stop()


def start(
    port: int = 8787,
    *,
    home: str | Path | None = None,
    name: str | None = None,
    auth: Auth | bool | None = None,
    token: str | None = None,
    mdns: bool | None = None,
    html_file: str | Path | None = None,
    log_dir: str | Path | None = None,
    env: Mapping[str, str] | None = None,
    echo: Callable[[str], None] | None = None,
    ready_timeout: float = 15.0,
) -> GatewayProcess:
    """Start the gateway in the background and wait until it listens. ``port=0`` picks a free port (read it from
    the handle's ``port``). ``echo`` gets every line it prints. Stop it with ``stop()`` (or a ``with`` block)."""
    process = subprocess.Popen(
        [find_node(), str(bundle_path())],
        env=gateway_env(port, home=home, name=name, auth=auth, token=token, mdns=mdns, html_file=html_file, log_dir=log_dir, env=env),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    handle = GatewayProcess(process, echo=echo)
    handle.wait_ready(ready_timeout)
    return handle


def run(
    port: int = 8787,
    *,
    home: str | Path | None = None,
    name: str | None = None,
    auth: Auth | bool | None = None,
    token: str | None = None,
    mdns: bool | None = None,
    html_file: str | Path | None = None,
    log_dir: str | Path | None = None,
    env: Mapping[str, str] | None = None,
) -> int:
    """Run the gateway in the foreground, printing what it prints, until it exits or Ctrl-C; its exit code."""
    process = subprocess.Popen(
        [find_node(), str(bundle_path())],
        env=gateway_env(port, home=home, name=name, auth=auth, token=token, mdns=mdns, html_file=html_file, log_dir=log_dir, env=env),
        stdin=subprocess.DEVNULL,
    )
    try:
        return process.wait()
    except KeyboardInterrupt:
        # The terminal sent the gateway the same Ctrl-C; give it a moment to say goodbye on the network.
        try:
            return process.wait(5)
        except subprocess.TimeoutExpired:
            process.kill()
            return process.wait()


def main(argv: list[str] | None = None) -> int:
    """The ``marionette-gateway`` console script."""
    parser = argparse.ArgumentParser(prog="marionette-gateway", description="Run the Marionette gateway bundled with the Python SDK.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8787)), help="port to listen on (default 8787; 0 picks a free one)")
    parser.add_argument("--name", help="name shown to phones (default: this computer's name)")
    parser.add_argument("--auth", choices=("on", "off", "strict"), help="pairing: on (default; this computer needs no code), off, or strict")
    parser.add_argument("--token", help="a fixed pairing code instead of the saved one")
    parser.add_argument("--no-mdns", action="store_true", help="don't advertise on the local network (Bonjour)")
    parser.add_argument("--html-file", help="the phone screen to show, reloaded whenever it is saved")
    parser.add_argument("--home", help="where the gateway keeps its id and pairing code (default ~/.marionette)")
    parser.add_argument("--log-dir", help="where the diagnostics log goes (default <home>/logs)")
    parser.add_argument("--print-node", action="store_true", help="print the Node executable that would run it, and exit")
    args = parser.parse_args(argv)
    try:
        if args.print_node:
            print(find_node())
            return 0
        return run(
            args.port,
            home=args.home,
            name=args.name,
            auth=args.auth,
            token=args.token,
            mdns=False if args.no_mdns else None,
            html_file=args.html_file,
            log_dir=args.log_dir,
        )
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
