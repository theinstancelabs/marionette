# Contributing to Marionette

Thanks for helping. Bug reports, fixes, docs and new features are all welcome. For anything large (a new message type, a change to how holds or Stop behave, a new part in an SDK), open an issue first so we can agree on the shape before you build it.

## Setting up

You need Node 22 or later. Python 3.12 or later and [uv](https://docs.astral.sh/uv/) are needed for the Python SDK, and a Mac with Xcode only for the iPhone app.

```sh
npm install                                                    # every JavaScript workspace, from the repository root
uv venv -p 3.12 sdk/python/.venv                               # the Python SDK
VIRTUAL_ENV=sdk/python/.venv uv pip install -e "sdk/python[dev,gateway]"
```

You don't need an iPhone for most work: the viewer's simulated phones, `tools/phone-sim.mts` and the `/screen` desktop mirror cover the gateway, the screens and the SDKs (see [Try it without an iPhone](README.md#try-it-without-an-iphone)). Real ARKit tracking and calibration geometry need a physical iPhone ([docs/IPHONE-APP.md](docs/IPHONE-APP.md)).

## Checks

CI runs these on every pull request:

```sh
npm run typecheck
npm test
npm --workspace @marionette/viewer run build
python3 -m unittest discover consumers/ros2
sdk/python/.venv/bin/python -m pytest sdk/python
python3 sdk/python/scripts/sync_gateway.py && git diff --exit-code sdk/python/src/marionette/_gateway
```

Swift changes in `modules/` can be compile-checked after `npx expo prebuild --platform ios` in `apps/mobile`:

```sh
xcodebuild -workspace apps/mobile/ios/Marionette.xcworkspace -scheme ArkitModule -sdk iphonesimulator build
```

## Things to know before changing code

- **Marionette decides nothing about motion.** The gateway relays, keeps per-phone values, runs calibration and time-stamps things. Stopping, gating, scaling and arbitration belong to the robot side. Changes that make the gateway decide about motion won't be merged; put them in an SDK part the robot chooses to use.
- **The protocol is `packages/protocol/src/index.ts`.** Everything that talks to the gateway follows it: the app, the viewer, the screen kit, both SDKs and the ROS 2 bridge. Keep changes backwards compatible: new fields and message types are optional, and clients ignore message types they don't know. Update [docs/PROTOCOL.md](docs/PROTOCOL.md) in the same pull request.
- **The Python SDK carries the gateway.** `sdk/python/src/marionette/_gateway/marionette-gateway.mjs` is the single-file gateway, committed so that a robot installing the SDK from git gets a working gateway. After changing the gateway, the protocol or the screen kit, run `python3 sdk/python/scripts/sync_gateway.py` and commit the result. CI fails if it is out of date.
- **Both SDKs share conformance fixtures.** `sdk/conformance/tracker/*.json` are run by both phone trackers, so a change to how a tracker reads holds, drags or Stop belongs in both SDKs, with a fixture. `py-*.json` are written by `sdk/python/scripts/make_conformance.py`; `ts-*.json` are written by hand.
- **Screens are HTML.** The default screen is `apps/backend/src/sample-controls.html`, built on the screen kit in `packages/kit` ([docs/SCREEN-KIT.md](docs/SCREEN-KIT.md)). The kit is a plain script with no build step and must keep working in iOS 16.4 WKWebView.

## Pull requests

- Keep each pull request to one change, with tests for any behaviour it adds or fixes. The tests run the real gateway in-process wherever they can, rather than mocking it.
- Update the docs that describe what you changed (`docs/`, the SDK READMEs).
- Write the commit subject as a plain sentence saying what changes, for example "Stream sliders and a drive stick live".

## Reporting bugs

Open an issue with what you did, what you expected and what happened. Include the versions involved (iOS, the app, Node, Python) and, if the gateway was running, the relevant lines of its diagnostics log (`logs/gateway-*.jsonl`, see [docs/GATEWAY.md](docs/GATEWAY.md#diagnostics-log)). Report security problems privately instead: see [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
