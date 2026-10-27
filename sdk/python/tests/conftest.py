import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from marionette.testing import Gateway  # noqa: E402


@pytest.fixture
def gateway() -> Iterator[Gateway]:
    """The real bundled gateway on a free port (pairing and Bonjour off, a temporary home)."""
    with Gateway() as running:
        yield running
