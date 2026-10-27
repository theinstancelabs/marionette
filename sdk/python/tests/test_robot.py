"""RobotLink without a gateway: what it puts in the outbox."""

from __future__ import annotations

import json
import threading
import time
from typing import Any

from marionette import RobotLink


def test_an_older_state_never_overtakes_a_newer_one() -> None:
    link = RobotLink("localhost", "arm")  # never started: the outbox is all there is
    client = link.client
    client.connected = True  # pretend, so the outbox takes messages
    link.state({"stopped": False})
    queue = client.queue
    inside = threading.Event()

    def slow_queue(key: str, message: dict[str, Any], **options: Any) -> bool:
        if threading.current_thread().name == "re-send" and not inside.is_set():
            inside.set()
            time.sleep(0.2)  # the periodic re-send is about to queue what it read; the control thread acts meanwhile
        return queue(key, message, **options)

    client.queue = slow_queue  # type: ignore[method-assign]
    resend = threading.Thread(target=link._send_state, args=(None,), name="re-send")
    resend.start()
    assert inside.wait(2)
    control = threading.Thread(target=link.state, args=({"stopped": True},))  # Stop came on
    control.start()
    resend.join(5)
    control.join(5)
    waiting = [json.loads(data)["state"] for key, data in client._urgent.items() if key == "state:"]
    assert waiting == [{"stopped": True}]
