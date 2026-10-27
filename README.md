# Marionette

Marionette turns iPhones into teleoperation controllers for robots.

Each phone streams its 6-DoF ARKit pose and the operator's inputs (buttons, holds, sliders and a drive stick) to a small gateway. The gateway relays them, tagged with the phone they came from, to whatever drives the robot: a Python or TypeScript program, a ROS 2 node, or the desktop viewer. The phone's screen is an HTML page that the gateway or the robot sends, so every robot gets exactly the controls it needs without a new app build. Several phones can connect at once, for example one in each hand driving one arm each.

Marionette is only the relay. It keeps each phone's control values and runs the calibration that sets each phone's axes, and decides nothing else: stopping, scaling, which phone drives which arm and every safety check belong to the robot side.

```
  iPhone ─┐                                        ┌─> your robot (Python or TypeScript SDK, any WebSocket client)
  iPhone ─┼── Wi-Fi or Tailscale ──> gateway :8787 ┼─> ROS 2 bridge
  iPhone ─┘   pose, inputs                         └─> viewer (desktop console)
          <── screen, robot state, video ──
```

## Try it without an iPhone

You need Node 22 or later.

```sh
npm install
npm run dev:backend       # the gateway, on 0.0.0.0:8787
npm run dev:viewer        # the desktop viewer, on http://localhost:5173
```

Open the viewer, type `localhost` and press **Connect**. The connect page can also start two simulated phones and a simulated robot, so you can try the console without hardware. `http://localhost:8787/screen` shows the phone screen in a desktop browser, acting as the first connected phone.

To script phones from the command line (`HOST=` and `TOKEN=` point them at a gateway on another computer):

```sh
DEVICE=a ARM=left npx tsx tools/phone-sim.mts 8787 wander                    # Phone 1: hello, then ARKit poses
DEVICE=b ARM=right PHASE=7 npx tsx tools/phone-sim.mts 8787 calibrate        # Phone 2: calibrates, then wanders
npx tsx tools/act.mts 8787 phone-2 estop safety.estop true                   # turn Phone 2's Stop on
npx tsx tools/act.mts 8787 phone-1 drive base.drive '{"x":0.5,"y":0}' 2000   # push Phone 1's stick half forward for 2 s
```

## Connect an iPhone

ARKit needs a native module, so the app (`apps/mobile`) runs as a development build rather than in Expo Go. On a Mac with Xcode, with the iPhone plugged in:

```sh
cd apps/mobile
npx expo prebuild --platform ios
npx expo run:ios --device
```

Then scan the QR code the gateway prints, pick the gateway under **Nearby**, or type its address. The phone and the gateway's computer must be on the same Wi-Fi or tailnet. [docs/IPHONE-APP.md](docs/IPHONE-APP.md) covers signing, pairing codes, reconnecting and TestFlight.

## Drive a robot

With the Python SDK (`pip install "marionette-sdk @ git+https://github.com/theinstancelabs/marionette.git#subdirectory=sdk/python"`):

```python
import time
from marionette import GatewayClient, PhoneTracker

client = GatewayClient("localhost").start()   # an address, or the gateway's pairing link
tracker = PhoneTracker()
tracker.attach(client)

while True:
    now = time.monotonic()
    for phone in tracker.snapshot().values():
        if phone.holding("teleop.deadman", now) and phone.pose and not tracker.any_stop():
            print(phone.name, phone.pose.position)   # move the robot here
    time.sleep(0.02)
```

- **Python**: [sdk/python](sdk/python/README.md) also has a clutch for relative teleop, the robot's own screen and state, WebRTC video, the gateway bundled, and simulated phones for tests.
- **TypeScript**: [packages/sdk](packages/sdk/README.md) has the connection, the phone tracker, the teleop parts, the robot's link and simulated phones.
- **ROS 2**: `python3 consumers/ros2/marionette_ros2_bridge.py --gateway localhost` publishes each phone's pose and inputs on topics.
- **Anything else**: connect to `ws://<gateway>:8787/ws` and send a `hello`. See [docs/PROTOCOL.md](docs/PROTOCOL.md).

[docs/INTEGRATION.md](docs/INTEGRATION.md) walks through the data, the default controls, and a recommended consumer for a bimanual mobile manipulator (gating, clutching and safety).

## What's in the repository

| Path | What it is |
|---|---|
| `apps/mobile` | The iPhone app (Expo, React Native). Its native modules are `modules/arkit` and `modules/discovery`. |
| `apps/backend` | The gateway (Node, Express, WebSocket). |
| `apps/viewer` | The desktop console (Vite, React, Three.js). |
| `packages/protocol` | Message types and validation, shared by everything. |
| `packages/kit` | The screen kit: parts for building phone screens. |
| `packages/sdk` | The TypeScript SDK. |
| `sdk/python` | The Python SDK. |
| `consumers/ros2` | The ROS 2 bridge. |
| `tools` | Scripted phones for development. |

## Documentation

- [Integrating with a robot](docs/INTEGRATION.md)
- [The protocol](docs/PROTOCOL.md): messages, frames, calibration, pairing, robots, cameras and WebRTC
- [Running the gateway](docs/GATEWAY.md): configuration, the single-file build and the diagnostics log
- [Phone screens](docs/SCREENS.md) and [the screen kit](docs/SCREEN-KIT.md)
- [The iPhone app](docs/IPHONE-APP.md)
- SDKs: [Python](sdk/python/README.md), [TypeScript](packages/sdk/README.md)

## Security

The gateway asks phones for a pairing code but has no TLS, so keep it on a local network or a private tailnet. Phone screens are trusted HTML and are not sanitized. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setting up, the checks, and how the pieces fit together.

## License

[MIT](LICENSE)
