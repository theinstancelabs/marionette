"""Addresses and pairing links read exactly as the app reads them (the cases mirror packages/protocol's tests)."""

import pytest

from marionette import format_code, gateway_url, normalize_code, parse_pairing_link
from marionette.address import PairingLink, resolve


def test_addresses_like_the_app() -> None:
    assert gateway_url("10.1.10.120") == "ws://10.1.10.120:8787/ws"
    assert gateway_url(" 10.1.10.120:9000 ") == "ws://10.1.10.120:9000/ws"
    assert gateway_url("ws://10.1.10.120:8787/ws") == "ws://10.1.10.120:8787/ws"
    assert gateway_url("http://My-Mac.local:8787/") == "ws://my-mac.local:8787/ws"
    assert gateway_url("https://gw.example.com") == "wss://gw.example.com:8787/ws"
    assert gateway_url("[::1]:8787") == "ws://[::1]:8787/ws"
    assert gateway_url("ws://host:8787/custom") == "ws://host:8787/custom"
    assert gateway_url("localhost:18787") == "ws://localhost:18787/ws"


@pytest.mark.parametrize("bad", ["", "   ", "ftp://host", "host:99999", "host:0", "two words", "http://"])
def test_anything_else_is_refused_with_a_reason(bad: str) -> None:
    with pytest.raises(ValueError, match="address|port"):
        gateway_url(bad)


def test_pairing_links() -> None:
    link = "marionette://pair?v=1&host=192.168.1.20,100.64.0.5&port=8787&code=K7Q2M9XD&id=gw-ab12&name=Axol%20lab"
    assert parse_pairing_link(link) == PairingLink(("192.168.1.20", "100.64.0.5"), 8787, "K7Q2M9XD", "gw-ab12", "Axol lab")
    assert parse_pairing_link("marionette://pair?host=robot.local") == PairingLink(("robot.local",), 8787)
    assert parse_pairing_link("MARIONETTE://pair/?host=a&port=9000&name=a+b") == PairingLink(("a",), 9000, name="a b")
    assert parse_pairing_link("marionette://pair?host=a&code=k7q2-m9xd").code == "K7Q2M9XD"  # type: ignore[union-attr]
    for bad in ("https://example.com", "marionette://pair?host=;rm&port=1", "marionette://pair?host=a&port=0", "marionette://pair?host=a&port=x",
                "marionette://pair?host=a&name=%E0%A4%A", "marionette://pair?port=8787"):
        assert parse_pairing_link(bad) is None, bad


def test_a_pairing_link_resolves_to_every_host_and_its_code() -> None:
    target = resolve("marionette://pair?v=1&host=10.0.0.2,100.64.0.9&port=9001&code=ABCD-EFGH&id=gw-x")
    assert target.urls == ["ws://10.0.0.2:9001/ws", "ws://100.64.0.9:9001/ws"]
    assert (target.token, target.gateway_id) == ("ABCDEFGH", "gw-x")
    assert resolve("robot.local").urls == ["ws://robot.local:8787/ws"]
    assert resolve("robot.local").token is None


def test_codes_compare_like_the_gateway() -> None:
    assert normalize_code(" k7q2-m9xd ") == "K7Q2M9XD"
    assert normalize_code("oil") == "011"
    assert format_code("k7q2m9xd") == "K7Q2-M9XD"
    assert format_code("abc") == "ABC"
