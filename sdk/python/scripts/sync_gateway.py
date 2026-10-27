#!/usr/bin/env python3
"""Rebuilds the gateway bundle and copies it into the Python package.

    python3 sdk/python/scripts/sync_gateway.py           # from anywhere in the repository

The copy (``src/marionette/_gateway/marionette-gateway.mjs``) is committed, so a robot that installs the SDK
from git gets a working gateway without Node tooling or this repository's ``node_modules``. Run this after
changing the gateway, the protocol or the screen kit, and commit the result with that change.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
BUNDLE = REPO / "apps" / "backend" / "dist" / "marionette-gateway.mjs"
TARGET = HERE.parent / "src" / "marionette" / "_gateway" / "marionette-gateway.mjs"


def main() -> int:
    if not (REPO / "node_modules").is_dir():
        print("Run `npm install` at the repository root first.", file=sys.stderr)
        return 1
    npm = shutil.which("npm")
    if npm is None:
        print("npm is not on PATH.", file=sys.stderr)
        return 1
    subprocess.run([npm, "--workspace", "@marionette/backend", "run", "bundle"], cwd=REPO, check=True)
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(BUNDLE, TARGET)
    size = TARGET.stat().st_size
    print(f"Copied {BUNDLE.relative_to(REPO)} to {TARGET.relative_to(REPO)} ({size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
