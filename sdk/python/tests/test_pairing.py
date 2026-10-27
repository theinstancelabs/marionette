"""fetch_pairing against the real gateway (every pairing mode), and against answers a gateway shouldn't give."""

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from marionette import Pairing, PairingError, fetch_pairing, parse_pairing_link
from marionette.testing import Gateway


def test_reads_the_gateway_on_its_own_computer_without_the_code() -> None:
    with Gateway(auth="on", token="K7Q2M9XD", name="Axol lab") as gateway:
        pairing = fetch_pairing(gateway.address)
        served = gateway.get("/api/pairing")
    assert (pairing.name, pairing.auth, pairing.code) == ("Axol lab", "on", "K7Q2-M9XD")
    assert (pairing.addresses, pairing.port) == (("127.0.0.1",), gateway.port)
    link = parse_pairing_link(pairing.url)
    assert link is not None and (link.code, link.gateway_id) == ("K7Q2M9XD", pairing.gateway_id)
    assert pairing.qr_svg.startswith("<svg")
    assert pairing.to_json() == served


def test_pairing_off_has_no_code() -> None:
    with Gateway() as gateway:
        pairing = fetch_pairing(gateway.address)
    assert (pairing.auth, pairing.code) == ("off", None)
    assert "code" not in pairing.to_json()


def test_a_strict_gateway_needs_the_code() -> None:
    with Gateway(auth="strict", token="K7Q2M9XD") as gateway:
        with pytest.raises(PairingError, match="needs its pairing code") as needs:
            fetch_pairing(gateway.address)
        link = f"marionette://pair?v=1&host=127.0.0.1&port={gateway.port}&code=K7Q2M9XD"
        assert fetch_pairing(link).code == "K7Q2-M9XD"
        assert fetch_pairing(gateway.address, token="k7q2 m9xd").code == "K7Q2-M9XD"
        with pytest.raises(PairingError, match="refused the pairing code") as refused:
            fetch_pairing(gateway.address, token="AAAA-AAAA")
    assert needs.value.status == refused.value.status == 401


def test_a_pairing_links_hosts_are_tried_in_turn() -> None:
    with Gateway() as gateway:
        pairing = fetch_pairing(f"marionette://pair?v=1&host=nowhere.invalid,127.0.0.1&port={gateway.port}")
    assert pairing.port == gateway.port


def test_no_gateway_or_no_address() -> None:
    with pytest.raises(PairingError, match=r"^Can't reach the gateway at 127.0.0.1:1\.$") as away:
        fetch_pairing("127.0.0.1:1")
    assert away.value.status is None
    with pytest.raises(PairingError, match="not a gateway address"):
        fetch_pairing("two words")


@pytest.fixture
def answer() -> Iterator[tuple[list[tuple[int, str]], str]]:
    """A server that answers /api/pairing with whatever the test puts in the list (status, body), then its address."""
    answers: list[tuple[int, str]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            status, body = answers.pop(0)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body.encode())

        def log_message(self, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield answers, f"127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


GOOD = {
    "gatewayId": "gw-ab12",
    "name": "Axol lab",
    "auth": "on",
    "code": "K7Q2-M9XD",
    "addresses": ["10.1.10.220"],
    "port": 8787,
    "url": "marionette://pair?v=1&host=10.1.10.220&port=8787&code=K7Q2M9XD&id=gw-ab12",
    "qrSvg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
}


def test_an_old_gateway_or_a_failing_one(answer: tuple[list[tuple[int, str]], str]) -> None:
    answers, address = answer
    answers += [(404, "Not found"), (500, "boom")]
    with pytest.raises(PairingError, match="too old to pair phones") as old:
        fetch_pairing(address)
    with pytest.raises(PairingError, match=r"answered with an error \(500\)") as failing:
        fetch_pairing(address)
    assert (old.value.status, failing.value.status) == (404, 500)


@pytest.mark.parametrize(
    "body",
    [
        [],
        {**GOOD, "qrSvg": "<script>alert(1)</script>"},
        {**GOOD, "url": "https://example.com"},
        {**GOOD, "auth": "maybe"},
        {**GOOD, "port": "8787"},
        {key: value for key, value in GOOD.items() if key != "gatewayId"},
    ],
)
def test_only_a_pairing_link_and_its_svg_are_taken(answer: tuple[list[tuple[int, str]], str], body: object) -> None:
    answers, address = answer
    answers.append((200, json.dumps(body)))
    with pytest.raises(PairingError, match="weren't understood"):
        fetch_pairing(address)


def test_the_gateways_json_round_trips() -> None:
    assert Pairing.from_json(GOOD).to_json() == GOOD
    assert Pairing.from_json({**GOOD, "code": "", "auth": "off"}).code is None
