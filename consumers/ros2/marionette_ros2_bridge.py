#!/usr/bin/env python3
"""Publishes a Marionette gateway's phones on ROS 2 topics.

    pip install websockets           # rclpy comes with your ROS 2 install
    python3 marionette_ros2_bridge.py --gateway 192.168.1.20 --token K7Q2-M9XD
    python3 marionette_ros2_bridge.py --gateway "marionette://pair?v=1&host=…"   # the gateway's pairing link
    python3 marionette_ros2_bridge.py --gateway localhost --dry-run   # no ROS needed; prints instead

From another computer the gateway needs its pairing code: `--token`, or the pairing link it prints, which carries
the code and every address it can be reached at. On the gateway's own computer it needs none.

It connects as a console, so it only listens: Marionette relays poses and button
presses and decides nothing. Stopping, scaling and what each button means are up
to whatever subscribes. Topics are listed in `marionette_topics.py`.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import threading
from typing import Any, Callable, List, Optional, Tuple
from urllib.parse import unquote

from marionette_topics import Publish, Topics

DEFAULT_PORT = 8787
_ADDRESS = re.compile(r"^(?:(wss?|https?)://)?(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?(/\S*)?$", re.IGNORECASE)


def gateway_url(address: str) -> str:
    """The gateway WebSocket URL for an address typed the way the app and viewer accept it:
    an IP or host name, host:port, or a ws://, wss://, http:// or https:// URL. The port
    defaults to 8787 and the path to /ws."""
    match = _ADDRESS.match(address.strip())
    if not match or not 1 <= int(match.group(3) or DEFAULT_PORT) <= 65535:
        raise ValueError(f"not a gateway address: {address!r}")
    scheme, host, port, path = match.groups()
    secure = (scheme or "ws").lower() in ("wss", "https")
    return f"{'wss' if secure else 'ws'}://{host.lower()}:{int(port or DEFAULT_PORT)}{'/ws' if not path or path == '/' else path}"


_HOST = re.compile(r"^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$", re.IGNORECASE)
PAIRING_REQUIRED = 4401


def normalize_code(code: str) -> str:
    """A pairing code as the gateway compares it: case, spaces and dashes don't matter, O reads as 0, I and L as 1."""
    return re.sub(r"[\s-]", "", code.upper()).replace("O", "0").replace("I", "1").replace("L", "1")


def gateway_targets(address: str, token: Optional[str] = None) -> Tuple[List[str], Optional[str]]:
    """The URLs to try and the pairing code, for a typed address or a pairing link
    (`marionette://pair?v=1&host=a,b&port=8787&code=…`, read the way the app reads it). A link's hosts are tried
    in turn; `token` wins over the link's code."""
    match = re.match(r"^marionette://pair/?\?(.*)$", address.strip(), re.IGNORECASE)
    if not match:
        return [gateway_url(address)], normalize_code(token) if token else None
    params = {}
    for part in match.group(1).split("&"):
        key, equals, value = part.partition("=")
        if key and equals:
            params[key] = unquote(value.replace("+", " "))
    hosts = [host.strip() for host in params.get("host", "").split(",") if _HOST.match(host.strip())][:8]
    try:
        port = int(params.get("port", DEFAULT_PORT))
    except ValueError:
        port = 0
    if not hosts or not 1 <= port <= 65535:
        raise ValueError(f"not a usable pairing link: {address!r}")
    code = token or params.get("code")
    return [f"ws://{host.lower()}:{port}/ws" for host in hosts], normalize_code(code) if code else None


def hello(token: Optional[str] = None) -> dict:
    """A console that only listens; it has no use for camera frames."""
    message = {"type": "hello", "version": 1, "role": "console", "cameras": False}
    if token:
        message["token"] = token
    return message


