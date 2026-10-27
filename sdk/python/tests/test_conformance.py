"""Runs every tracker conformance fixture in sdk/conformance/tracker (both SDKs run the same files).

A fixture is ``{name, description, options: {mirror, stop_action}, steps: [...]}``. Steps: ``{"message": …}`` folds a
gateway message in, ``{"advance": seconds}`` moves the clock (it starts at 1000.0), ``{"lost": true}`` and
``{"clear_stale_stops": true}`` call those, and ``{"expect": {"phones": {id: partial}, "absent": [ids],
"any_stop": bool}}`` checks ``Phone.to_conformance()`` (dicts match partially and recursively: only the keys a
fixture names are compared). ``MARIONETTE_CONFORMANCE_DIR`` (paths separated by ``:``) adds more folders.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any

import pytest

from marionette import PhoneTracker

FOLDER = Path(__file__).resolve().parents[2] / "conformance" / "tracker"
FOLDERS = [FOLDER] + [Path(p) for p in os.environ.get("MARIONETTE_CONFORMANCE_DIR", "").split(":") if p]
FIXTURES = sorted({path for folder in FOLDERS for path in folder.glob("*.json")}, key=lambda p: p.name)


def mismatches(expected: Any, actual: Any, where: str = "") -> list[str]:
    """Where ``actual`` differs from ``expected``: dicts partially, lists element by element, numbers to 1e-9."""
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return [f"{where or '.'}: expected an object, got {actual!r}"]
        found: list[str] = []
        for key, value in expected.items():
            if key not in actual:
                found.append(f"{where}.{key}: missing (expected {value!r})")
            else:
                found += mismatches(value, actual[key], f"{where}.{key}")
        return found
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            return [f"{where}: expected {expected!r}, got {actual!r}"]
        return [m for i, (e, a) in enumerate(zip(expected, actual, strict=True)) for m in mismatches(e, a, f"{where}[{i}]")]
    if isinstance(expected, bool) or expected is None or isinstance(actual, bool):
        return [] if expected is actual or expected == actual and type(expected) is type(actual) else [f"{where}: expected {expected!r}, got {actual!r}"]
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return [] if math.isclose(expected, actual, rel_tol=1e-9, abs_tol=1e-9) else [f"{where}: expected {expected!r}, got {actual!r}"]
    return [] if expected == actual else [f"{where}: expected {expected!r}, got {actual!r}"]


def run(fixture: dict[str, Any]) -> list[str]:
    """Plays a fixture; returns what didn't match (empty when it passes)."""
    clock = {"now": 1000.0}
    options = fixture.get("options") or {}
    tracker = PhoneTracker(lambda: clock["now"], mirror=options.get("mirror", "stop-only"), stop_action=options.get("stop_action", "safety.estop"))
    failures: list[str] = []
    for index, step in enumerate(fixture["steps"]):
        if "message" in step:
            tracker.apply(step["message"])
        elif "advance" in step:
            clock["now"] += float(step["advance"])
        elif step.get("lost"):
            tracker.lost_gateway()
        elif step.get("clear_stale_stops"):
            tracker.clear_stale_stops()
        elif "expect" in step:
            expect = step["expect"]
            phones = tracker.snapshot()
            label = f"step {index}{' (' + step['note'] + ')' if 'note' in step else ''}"
            for phone_id, partial in (expect.get("phones") or {}).items():
                if phone_id not in phones:
                    failures.append(f"{label}: no phone {phone_id!r} (have {sorted(phones)})")
                    continue
                failures += [f"{label}: {phone_id}{m}" for m in mismatches(partial, phones[phone_id].to_conformance())]
            for phone_id in expect.get("absent") or []:
                if phone_id in phones:
                    failures.append(f"{label}: {phone_id!r} should be absent")
            if "any_stop" in expect and tracker.any_stop() != expect["any_stop"]:
                failures.append(f"{label}: any_stop should be {expect['any_stop']}")
    return failures


def test_there_are_python_fixtures() -> None:
    assert len([p for p in FIXTURES if p.name.startswith("py-")]) >= 10


@pytest.mark.parametrize("path", FIXTURES, ids=[p.name for p in FIXTURES])
def test_fixture(path: Path) -> None:
    fixture = json.loads(path.read_text())
    failures = run(fixture)
    assert not failures, f"{fixture['name']}:\n  " + "\n  ".join(failures)


def test_the_matcher_is_partial_and_strict_about_types() -> None:
    assert mismatches({"a": {"b": 1}}, {"a": {"b": 1.0, "c": 2}, "d": 3}) == []
    assert mismatches({"a": True}, {"a": 1}) != []
    assert mismatches({"pose": None}, {"pose": {"session": "s"}}) != []
    assert mismatches({"v": [1, {"x": 0}]}, {"v": [1, {"x": 0, "y": 0}]}) == []
    assert mismatches({"v": [1]}, {"v": [1, 2]}) != []
    assert mismatches({"missing": 1}, {}) != []
