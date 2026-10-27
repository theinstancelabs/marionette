# Marionette

Marionette turns iPhones into teleoperation inputs. Each phone streams its ARKit pose and its inputs (button presses, and sliders and a drive stick that stream live while dragged) to a gateway, which publishes both, tagged with the phone they came from, to whatever consumes them: a ROS 2 bridge, a robot controller, the viewer. Marionette is only the relay. It keeps each phone's control values and runs the calibration that sets each phone's axes, and decides nothing else: stopping, scaling, which phone drives which arm and every safety check belong to the consumer. Several phones can connect at once, for example one in each hand driving one arm each.

The repository contains:

- `apps/mobile`: Expo + React Native + TypeScript iPhone app. It opens on a connect page (type the gateway's IP; recent addresses are remembered) and then shows the gateway's HTML screen full screen: every control, calibration, the camera return and Stop live in that page. The native `@marionette/arkit` Expo module streams ARKit world transforms at the camera frame rate. On the simulator (or a build without the native module) it emits a `synthetic`, `limited` bring-up stream so the transport and controls can still be exercised; it is marked `synthetic` and never calibrates. A real ARKit failure, such as denied camera access, is reported instead of falling back.
- `apps/backend`: small Express/WebSocket gateway. It names each phone, converts its poses into its operator frame, relays every pose and press to consoles, serves the HTML screen and the control layout, runs per-phone calibration, and routes camera streams (three simulated ones by default).
- `apps/viewer`: Vite + React + Three.js desktop console. It opens on the same connect page, then shows a Rerun-style console of every phone in its own color: streams you can show or hide, a 3D/Top/Side view, position plots, the cameras, an inspector per phone (control values follow sliders and sticks live while they are dragged), and a timeline with an event log. It only watches. A pair of simulated phones is available from the connect page for trying the UI without iPhones.
- `consumers/ros2`: a ROS 2 bridge that publishes each phone's pose and inputs (including the stick's live samples) on topics.

## Run the diagnostic loop

```sh
npm install
npm run dev:backend       # listens on 0.0.0.0:8787
npm run dev:viewer        # opens Vite on :5173
```

Open the viewer, type `localhost` and press **Connect** (an address can be an IP, `host:port`, or a full `ws://` URL; the port defaults to 8787). This is the Marionette diagnostic loop; it does not connect to Axol. The iPhone should connect to the LAN or Tailscale address of the computer running `dev:backend`, while Axol's `10.1.10.220` remains unused by this diagnostic build. Keep the gateway behind the local network or a private tailnet; this first slice does not add authentication or TLS termination. Browsers may connect (WebSocket) and read the REST API only from loopback pages or pages served from the gateway's own host name; add other viewer origins with `MARIONETTE_ALLOWED_ORIGINS=http://host:5173`.

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

In the iPhone app, type the Mac's IP (for example `192.168.1.20`) and tap **Connect**. Do not use Axol's `10.1.10.220` and do not use `localhost`: on the phone, `localhost` points back to the phone. The Mac and iPhone must be on the same Wi-Fi, or both must be signed into the same Tailscale network. If macOS asks whether Node may accept incoming connections, allow it, and allow Local Network access when iOS asks. If the gateway can't be reached within a few seconds, or the connection drops, the app returns to the connect page and says why.

The iOS permission string and ARKit module are registered by `app.plugin.js` and `modules/arkit`. Use a physical iPhone for ARKit world tracking; the simulator only exercises the limited fallback and cannot validate real tracking or calibration geometry.

## Protocol

`packages/protocol/src/index.ts` is the single source of truth. Pose packets contain `version`, `sessionId`, `seq`, monotonic timestamp, translation, quaternion, covariance, `trackingState`, calibration version, heartbeat and (on everything the gateway forwards) `phoneId`. The gateway rejects unknown versions, malformed values, and non-monotonic sequence numbers within a session; a new phone session may restart at sequence zero. Controls are declarative (`button`, `toggle`, `select`, `slider`, `joystick`, with `hold: true` for press-and-hold buttons), so a layout can change from the gateway or the screen without a new app binary. The app drops individual controls it cannot render instead of rejecting a newer layout. Every gateway reply carries `values.accepted` (true or false).

