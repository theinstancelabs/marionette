"""Test tools: gateway message builders, the real gateway on a free port, and scriptable phones.

- :mod:`marionette.testing.msg` builds the messages a gateway sends (``msg.config``, ``msg.pose``, ``msg.input``, …),
  for unit tests of anything that reads them (a :class:`~marionette.PhoneTracker`, your own code).
- :class:`Gateway` runs the bundled gateway on a free port with pairing and Bonjour off and a temporary home, as a
  context manager (``with`` or ``async with``); ``restart()`` gives a new gateway session on the same port.
- :class:`SimPhone` (blocking) and :class:`AsyncSimPhone` (asyncio) are phones that talk to it like the app:
  hello, ARKit poses at 60 Hz from operator-frame moves, presses with their repeats, drags, calibration, reconnects.
"""

from . import msg
from .gateway import Gateway
from .phone import AsyncSimPhone, CalibrationRefused, SimPhone

__all__ = ["msg", "Gateway", "SimPhone", "AsyncSimPhone", "CalibrationRefused", "wait_until"]


def wait_until(predicate, timeout: float = 5.0, what: str = "a condition", interval: float = 0.005):  # type: ignore[no-untyped-def]
    """Poll ``predicate()`` until it is truthy (returns its value) or raise TimeoutError after ``timeout`` seconds."""
    import time

    deadline = time.monotonic() + timeout
    while True:
        result = predicate()
        if result:
            return result
        if time.monotonic() > deadline:
            raise TimeoutError(f"timed out after {timeout} s waiting for {what}")
        time.sleep(interval)
