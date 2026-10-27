#!/usr/bin/env python3
"""Publishes a Marionette gateway's phones on ROS 2 topics.

    pip install websockets           # rclpy comes with your ROS 2 install
    python3 marionette_ros2_bridge.py --gateway 192.168.1.20
    python3 marionette_ros2_bridge.py --gateway 192.168.1.20 --dry-run   # no ROS needed; prints instead

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
from typing import Any, Callable

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


async def run(url: str, publish: Callable[[Publish], None], topics: Topics | None = None) -> None:
    import websockets

    topics = topics or Topics()
    delay = 1.0
    while True:
        reason = "the gateway closed the connection"
        try:
            async with websockets.connect(url, max_size=4 * 1024 * 1024, open_timeout=5, ping_interval=5, ping_timeout=5) as ws:
                # A console that only listens; it has no use for camera frames.
                await ws.send(json.dumps({"type": "hello", "version": 1, "role": "console", "cameras": False}))
                print(f"connected to {url}", file=sys.stderr, flush=True)
                delay = 1.0
                async for raw in ws:
                    try:
                        items = topics.handle(json.loads(raw))
                    except (ValueError, KeyError, TypeError) as error:
                        print(f"skipped a message the bridge could not read ({error!r})", file=sys.stderr, flush=True)
                        continue
                    for item in items:
                        publish(item)
        # asyncio.TimeoutError is not an OSError before Python 3.11 (ROS 2 Humble runs 3.10).
        except (OSError, asyncio.TimeoutError, websockets.WebSocketException) as error:
            reason = str(error) or type(error).__name__
        for item in topics.gateway_lost():
            publish(item)
        print(f"gateway unavailable ({reason}); retrying in {delay:.0f} s", file=sys.stderr, flush=True)
        await asyncio.sleep(delay)
        delay = min(delay * 2, 10.0)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--gateway", default="localhost", help="gateway address: IP, host:port or ws:// URL (default localhost:8787)")
    parser.add_argument("--dry-run", action="store_true", help="print what would be published instead of using ROS 2")
    parser.add_argument("--quiet-poses", action="store_true", help="with --dry-run, leave poses out of the printout")
    args = parser.parse_args()
    try:
        url = gateway_url(args.gateway)
    except ValueError as error:
        parser.error(str(error))
    if args.dry_run:
        publish, close = print_publisher(args.quiet_poses), (lambda: None)
    else:
        publish, close = ros_publisher()
    try:
        asyncio.run(run(url, publish))
    except KeyboardInterrupt:
        pass
    finally:
        close()


if __name__ == "__main__":
    main()