### Frames

Every pose the gateway publishes uses the operator frame, following ROS REP-103: +X forward, +Y left, +Z up, in metres (right-handed). Identity rotation is the phone flat, screen up, top edge pointing forward. The phone body frame is +X top edge, +Y left edge, +Z out of the screen. ARKit's camera frame is fixed to the sensor's landscape orientation (+X toward the bottom edge of a portrait phone, +Y toward its right edge, +Z out of the screen), so the conversion is a fixed 180° turn about Z; the raw packets on the wire are still ARKit's gravity-aligned world (+Y up, -Z initial heading). Uncalibrated output re-expresses that world in operator axes, with forward along ARKit's initial heading. Positive yaw turns left, positive pitch tips the top edge down, and positive roll dips the right edge.

The viewer labels each axis and has **3D**, **Top** (forward is screen-up) and **Side** (forward is screen-right, up is screen-up) views. A forward move drawn in the angled 3D view goes into the screen, which can look like a lift. The telemetry panel also shows the dominant axis of the last half second of motion and where the phone's top edge and screen point.

### Several phones

Every phone says `hello` with a device id the app keeps, and the gateway names it in connection order: **Phone 1** (amber `#c98200`), **Phone 2** (orchid `#b04fc4`), then graphite for any more, which are told apart by name. The id (`phone-1`), name and color stay with that device for the gateway's lifetime, so a phone that drops off Wi-Fi and reconnects comes back as itself, with its control values (Stop stays on) but uncalibrated, because a new connection is a new ARKit session; a second connection from the same phone replaces the first. An older app that sends no hello still works, as a phone that leaves the roster when it disconnects. Each phone shows its name and color in its status strip and along the top edge of its screen, matching the viewer.

Each phone has its own pose stream, calibration, control values (arm, cameras, scale, Stop, …), held buttons and dragged sliders and sticks. Nothing is shared and nothing is arbitrated: both phones may pick the same arm and hold their deadman at once, and one phone never blocks the other. Phones only receive their own config, replies and camera streams; consoles receive everything.

### Consuming Marionette

A consumer connects to `ws://<gateway>:8787/ws`, sends `{"type":"hello","version":1,"role":"console"}` (a client that sends nothing for 250 ms is treated as a console too; add `"cameras":false` if it has no use for camera frames), and receives:

