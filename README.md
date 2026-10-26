# Marionette

Marionette is an iPhone-first phone teleoperation prototype. It follows the Instance Labs phone teleoperation report: the phone sends pose observations and quality metadata, while the connected host owns configuration, leases, mapping, limits, and the safety boundary.

The repository contains three pieces:

- `apps/mobile`: Expo + React Native + TypeScript iPhone app. It connects to a host by a WebSocket URL such as `ws://192.168.1.20:8787/ws`. The native `@marionette/arkit` Expo module streams ARKit world transforms at the camera frame rate. A DeviceMotion fallback is intentionally marked `limited` for bring-up only.
- `apps/backend`: small Express/WebSocket gateway. It accepts validated, monotonic pose packets, broadcasts them to diagnostic clients, sends a versioned remote UI config, accepts control actions, and emits a virtual camera frame once per second.
- `apps/viewer`: Vite + React + Three.js diagnostic console. It renders a phone model, axes, pose trail, quaternion/covariance telemetry, backend-configured controls, and the virtual return camera. It starts in a simulation mode so the UI can be evaluated without an iPhone.

## Run the diagnostic loop

```sh
npm install
npm run dev:backend       # listens on 0.0.0.0:8787
npm run dev:viewer        # opens Vite on :5173
```

Open the viewer, press **Connect**, and use `ws://localhost:8787/ws`. This is the Marionette diagnostic loop; it does not connect to Axol. The iPhone should connect to the LAN or Tailscale address of the computer running `dev:backend`, while Axol's `10.1.10.220` remains unused by this diagnostic build. Keep the gateway behind the local network or a private tailnet; this first slice does not add authentication or TLS termination.

## Build the iPhone app

The ARKit bridge is a native module, so Expo Go is not enough. Build a development client on macOS with Xcode:

```sh
cd /Users/yashas/Documents/Marionette
npm install
cd apps/mobile
npx expo prebuild --platform ios
npx expo run:ios --device
```

Before the last command, connect and unlock the iPhone over USB, tap **Trust** on the phone, and enable **Developer Mode** under Settings → Privacy & Security → Developer Mode. The first build may open Xcode for signing; select your Apple ID team under the Marionette target's **Signing & Capabilities**. A free Apple team gives a short-lived development install; a paid team gives the normal longer-lived device provisioning.

Start the gateway on the Mac in another terminal:

```sh
cd /Users/yashas/Documents/Marionette
npm run dev:backend
ipconfig getifaddr en0       # LAN address of this Mac
tailscale ip -4              # use this instead when both devices are on Tailscale
```

In the iPhone app, enter `ws://<mac-ip>:8787/ws` and tap **Connect**. Do not use Axol's `10.1.10.220` and do not use `localhost`: on the phone, `localhost` points back to the phone. The Mac and iPhone must be on the same Wi-Fi, or both must be signed into the same Tailscale network. If macOS asks whether Node may accept incoming connections, allow it. The app starts with a `YOUR-MAC-IP` placeholder so the endpoint cannot be mistaken for Axol.

The iOS permission string and ARKit module are registered by `app.plugin.js` and `modules/arkit`. Use a physical iPhone for ARKit; the simulator cannot provide world tracking.

## Protocol

`packages/protocol/src/index.ts` is the single source of truth. Pose packets contain `version`, `sessionId`, `seq`, monotonic timestamp, translation, quaternion, covariance, `trackingState`, calibration version, and heartbeat. The gateway rejects unknown versions, malformed values, and non-monotonic sequence numbers. Remote controls are declarative (`button`, `toggle`, `select`, `slider`) so arm choice, lift inclusion, camera choice, deadman, E-stop, and sensitivity can change from the backend without publishing a new app binary.

The current gateway is diagnostic-only. It does not emit CAN frames, robot commands, IK targets, or motor authority. A production adapter should sit behind the action handler and preserve the report's watchdog, clutch, covariance, stale-frame, lease, workspace, velocity, and E-stop gates.

## Trusted HTML controls

The gateway sends a `html_config` message beside the declarative `config` message. The iPhone renders the supplied document in `react-native-webview`, while keeping the native declarative controls below it as a fallback. HTML is trusted developer content: the gateway must be kept on a private network, and the document is not sanitized. The protocol validates the message schema, bridge version, and a 512 KB UTF-8 size limit.

The sample document is sent by default and exercises buttons, a select, a slider, pose/status text, and a camera image. To load a different trusted document for the diagnostic loop, provide a raw HTML file or string before starting the backend:

```sh
MARIONETTE_HTML_FILE=./config/operator.html npm run dev:backend
# or
MARIONETTE_HTML='<!doctype html><button>Developer UI</button>' npm run dev:backend
```

The same document is available as JSON at `GET /api/html-config`. A document can use the small versioned bridge after the app injects it:

```js
Marionette.sendAction('deadman', 'teleop.toggle', true);
Marionette.sendAction('scale', 'teleop.translationScale', 1.5);

const unsubscribe = Marionette.on('pose', pose => renderPose(pose));
Marionette.on('status', status => renderStatus(status.message));
Marionette.on('config', config => renderConfig(config));
Marionette.on('camera_frame', frame => { camera.src = frame.dataUrl; });
```

`Marionette.version` is currently `1`. `sendAction` accepts only a control id, action name, and optional string/number/boolean value. The event names are limited to `pose`, `status`, `config`, and `camera_frame`; the app ignores other bridge messages. The backend converts accepted bridge actions into the existing version 1 WebSocket `action` message, so existing routing and safety gates remain in one place. Use the native controls when an HTML document is unavailable or fails to load.

## Checks

```sh
npm test
npm run typecheck
npm --workspace @marionette/viewer run build
```

Tests cover quaternion/ARKit transform conversion, packet validation, gateway config/camera handshakes, sequence rejection, and action-driven configuration updates.
