"""A gateway's pairing details, for a robot that shows its gateway's QR code on its own page or display.

A phone pairs by scanning the gateway's QR code, a pairing link. :func:`fetch_pairing` reads it, with the pairing
code and the addresses, from the gateway's ``GET /api/pairing``. The gateway answers its own computer without the
code (unless pairing is strict), so a robot beside its gateway needs only the address. A gateway on another computer
needs the code: give its pairing link, which carries it, or ``token=``.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, get_args
from urllib.parse import urlsplit, urlunsplit

from .address import normalize_code, parse_pairing_link, resolve
from .gateway import Auth

# A gateway is reached directly, whatever proxy the environment names (as GatewayClient does).
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class PairingError(Exception):
    """The pairing details couldn't be read. The message is a sentence for an operator; ``status`` is the gateway's
    HTTP status (401: it needs the code, or refused it; 404: it is too old to pair phones), or None when no host
    answered or the answer wasn't understood."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Pairing:
    """What ``GET /api/pairing`` answers: the gateway's id and name, its pairing mode, its code (``K7Q2-M9XD``; None
    when pairing is off), the addresses and port its link lists, the pairing link, and the link's QR code as SVG."""

    gateway_id: str
    name: str
    auth: Auth
    code: str | None
    addresses: tuple[str, ...]
    port: int
    url: str
    qr_svg: str

    @classmethod
    def from_json(cls, body: Any) -> Pairing:
        """Reads the gateway's answer, checked: the link must be a pairing link and the QR code an SVG (a page can
        then show it as an image). Raises :class:`PairingError` otherwise."""
        if not isinstance(body, dict):
            raise PairingError("The gateway's pairing details weren't understood.")
        gateway_id, name, auth, code = body.get("gatewayId"), body.get("name"), body.get("auth"), body.get("code")
        addresses, port, url, svg = body.get("addresses"), body.get("port"), body.get("url"), body.get("qrSvg")
        if not (
            isinstance(gateway_id, str)
            and isinstance(name, str)
            and auth in get_args(Auth)
            and (code is None or isinstance(code, str))
            and isinstance(addresses, list)
            and all(isinstance(address, str) for address in addresses)
            and isinstance(port, int)
            and not isinstance(port, bool)
            and isinstance(url, str)
            and parse_pairing_link(url) is not None
            and isinstance(svg, str)
            and svg.lstrip().startswith("<svg")
        ):
            raise PairingError("The gateway's pairing details weren't understood.")
        return cls(gateway_id, name, auth, code or None, tuple(addresses), port, url, svg)

    def to_json(self) -> dict[str, Any]:
        """The gateway's own JSON (camelCase, no ``code`` when pairing is off), to pass on to a web page."""
        return {
            "gatewayId": self.gateway_id,
            "name": self.name,
            "auth": self.auth,
            **({"code": self.code} if self.code else {}),
            "addresses": list(self.addresses),
            "port": self.port,
            "url": self.url,
            "qrSvg": self.qr_svg,
        }


def _pairing_url(ws_url: str) -> str:
    parts = urlsplit(ws_url)
    return urlunsplit(("https" if parts.scheme == "wss" else "http", parts.netloc, "/api/pairing", "", ""))


def fetch_pairing(address: str, *, token: str | None = None, timeout: float = 2.0) -> Pairing:
    """The pairing details of the gateway at ``address``, in any form :class:`GatewayClient` takes: an IP or host,
    ``host:port``, a URL, or a pairing link, whose hosts are tried in turn and whose code is sent unless ``token`` is
    given. ``timeout`` is per host.

    Blocking: from asyncio, run it in a thread (``await asyncio.to_thread(fetch_pairing, address)``). Raises
    :class:`PairingError`.
    """
    try:
        target = resolve(address)
    except ValueError as exc:
        raise PairingError(str(exc)) from exc
    code = token if token is not None else target.token
    error = PairingError(f"Can't reach the gateway at {address}.")
    for url in target.urls:
        request = urllib.request.Request(_pairing_url(url), headers={"Accept": "application/json"})
        if code:
            request.add_header("Authorization", f"Bearer {normalize_code(code)}")
        try:
            with _OPENER.open(request, timeout=timeout) as response:
                body = json.load(response)
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                raise PairingError(
                    f"The gateway at {address} refused the pairing code: check it, or wait a minute after several "
                    "wrong ones."
                    if code
                    else f"The gateway at {address} needs its pairing code: give its pairing link, which carries it.",
                    401,
                ) from exc
            if exc.code == 404:
                raise PairingError(f"The gateway at {address} is too old to pair phones: update Marionette.", 404) from exc
            error = PairingError(f"The gateway at {address} answered with an error ({exc.code}).", exc.code)
            continue
        except (OSError, ValueError):
            continue  # the next of a pairing link's hosts, if any
        return Pairing.from_json(body)
    raise error