| Message | What it is |
|---|---|
| `config` without `phone` | The control layout, camera streams and views, and the roster in `phones` (`{id, name, color, connected, sessionId}`). Sent on connect and whenever a phone joins or leaves. |
| `config` with `phone` | One phone's state: whether it is connected, its control values, `held: true` on each hold button it is holding, `live: true` on each slider or stick being dragged, and its calibration. Sent on connect, whenever it changes and whenever the roster does; during a drag only when it starts and ends (the samples are in `input`). |
| `pose` | Each phone's pose at the ARKit frame rate, tagged `phoneId`, in that phone's operator frame. When a phone's stream stops (watchdog, 1.5 s) or it disconnects, one pose with `heartbeat: false` and `trackingState: 'unavailable'`. |
| `input` | The input stream: every action a phone sends, verbatim, tagged `phoneId`, including the 200 ms repeats of a held button (`renew: true`), every live sample of a slider or stick being dragged (`live: true`, see [Live values](#live-values-sliders-and-sticks)) and actions no control declares. `source` is `phone`, `mirror` (the desktop `/screen` mirror acting as that phone) or `gateway`, which marks a release or end of drag the gateway inferred, with a `reason`: the hold stopped being repeated for 600 ms or the drag's samples for 400 ms (`renewals stopped`, `samples stopped`; `MARIONETTE_HOLD_TIMEOUT_MS`, `MARIONETTE_STREAM_TIMEOUT_MS`), its phone or mirror went away (`phone disconnected`, `mirror disconnected`, `replaced by a newer connection`, `mirror moved to another phone`), or a saved screen removed the control (`screen changed`). A repeat never restarts a hold or drag the gateway has ended, so a consumer that follows the gateway's releases should do the same. |
| `status` | Replies, tagged `phoneId` when they concern one phone (calibration progress and refusals). |
| `camera_frame` | Every camera stream, unless the hello said `"cameras":false`. |

Consoles only watch: an action from a console is refused. `GET /api/state` returns the same picture as JSON (`phones[]` with each phone's config and latest pose). In the default layout Stop (`safety.estop`) is a per-phone toggle, `teleop.deadman` ("Hold to move"), `gripper.hold`, `base.turnLeft` and `base.turnRight` are holds, `base.drive` is a stick, and `arm.select`, `camera.view`, `lift.toggle`, `teleop.translationScale` and `base.speedLimit` are values; all of them are signals for the consumer to interpret.

### Live values: sliders and sticks

A slider or stick streams while the operator drags it, so a consumer can follow it in real time (a fast linear axis, a joint, a base). Each new value goes out as an `input` with `live: true`, at most once per screen frame (about 60 Hz on the phone) and only when it changed. While the finger rests on it, the app repeats the latest value every 50 ms (`live` and `renew`), so a consumer sees at least 20 samples a second for as long as it is touched. Letting go sends the final value without `live`. A stick's value is `{"x": …, "y": …}` in operator axes: `x` is up the pad (forward), `y` is to the left, each from −1 to 1 and never more than 1 together, and it returns to `{"x": 0, "y": 0}` when let go.

The gateway keeps the latest sample as the phone's value. It republishes the phone's config only when a drag starts and ends (`live: true`, then `false`), not for every sample. If the samples stop for 400 ms (Wi-Fi drops, the app freezes) it ends the drag itself, with an `input` from `source: gateway`, `reason: samples stopped`: a stick goes back to rest, and a slider keeps its last value. If the phone is still touching it, its samples are relayed but the gateway keeps the drag ended until the operator lets go, the same rule as a hold. The phone shows **Dropped** in red until then.

**ROS 2.** `consumers/ros2/marionette_ros2_bridge.py` is a ready consumer:

```sh
pip install websockets                                   # rclpy comes with ROS 2
python3 consumers/ros2/marionette_ros2_bridge.py --gateway 192.168.1.20
python3 consumers/ros2/marionette_ros2_bridge.py --gateway localhost --dry-run   # no ROS needed; prints what it would publish
```

For each phone it publishes:

- `/marionette/phone_1/pose`: `geometry_msgs/PoseStamped`, frame `phone_1/operator`, only while the stream is live.
- `/marionette/phone_1/buttons`: `std_msgs/String`, one JSON object per input event (`control`, `action`, `value`, `source`, `live` for samples of a drag, `repeat` for repeats, `reason` for inferred releases). The stick's samples arrive here, for example `{"control":"drive","action":"base.drive","value":{"x":0.5,"y":-0.2},"live":true,…}`.
- `/marionette/phone_1/tracking`: `std_msgs/String`, latched, on change (`normal`, `limited`, …, `unavailable`).
- `/marionette/phone_1/state`: `std_msgs/String`, latched, on change: whether the phone is connected, every control value (Stop included), which hold buttons it is holding and which sliders and sticks are being dragged (`live`), and its calibration (`status`, `epoch`, `mode`, `validated`; re-anchor when `epoch` changes). A node that starts late learns from this that Stop is already on.

It also publishes the roster on `/marionette/phones` (latched). Topic names come from the phones' names. Every publisher is reliable (keep last), so it matches both the default reliable subscriptions and best-effort ones; latched topics are transient-local. The bridge reconnects with backoff. While the gateway is unreachable it does not leave the last values standing: each phone's tracking goes `unavailable`, every phone reads as disconnected, and each hold or drag the gateway had reported gets a release on `buttons` with `"source":"bridge"` (a stick back at rest).

### Calibration frame

For a repeatable coordinate frame, connect the phone. On it, tap **Calibration**, then **Start calibration**, and follow the four full-screen steps: hold the phone roughly flat in your hand (within 30° of flat, `FLAT_TOLERANCE_DEGREES`; screen up, top edge forward) and capture; move it forward and capture; return to the flat reference, move it right and capture; return again, lift it upward and capture. Each capture is checked immediately (at least 30 mm of movement, right must be to the right of forward), so a bad step can be retaken. Up always comes from gravity; the forward and right moves only set the heading, so accidental lift during a move cannot tilt the frame. The flat capture becomes zero position and identity rotation, and rolling, pitching, or turning the phone reads as rotation about +X, +Y, or +Z at any heading. Each step shows a drawing of the move and a live meter of how far the phone has moved (from `config.calibration.anchor`, the flat spot in the current frame). The previous frame stays active until the up capture, and **Cancel** (`calibration.cancel`) puts it back. Calibration is complete at up: the new frame goes live. Calibration only roughly aligns the axes, so captures, checks and quick origin accept ARKit `normal` or `limited` tracking. A phone lying on a blank desk often blinds its camera and drops to limited; holding it up over the floor keeps tracking normal and the moves accurate. Each phone calibrates on its own, and the frame can change at any time (a consumer should re-anchor when `calibrationVersion` changes).

Validation is optional and never gates anything. **Validate** (`calibration.check`, no value) asks for three moves, each starting from the flat spot like the captures: move forward and press **Check forward** (value `forward`), move right (`right`), lift up (`up`); `cancel` stops it. Each move is the calibrated position at the press, so repositioning in between doesn't count, and it passes when its largest component is on the expected axis: forward → +X, right → −Y, up → +Z. While it runs the phone draws itself moving in the calibrated frame, so a wrong frame shows as the drawing sliding the wrong way. The results (with the measured millimetres) are shown on the phone, in the viewer, and in that phone's `config.calibration.check`; a failed move says which way it actually went.

**Quick capture origin** zeroes position at the current pose, takes up from gravity, and takes forward from the phone's heading (its top edge, or its back camera when held upright). **Reset calibration** returns to the uncalibrated gravity-aligned frame. Every frame change increments `calibration.epoch`, which also appears in each pose's `calibrationVersion` (for example `guided-v2:3`). A new phone session clears any finished or half-finished calibration: reconnecting does this, and so does the app after an ARKit interruption (backgrounding, a phone call), because the native module restarts tracking rather than relocalizing into a possibly different world origin.

### Diagnostics log

`npm run dev:backend` / `start` writes a JSONL log to `logs/gateway-<time>.jsonl` (override the directory with `MARIONETTE_LOG_DIR`) and prints its path. It records each phone's poses at 10 Hz (`MARIONETTE_POSE_LOG_HZ`, `0` disables), each with the raw ARKit position and quaternion, the published operator position and quaternion, and where the phone's top edge, left edge and screen point in both frames. Every record names its phone. It also records every calibration capture or rejection (with the ARKit-world move from the flat reference), the frame each calibration builds (its forward, left and up axes in ARKit world and its heading from the uncalibrated forward), each validation move, and every phone, session, tracking and hold change. Non-pose events are echoed to the console. For example, to list calibration events: `grep '"calibration"' logs/gateway-*.jsonl`.

### Cameras

The gateway can carry any number of camera streams at once. A camera process (on the robot, say) connects like any client and sends `camera_frame` messages for a declared stream id; frames for undeclared ids are ignored. Streams are grouped into views, and each phone picks a view with the `camera.view` control: by default **Head cam** (one stream, `head`) or **Arm cams** (`arm-left` and `arm-right`, shown side by side). The three default streams are simulated and only rendered while someone is watching. A phone receives only the streams in its own view; consoles receive all of them (unless they opt out), and the viewer picks its own view without changing any phone's. On the phone screen the streams of a view sit side by side, uncropped; with more than one, a tap stacks them full width.

## The phone screen is HTML

The gateway sends a `html_config` message beside the `config` message, and the iPhone shows that document full screen in `react-native-webview`. There are no native controls behind it: the default screen (`apps/backend/src/sample-controls.html`) has Stop (this phone's toggle, with a banner and Reset while it is on), the hold-to-move pad, a grip, live pose, the cameras, **Drive base** (the stick between Turn left and Turn right, what it is sending, and the speed limit), every other control as a row, and full-screen guided calibration and optional validation. Hold buttons show what the gateway knows: **Holding…** until the gateway reports the hold, **Holding** once it does, and **Hold dropped** if the gateway lets go while the button is still pressed (its repeats stopped arriving), which needs a fresh press. The stick and sliders work the same way: blue once the gateway hears them live, red (**Dropped**) if it stops hearing them mid-drag. The stick follows the finger anywhere on the pad and springs back when let go; on the desktop mirror the arrow keys push it too. It finds controls in the config by action rather than by id, so a different layout still gets a working screen; anything it doesn't know is drawn as a generic button, switch, choice, slider or stick. The point is that the screen is yours: make it send exactly the buttons your consumer needs. HTML is trusted developer content: keep the gateway on a private network; the document is not sanitized. The protocol validates the message schema, bridge version, and a 512 KB UTF-8 size limit. The WebView cannot navigate away from the supplied document; http(s) links open in Safari.

To make your own screen, copy the default document and point the gateway at it (relative paths resolve from the directory you run the command in). The gateway pushes the file to every phone again whenever you save it:

```sh
MARIONETTE_HTML_FILE=./config/operator.html npm run dev:backend
# or a fixed string
MARIONETTE_HTML='<!doctype html><button>Developer UI</button>' npm run dev:backend
```

A screen can declare its own controls and cameras in a JSON block; anything it leaves out keeps the default, except that streams declared without views get one view each. The gateway refuses to start if the block is broken and keeps the previous screen if a saved edit breaks it; entries it cannot use (a control without an `id`, say) are dropped and named in the console and the diagnostics log. When a saved screen changes the layout, a value the control no longer accepts returns to its default and a hold whose button is gone is released (`reason: 'screen changed'`).

```html
<script type="application/json" id="marionette-config">
{ "controls": [{ "id": "horn", "type": "button", "label": "Horn", "action": "horn.honk" },
               { "id": "speed", "type": "slider", "label": "Speed", "action": "base.speed", "value": 0.5, "min": 0, "max": 1, "step": 0.1 }],
  "cameraStreams": [{ "id": "deck", "label": "Deck", "url": "camera://deck", "status": "live" }],
  "cameraViews": [{ "id": "deck", "label": "Deck cam", "streams": ["deck"] }] }
</script>
```

Declared toggles, selects and sliders get per-phone values and declared holds get repeat tracking, but nothing has to be declared to reach the consumer: any `sendAction` is relayed as `input`. Calibration actions (`calibration.*`) work whatever control id a screen uses.

Open `http://localhost:8787/screen` in a desktop browser to work on the screen without the phone. It is the same document with the same bridge, carried over the gateway's WebSocket. It mirrors the first connected phone (or the one in `?phone=phone-2`), shows that phone's state, and acts as that phone: its presses reach consumers with `source: 'mirror'`. It reloads when the file changes. The document is also available as JSON at `GET /api/html-config`.

The page talks to the app through `window.Marionette` (bridge version 1). Wait for it with the `marionette-ready` event if it isn't there yet:

```js
Marionette.sendAction('deadman', 'teleop.deadman', true);   // press; send false on release
Marionette.sendAction('sensitivity', 'teleop.translationScale', 1.5);
Marionette.sendAction('horn', 'horn.honk');                  // undeclared actions are relayed too

// A value being dragged: update() sends the newest value at most once a frame, only when it changed,
// marked live; end() sends the final value. The app repeats the latest sample while the finger rests.
const drive = Marionette.stream('drive', 'base.drive');
drive.update({ x: 0.5, y: -0.2 });   // half forward, a little right
drive.end({ x: 0, y: 0 });           // let go: back to rest
const speed = Marionette.stream('speed-limit', 'base.speedLimit');
speed.update(62); speed.end();       // end() with no value sends the last one

const unsubscribe = Marionette.on('pose', pose => renderPose(pose));          // operator frame, ~15 Hz
Marionette.on('config', config => renderConfig(config));                      // config.phone is this phone
Marionette.on('status', status => renderStatus(status.message));
Marionette.on('camera_frame', frame => { panes[frame.cameraId].src = frame.dataUrl; });
Marionette.on('tracking', t => renderTracking(t.state, t.reason, t.message)); // ARKit as the phone sees it
Marionette.on('connection', c => renderGateway(c.gateway));
Marionette.latest('config');   // the last config, or undefined
Marionette.disconnect();       // back to the connect page
```

`on` calls a new listener straight away with the last value of that type, so a page that subscribes late still starts from the current state. `sendAction` accepts a control id, action name, an optional string, number, boolean or stick (`{x, y}`) value, and `{ live: true }` for a sample of a value being dragged (`stream` does this for you). For a control the config marks `hold: true`, send `true` on press and `false` on release; the app repeats the press while it is held and releases it if the document reloads or the app leaves the foreground. A drag is ended the same way: a stick at rest, a slider at its last value. A calibration capture names the step the gateway is waiting for (`config.calibration.step`) and a validation move names `config.calibration.check.step`. The app converts bridge actions into the version 1 WebSocket `action` message.

## Developing without iPhones

`tools/phone-sim.mts` is a scripted phone: it says hello, streams ARKit-style transforms and sends actions like the app. `tools/act.mts` presses one control as a given phone. From the repo root:

```sh
DEVICE=a ARM=left npx tsx tools/phone-sim.mts 8787 wander          # Phone 1, left arm
DEVICE=b ARM=right PHASE=7 npx tsx tools/phone-sim.mts 8787 calibrate   # Phone 2: full calibration and validation, then wander
npx tsx tools/act.mts 8787 phone-2 estop safety.estop true          # turn Phone 2's Stop on
npx tsx tools/act.mts 8787 phone-1 drive base.drive '{"x":0.5,"y":0}' 2000   # push Phone 1's stick half forward for 2 s
```

For integrating a robot (what the streams are, where things run, and a recommended consumer for a bimanual mobile manipulator), see [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Checks

```sh
npm test
npm run typecheck
npm --workspace @marionette/viewer run build
python3 -m unittest discover consumers/ros2
```

Tests use real ARKit camera transforms to cover the camera-to-phone conversion, guided and quick calibration at arbitrary headings, and message validation. Gateway tests cover several phones at once (naming, colors, reconnects and takeovers, routing so no phone sees another's data, consoles hearing about every phone change), the verbatim input stream, holds and their inferred releases, the `/screen` mirror and its address handling, camera views and the camera opt-out, custom layouts and live reloads, per-phone calibration on normal and limited tracking, cross-origin refusal, and malformed frames. The bridge tests cover the topic mapping, the latched per-phone state, what happens when the gateway is lost, and address parsing. Swift changes can be compile-checked with `xcodebuild -workspace apps/mobile/ios/Marionette.xcworkspace -scheme ArkitModule -sdk iphonesimulator build`.
