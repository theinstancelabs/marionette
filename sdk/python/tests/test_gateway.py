"""Running the bundled gateway from Python."""

from __future__ import annotations

import os
import queue
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from marionette import gateway as runner
from marionette.testing import Gateway


def test_the_bundle_ships_with_the_package_and_node_is_found() -> None:
    bundle = runner.bundle_path()
    assert bundle.name == "marionette-gateway.mjs" and bundle.stat().st_size > 100_000
    node = runner.find_node()
    assert runner._node_major(node) >= 20  # type: ignore[operator]
    with pytest.raises(RuntimeError, match="Node 99 or later"):
        runner.find_node(99)


def test_the_environment_it_reads(tmp_path: Path) -> None:
    env = runner.gateway_env(9001, home=tmp_path / "h", name="Lab", auth=False, token="abcd-efgh", mdns=False, html_file="screen.html", env={"INIT_CWD": "/elsewhere"})
    assert env["PORT"] == "9001" and env["MARIONETTE_NAME"] == "Lab" and env["MARIONETTE_AUTH"] == "off" and env["MARIONETTE_MDNS"] == "off"
    assert env["MARIONETTE_HOME"] == str((tmp_path / "h").resolve()) and env["MARIONETTE_LOG_DIR"] == str((tmp_path / "h").resolve() / "logs")
    assert env["MARIONETTE_HTML_FILE"] == str(Path("screen.html").resolve()) and env["MARIONETTE_TOKEN"] == "abcd-efgh"
    assert "INIT_CWD" not in env  # paths are already absolute
    assert runner.gateway_env(auth="strict")["MARIONETTE_AUTH"] == "strict"


def test_start_on_a_free_port_and_restart_on_the_same_one() -> None:
    with Gateway(name="Restart test") as gateway:
        port, session, gateway_id = gateway.port, gateway.session, gateway.health()["gatewayId"]
        assert port > 0 and gateway.health()["name"] == "Restart test"
        assert f"listening on http://0.0.0.0:{port}" in gateway.log
        assert "Pairing is off" in gateway.log
        gateway.restart()
        assert gateway.port == port and gateway.session != session
        assert gateway.health()["gatewayId"] == gateway_id  # same home, same identity
        assert gateway.log.count("listening on") == 2
        logs = list(gateway.log_dir.glob("gateway-*.jsonl"))  # type: ignore[union-attr]
        assert logs
        pid = gateway.pid
    assert pid is not None
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


def test_a_screen_given_as_html() -> None:
    with Gateway(html="<html><body id='given'>Given</body></html>") as gateway:
        config = gateway.get("/api/html-config")
        assert "id='given'" in config["html"] and config["source"] == {"kind": "file"}


def test_without_node_on_path_the_gateway_extra_runs_it(monkeypatch: pytest.MonkeyPatch) -> None:
    executable = pytest.importorskip("nodejs_wheel.executable")
    monkeypatch.setenv("PATH", "/nonexistent")
    monkeypatch.delenv("MARIONETTE_NODE", raising=False)
    assert runner.find_node().startswith(executable.ROOT_DIR)
    with Gateway() as gateway:
        assert gateway.health()["ok"]


def test_a_port_in_use_fails_with_the_gateways_words() -> None:
    with Gateway() as first:
        with pytest.raises(RuntimeError, match="didn't start"):
            runner.start(first.port, mdns=False, auth="off", home=first._dir / "h2", log_dir=first._dir / "l2", ready_timeout=10)  # type: ignore[operator]


PARENTS = {
    "start": "from marionette import gateway; g = gateway.start(0, mdns=False, auth='off', home=sys.argv[1])",
    "testing.Gateway": "from marionette.testing import Gateway; g = Gateway().start()",
}


def _gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def _listening(port: int) -> bool:
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
    except OSError:
        return False
    return True


