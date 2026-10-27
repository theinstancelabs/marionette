"""Gateway addresses and pairing links, read the way the iPhone app reads them.

An operator types an address however they like (``192.168.1.20``, ``robot.local:9000``, ``http://10.0.0.2/``) or
scans the gateway's QR code, which holds a pairing link (``marionette://pair?v=1&host=a,b&port=8787&code=…``).
These functions turn either into WebSocket URLs, with exactly the rules of ``gatewayUrl`` and ``parsePairingLink`` in
``packages/protocol``, so an address that works in the app works here too.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import unquote

DEFAULT_PORT = 8787

_ADDRESS = re.compile(
    r"^(?:(wss?|https?)://)?(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?(/\S*)?$",
    re.IGNORECASE,
)
_HOST = re.compile(r"^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$", re.IGNORECASE)
_LINK = re.compile(r"^marionette://pair/?\?(.*)$", re.IGNORECASE | re.DOTALL)
_BAD_ESCAPE = re.compile(r"%(?![0-9a-fA-F]{2})")
_PORT = re.compile(r"^\s*\d+(\.0*)?\s*$")


def gateway_url(address: str) -> str:
    """The gateway WebSocket URL for an address as an operator types it.

    Accepts an IP or host name, ``host:port``, or a ``ws://``, ``wss://``, ``http://`` or ``https://`` URL. The
    port defaults to 8787 and the path to ``/ws``; ``https``/``wss`` stay secure. Raises :class:`ValueError` for
    anything else, with a message an operator can act on.
    """
    match = _ADDRESS.match(address.strip())
    if not match:
        raise ValueError(f"{address!r} is not a gateway address: type an IP such as 192.168.1.20, or host:port")
    scheme, host, port, path = match.groups()
    number = int(port) if port else DEFAULT_PORT
    if not 1 <= number <= 65535:
        raise ValueError(f"{address!r} has an invalid port")
    secure = (scheme or "ws").lower() in ("wss", "https")
    return f"{'wss' if secure else 'ws'}://{host.lower()}:{number}{'/ws' if not path or path == '/' else path}"


def normalize_code(code: str) -> str:
    """A pairing code as the gateway compares it: case, spaces and dashes don't matter, O reads as 0, I and L as 1."""
    return re.sub(r"[\s-]", "", code.upper()).replace("O", "0").replace("I", "1").replace("L", "1")


def format_code(code: str) -> str:
    """``K7Q2M9XD`` → ``K7Q2-M9XD``, the way the gateway prints it."""
    normalized = normalize_code(code)
    return f"{normalized[:4]}-{normalized[4:]}" if len(normalized) == 8 else normalized


@dataclass(frozen=True)
class PairingLink:
    """What a gateway's pairing QR code holds: every address it may be reached at, its port, the pairing code
    (None when pairing is off), its stable id and its name."""

    hosts: tuple[str, ...]
    port: int = DEFAULT_PORT
    code: str | None = None
    gateway_id: str | None = None
    name: str | None = None

    @property
    def urls(self) -> list[str]:
        """A WebSocket URL per host, in the order the gateway listed them (LAN first, then tailnet)."""
        return [f"ws://{host.lower()}:{self.port}/ws" for host in self.hosts]


def parse_pairing_link(text: str) -> PairingLink | None:
    """Reads a ``marionette://pair?…`` link; None if ``text`` isn't one (or is malformed)."""
    match = _LINK.match(text.strip())
    if not match:
        return None
    params: dict[str, str] = {}
    for part in match.group(1).split("&"):
        at = part.find("=")
        if at <= 0:
            continue
        raw = part[at + 1 :].replace("+", " ")
        # decodeURIComponent refuses a stray % or bytes that aren't UTF-8, and so does the app.
        if _BAD_ESCAPE.search(raw):
            return None
        try:
            params[part[:at]] = unquote(raw, errors="strict")
        except UnicodeDecodeError:
            return None
    hosts = tuple(host for host in (h.strip() for h in params.get("host", "").split(",")) if _HOST.match(host))[:8]
    port_text = params.get("port")
    if port_text is None:
        port = DEFAULT_PORT
    elif _PORT.match(port_text):
        port = int(float(port_text))
    else:
        return None
    if not hosts or not 1 <= port <= 65535:
        return None
    code = normalize_code(params["code"]) if params.get("code") else None
    return PairingLink(
        hosts=hosts,
        port=port,
        code=code if code and len(code) <= 64 else None,
        gateway_id=params["id"] if params.get("id") and len(params["id"]) <= 64 else None,
        name=params["name"][:64] if params.get("name") else None,
    )


@dataclass(frozen=True)
class Target:
    """Where to connect: one URL for a typed address, or one per host for a pairing link, and the code it carries."""

    urls: list[str] = field(default_factory=list)
    token: str | None = None
    gateway_id: str | None = None
    name: str | None = None


def resolve(address: str) -> Target:
    """A typed address or a pairing link, as URLs to try in order and the pairing code (if the link has one)."""
    link = parse_pairing_link(address)
    if link is not None:
        return Target(urls=link.urls, token=link.code, gateway_id=link.gateway_id, name=link.name)
    return Target(urls=[gateway_url(address)])