def ros_publisher() -> tuple[Callable[[Publish], None], Callable[[], None]]:
    import rclpy
    from geometry_msgs.msg import PoseStamped
    from rclpy.executors import SingleThreadedExecutor
    from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
    from std_msgs.msg import String

    try:  # Humble and later: leave Ctrl-C to Python so the bridge shuts down in order.
        from rclpy.signals import SignalHandlerOptions
        rclpy.init(signal_handler_options=SignalHandlerOptions.NO)
    except ImportError:
        rclpy.init()
    node = rclpy.create_node("marionette_bridge")
    # Reliable publishers match both reliable (the rclpy/rclcpp default) and best-effort subscribers.
    stream = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
    events = QoSProfile(depth=100, reliability=ReliabilityPolicy.RELIABLE)
    latched = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE, durability=DurabilityPolicy.TRANSIENT_LOCAL)
    publishers: dict[str, Any] = {}

    def publisher(item: Publish):
        if item.topic not in publishers:
            kind = PoseStamped if item.kind == "pose" else String
            publishers[item.topic] = node.create_publisher(kind, item.topic, latched if item.latched else stream if item.kind == "pose" else events)
        return publishers[item.topic]

    def publish(item: Publish):
        if item.kind == "pose":
            msg = PoseStamped()
            msg.header.stamp = node.get_clock().now().to_msg()
            msg.header.frame_id = item.payload["frame_id"]
            for axis in "xyz":
                setattr(msg.pose.position, axis, float(item.payload["position"][axis]))
            for axis in "xyzw":
                setattr(msg.pose.orientation, axis, float(item.payload["orientation"][axis]))
        else:
            msg = String(data=item.json())
        publisher(item).publish(msg)

    # Spinning only serves the node's own services (parameters); publishing happens on the asyncio thread.
    executor = SingleThreadedExecutor()
    executor.add_node(node)
    spinner = threading.Thread(target=executor.spin, daemon=True)
    spinner.start()

    def close():
        executor.shutdown()
        spinner.join(timeout=2)
        node.destroy_node()
        try:
            rclpy.try_shutdown()
        except AttributeError:  # Foxy
            if rclpy.ok():
                rclpy.shutdown()

    return publish, close


def print_publisher(skip_poses: bool) -> Callable[[Publish], None]:
    def publish(item: Publish):
        if skip_poses and item.kind == "pose":
            return
        print(f"{item.topic}  {item.json()}", flush=True)
    return publish


async def run(urls: "str | List[str]", publish: Callable[[Publish], None], topics: Topics | None = None, token: Optional[str] = None) -> None:
    import websockets

    topics = topics or Topics()
    urls = [urls] if isinstance(urls, str) else list(urls)
    delay, attempt = 1.0, 0
    while True:
        url = urls[attempt % len(urls)]
        reason, code = "the gateway closed the connection", None
        try:
            async with websockets.connect(url, max_size=4 * 1024 * 1024, open_timeout=5, ping_interval=5, ping_timeout=5) as ws:
                await ws.send(json.dumps(hello(token)))
                connected = False
                try:
                    async for raw in ws:
                        if not connected:
                            # The gateway says nothing to a client it refuses, so the first message means we're in.
                            print(f"connected to {url}", file=sys.stderr, flush=True)
                            connected, delay = True, 1.0
                        try:
                            items = topics.handle(json.loads(raw))
                        except (ValueError, KeyError, TypeError) as error:
                            print(f"skipped a message the bridge could not read ({error!r})", file=sys.stderr, flush=True)
                            continue
                        for item in items:
                            publish(item)
                finally:
                    code = getattr(ws, "close_code", None)
        # asyncio.TimeoutError is not an OSError before Python 3.11 (ROS 2 Humble runs 3.10).
        except (OSError, asyncio.TimeoutError, websockets.WebSocketException) as error:
            reason = str(error) or type(error).__name__
            code = code or getattr(getattr(error, "rcvd", None), "code", None)
        for item in topics.gateway_lost():
            publish(item)
        wait = delay
        if code == PAIRING_REQUIRED:
            # Five wrong codes a minute shut an address out for a minute, so retry slowly.
            reason, wait = "pairing code missing or wrong: pass --token with the code the gateway prints, or its pairing link", 15.0
        else:
            delay = min(delay * 2, 10.0)
        attempt += 1
        print(f"gateway unavailable at {url} ({reason}); retrying in {wait:.0f} s", file=sys.stderr, flush=True)
        await asyncio.sleep(wait)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--gateway", default="localhost", help="gateway address (IP, host:port or ws:// URL; default localhost:8787) or its pairing link")
    parser.add_argument("--token", help="the gateway's pairing code (needed from another computer, unless the pairing link has it)")
    parser.add_argument("--dry-run", action="store_true", help="print what would be published instead of using ROS 2")
    parser.add_argument("--quiet-poses", action="store_true", help="with --dry-run, leave poses out of the printout")
    args = parser.parse_args()
    try:
        urls, token = gateway_targets(args.gateway, args.token)
    except ValueError as error:
        parser.error(str(error))
    if args.dry_run:
        publish, close = print_publisher(args.quiet_poses), (lambda: None)
    else:
        publish, close = ros_publisher()
    try:
        asyncio.run(run(urls, publish, token=token))
    except KeyboardInterrupt:
        pass
    finally:
        close()


if __name__ == "__main__":
    main()
