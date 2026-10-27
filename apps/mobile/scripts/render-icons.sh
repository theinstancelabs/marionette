#!/usr/bin/env bash
# Renders the app icon and launch-screen PNGs from their SVG sources in assets/, using headless Chrome.
# Usage (from apps/mobile): npm run icons     Set CHROME to use another Chromium-based browser.
# Re-run after editing an SVG, then rebuild (npm run testflight, or expo prebuild) so the native project picks the PNGs up.
set -euo pipefail
cd "$(dirname "$0")/../assets"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
profile=$(mktemp -d)
trap 'rm -rf "$profile"' EXIT
render() { # <svg> <png> [extra flags]
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --user-data-dir="$profile" \
    --window-size=1024,1024 --screenshot="$PWD/$2" "${@:3}" "file://$PWD/$1" >/dev/null 2>&1
  echo "$2"
}
render icon.svg icon.png
render icon-dark.svg icon-dark.png
render icon-tinted.svg icon-tinted.png
# The launch screen draws this over the paper color set in app.json, so it keeps its transparency.
render splash-icon.svg splash-icon.png --default-background-color=00000000