@pytest.mark.parametrize("how", ["start", "testing.Gateway", "console script"])
@pytest.mark.parametrize("kill", [signal.SIGTERM, signal.SIGKILL], ids=["SIGTERM", "SIGKILL"])
def test_the_gateway_stops_when_the_python_process_that_ran_it_ends(how: str, kill: signal.Signals, tmp_path: Path) -> None:
    if how == "console script":
        command = [sys.executable, "-m", "marionette.gateway", "--port", "0", "--no-mdns", "--auth", "off", "--home", str(tmp_path)]
    else:
        command = [sys.executable, "-c", f"import sys, time\n{PARENTS[how]}\nprint('gateway', g.port, g.pid, flush=True)\ntime.sleep(60)", str(tmp_path)]
    parent = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env={**os.environ, "TMPDIR": str(tmp_path)})
    lines: queue.Queue[str] = queue.Queue()
    threading.Thread(target=lambda: [lines.put(line) for line in parent.stdout], daemon=True).start()  # type: ignore[union-attr]
    try:
        port = pid = None
        while port is None:
            line = lines.get(timeout=20)
            if line.startswith("gateway "):
                port, pid = (int(word) for word in line.split()[1:3])
            elif match := re.search(r"listening on http://0\.0\.0\.0:(\d+)", line):
                port = int(match.group(1))
                pid = int(subprocess.run(["pgrep", "-P", str(parent.pid)], capture_output=True, text=True, check=True).stdout.split()[0])
        assert pid is not None and _listening(port) and not _gone(pid)
        parent.send_signal(kill)
        parent.wait(5)
        started = time.monotonic()
        while not _gone(pid) and time.monotonic() - started < 3:
            time.sleep(0.02)
        took = time.monotonic() - started
        assert _gone(pid) and not _listening(port), f"the gateway outlived its parent ({kill.name}, {how})"
        assert took < 1.5, f"the gateway took {took:.2f} s to stop"
    finally:
        if parent.poll() is None:
            parent.kill()
        if pid is not None and not _gone(pid):
            os.kill(pid, signal.SIGKILL)


FORKED = """import multiprocessing, subprocess, sys, time
from marionette import gateway
g = gateway.start(0, mdns=False, auth='off', home=sys.argv[1])
if sys.argv[2] == 'fork':  # a forked worker, as multiprocessing's fork and process pools make
    worker = multiprocessing.get_context('fork').Process(target=time.sleep, args=(60,), daemon=True)
    worker.start()
    held = worker.pid
else:  # a child that holds the pipe without Python's fork hooks: only the gateway's watch on its parent sees it go
    held = subprocess.Popen(['sleep', '60'], pass_fds=[g.process.stdin.fileno()]).pid
print('gateway', g.port, g.pid, held, flush=True)
time.sleep(60)
"""


@pytest.mark.parametrize("child", ["fork", "pass_fds"])
def test_the_gateway_stops_when_its_parent_is_killed_though_a_child_of_the_parent_lives_on(child: str, tmp_path: Path) -> None:
    parent = subprocess.Popen([sys.executable, "-c", FORKED, str(tmp_path), child], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines: queue.Queue[str] = queue.Queue()
    threading.Thread(target=lambda: [lines.put(line) for line in parent.stdout], daemon=True).start()  # type: ignore[union-attr]
    pids: list[int] = []
    try:
        while not pids:
            line = lines.get(timeout=20)
            if line.startswith("gateway "):
                port, *pids = (int(word) for word in line.split()[1:4])
        gateway_pid, held = pids
        assert _listening(port) and not _gone(gateway_pid)
        parent.send_signal(signal.SIGKILL)
        parent.wait(5)
        started = time.monotonic()
        while not _gone(gateway_pid) and time.monotonic() - started < 4:
            time.sleep(0.02)
        took = time.monotonic() - started
        assert _gone(gateway_pid) and not _listening(port), f"the gateway outlived its parent ({child})"
        assert not _gone(held), "the parent's child should still be running"
        # A forked worker drops its copy of the pipe at once; otherwise the gateway's once-a-second watch notices.
        assert took < (1.5 if child == "fork" else 2.5), f"the gateway took {took:.2f} s to stop"
    finally:
        if parent.poll() is None:
            parent.kill()
        for pid in pids:
            if not _gone(pid):
                os.kill(pid, signal.SIGKILL)


def test_the_console_script() -> None:
    out = subprocess.run([sys.executable, "-m", "marionette.gateway", "--print-node"], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0 and Path(out.stdout.strip()).name.startswith("node")
    out = subprocess.run([sys.executable, "-m", "marionette.gateway", "--help"], capture_output=True, text=True, timeout=30)
    for flag in ("--port", "--name", "--auth", "--no-mdns", "--html-file", "--token", "--home"):
        assert flag in out.stdout
