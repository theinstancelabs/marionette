"""Running the bundled gateway from Python."""

from __future__ import annotations

import os
import subprocess
import sys
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


def test_the_console_script() -> None:
    out = subprocess.run([sys.executable, "-m", "marionette.gateway", "--print-node"], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0 and Path(out.stdout.strip()).name.startswith("node")
    out = subprocess.run([sys.executable, "-m", "marionette.gateway", "--help"], capture_output=True, text=True, timeout=30)
    for flag in ("--port", "--name", "--auth", "--no-mdns", "--html-file", "--token", "--home"):
        assert flag in out.stdout
