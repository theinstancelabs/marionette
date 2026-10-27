# Integrating Marionette with a robot

This is for whoever builds the robot side: here, the software for a bimanual wheeled humanoid with a lift. It covers what Marionette gives you, how to connect to it, the exact data, and a recommended way to turn that data into robot motion. The README covers running and developing Marionette itself.

## What Marionette is, and what it isn't

Marionette turns iPhones into teleoperation inputs. Each operator holds one or more iPhones (typically one per hand). Each phone runs ARKit and shows a touch screen of controls. A **gateway** (a small Node service) collects everything and republishes it, tagged per phone, to any number of **consumers**. You are writing a consumer.

Marionette provides:
- **One 6-DoF pose stream per phone**, at the ARKit frame rate (~60 Hz), in a right-handed REP-103 frame (+X forward, +Y left, +Z up, metres). Each phone has its own calibration that sets which way is forward.
- **One input stream per phone**: every button press, release, held-button repeat, toggle, selection and slider change, exactly as the operator made it.
- **Each phone's current state**: control values, which hold buttons it is holding, calibration, connection and tracking.
- **Camera return**: any number of camera streams, pushed by robot-side processes as JPEG frames or served over WebRTC, and shown on the phones.
- **A customizable phone screen**: the controls on the phone are an HTML page, so you can give the operator exactly the buttons your robot needs. The robot can send its own.
- **A way back to the phones**: the robot's state (any JSON, kept and replayed by the gateway) and notices, shown on the phone screens.
- **Timing**: every pose and input is stamped with when the gateway received it and how long it took to get there.

**Marionette decides nothing about motion.** It has no E-stop latch, no deadman gating, no velocity or workspace limits and no clutch. It doesn't arbitrate between phones and doesn't scale anything. Stop is a per-phone toggle that Marionette relays like any other control. **Your consumer owns every safety and control decision.** Treat everything from Marionette as operator intent plus measurement quality, never as a command to execute blindly.

## Where it lives

```
  iPhone (left hand) ─┐                         ┌─> your consumer (ROS 2 node, controller, …)
                      ├─ Wi-Fi / Tailscale ─> gateway :8787 ─┤
  iPhone (right hand) ┘     WebSocket            │             └─> viewer (desktop monitor, optional)
                                                 └─< camera processes push frames
```

- **Gateway**: `apps/backend` (Node 22+, `npm install && npm --workspace @marionette/backend run start`), or the single file `npm --workspace @marionette/backend run bundle` builds (`node marionette-gateway.mjs`, Node 20+, nothing else needed; see the README). It listens on `0.0.0.0:8787` (`PORT` to change it). Run it on the robot's onboard computer if it has Wi-Fi reach to the operator. Your consumer then connects over localhost, and only the phones cross the network. Running it on an operator laptop also works, but the consumer then reaches it over the network and needs the pairing code. Phones need the gateway's pairing code (printed on start, with a QR code); clients on the gateway's own computer don't. There is no TLS, so keep it on a private network or a tailnet.
- **Phones**: the iOS app in `apps/mobile`. The operator scans the gateway's QR code, picks it under Nearby, or types its IP and the pairing code.
- **Consumer**: yours. Either connect to the WebSocket directly (any language), use the Python SDK (`sdk/python`, Option C), or run the provided ROS 2 bridge (`consumers/ros2/marionette_ros2_bridge.py`) and subscribe to topics.
- **Camera producers**: small robot-side processes that push JPEG/PNG frames to the gateway (see Cameras).
- **Viewer**: `apps/viewer`, an optional desktop monitor of every phone. Useful during bring-up.

## Option A: ROS 2 topics (recommended)

```sh
pip install websockets                      # rclpy comes with ROS 2 (Humble or later)
python3 consumers/ros2/marionette_ros2_bridge.py --gateway localhost          # on the gateway's own computer
python3 consumers/ros2/marionette_ros2_bridge.py --gateway 192.168.1.20 --token K7Q2-M9XD   # from another; or --gateway "<pairing link>"
python3 consumers/ros2/marionette_ros2_bridge.py --gateway localhost --dry-run # prints instead of publishing; no ROS needed
```

Phones are named by the gateway in connection order ("Phone 1", "Phone 2", …), and topics use that name (`phone_1`, `phone_2`). A phone keeps its name when it reconnects. All publishers are RELIABLE; latched topics are TRANSIENT_LOCAL with depth 1.

| Topic | Type | Contents |
|---|---|---|
| `/marionette/phones` | `std_msgs/String` (latched) | Roster JSON: `{"phones":[{"id":"phone-1","name":"Phone 1","topic":"/marionette/phone_1","color":"#c98200","connected":true}, …]}` |
| `/marionette/<phone>/pose` | `geometry_msgs/PoseStamped` | Pose in frame `<phone>/operator`; stamp is bridge receive time. Published only while the stream is live. |
| `/marionette/<phone>/tracking` | `std_msgs/String` (latched) | `{"phone":"phone-1","state":"normal"}`. States are `normal`, `limited`, `initializing`, `relocalizing` and `unavailable`. It goes `unavailable` when the stream stops, the phone disconnects or the bridge loses the gateway. |
| `/marionette/<phone>/buttons` | `std_msgs/String` | One JSON object per input event (see below): presses, value changes, and every live sample of a slider or stick being dragged. Repeats included. |
| `/marionette/<phone>/state` | `std_msgs/String` (latched) | `{"phone","name","connected","controls":[{"control","action","value"}…, {"control","action","held"}…],"calibration":{"status","epoch","mode","validated"}}`, on change. Sliders and sticks also carry `"live": true` while they are being dragged. A node that starts late learns current values here, for example that Stop is already on. |

A `buttons` event looks like this:

```json
{"phone":"phone-1","control":"deadman","action":"teleop.deadman","value":true,"repeat":true,"source":"phone","received_at_ms":1793079134142,"sent_at_ms":1793079134141}
```

A sample of the drive stick being pushed looks like this. `x` is forward and `y` is left, each from −1 to 1:

```json
{"phone":"phone-1","control":"drive","action":"base.drive","value":{"x":0.5,"y":-0.2},"live":true,"source":"phone","received_at_ms":1793087775692,"sent_at_ms":1793087775690}
```

`source` is one of:
- `phone`: the phone itself.
- `mirror`: the desktop `/screen` mirror acting as that phone.
- `gateway`: a release the gateway inferred because a held button stopped repeating, a drag's samples stopped (a stick comes back as `{"x":0,"y":0}`), or the phone disconnected. `reason` says which.
- `bridge`: the bridge lost the gateway and released every hold and drag it knew about.

`repeat: true` marks the 200 ms re-send of a held button, or the 50 ms re-send of a slider or stick the operator is touching but not moving. `live: true` marks a sample of a drag in progress (see [Live values](#live-values-sliders-and-sticks)). Typed message definitions would be a sensible follow-up; for now the JSON is the contract.

The bridge has only been exercised in dry-run mode (it was written without a ROS install). Expect to verify it on the robot.

## Option B: the WebSocket protocol directly

Connect to `ws://<gateway>:8787/ws` and send:

```json
{"type":"hello","version":1,"role":"console"}
```

Add `"cameras": false` if you don't want camera frames. A console only listens, apart from `status` feedback to the phones (see Feedback to phones below). Any action it sends is refused. From another computer, add the pairing code: `ws://<gateway>:8787/ws?token=K7Q2M9XD`, or `"token":"K7Q2-M9XD"` in the hello. Without it the gateway sends nothing and closes the connection with code 4401. The authoritative types and validators live in `packages/protocol/src/index.ts`. Everything below is JSON.

The robot itself connects the same way but says hello as a robot. It then gets everything a console gets and may also send its screen, its state and WebRTC signaling:

```json
{"type":"hello","version":1,"role":"robot","robotId":"humanoid","name":"Humanoid"}
```

Only one connection may use a robot id at a time: a second is closed with code 4409, and the first stays. Retry with backoff and you take over once the first has gone. A robot gets camera frames only if its hello adds `"cameras": true`.

**Gateway config** (no `phone` field): sent on connect and whenever a phone or robot joins or leaves, or a robot starts or stops publishing a stream.

```json
{"type":"config","version":1,"sessionId":"marionette-ab12cd3","serverName":"lab-mac","gatewayId":"gw-4k9q2m7xd1","auth":true,
 "phones":[{"id":"phone-1","name":"Phone 1","color":"#c98200","connected":true,"sessionId":"iphone-k3v9q2ma"}],
 "robots":[{"id":"humanoid","name":"Humanoid","connected":true,"screen":true,"streams":["head"]}],
 "controls":[…layout with default values…],
 "cameraStreams":[{"id":"head","label":"Head","url":"sim://head","status":"live","transport":"webrtc","publisher":"humanoid"}, …],
 "cameraViews":[{"id":"head","label":"Head cam","streams":["head"]},{"id":"arms","label":"Arm cams","streams":["arm-left","arm-right"]}],
 "calibration":{"status":"uncalibrated","epoch":0}}
```

`robots` stay listed, `connected: false`, after they disconnect. `screen` marks the robot whose screen the phones show, `streams` what it publishes over WebRTC. `gatewayId` stays the same across restarts (unlike `sessionId`), and `auth` says whether clients off the gateway's computer need the pairing code.

**Phone config** (has `phone`): one phone's state. It is sent on connect, whenever that phone changes something, and on roster changes.
- `controls[].value` holds that phone's current value for toggles, selects, sliders and sticks.
- Hold buttons carry `held: true|false`. Sliders and sticks carry `live: true|false`: whether they are being dragged. During a drag this config is sent only when the drag starts and ends; follow the samples in `input`.
- `calibration` is `{status: "uncalibrated"|"capturing"|"captured", epoch, step?, reference?, check?}`.

**Pose**, per phone at about 60 Hz:

```json
{"type":"pose","version":1,"phoneId":"phone-1","sessionId":"iphone-k3v9q2ma","seq":1834,"monotonicTs":5123.41,
 "position":{"x":0.084,"y":-0.012,"z":0.041},"rotation":{"x":0.01,"y":-0.02,"z":0.13,"w":0.99},
 "covariance":[0.0025,0.0025,0.0025,0.01,0.01,0.01],"source":"arkit","trackingState":"normal",
 "calibrationVersion":"guided-v2:2","heartbeat":true,"sentAt":1793079054951.2,"receivedAt":1793079054958.71,"latencyMs":7.44}
```

- `monotonicTs` is the phone's clock in seconds, monotonic within a `sessionId`.
- `sentAt` is the phone's wall clock when it sent the pose, `receivedAt` the gateway's when it arrived (milliseconds with fractions). `latencyMs` is the gateway's estimate of the time in between: it pings each phone every second and works out the phone's clock offset from the fastest of the last 16 round trips. It is missing until the first answer, and on poses from an app without pings. For your own hop, ping the gateway (`{"type":"ping","version":1,"id":1,"sentAt":<your clock>}`; the `pong` echoes `id` and `sentAt` and adds `at`, the gateway's clock) and do the same sum: the pose's age when you use it is `latencyMs` plus your clock now, minus your offset, minus `receivedAt`.
- `seq` restarts when the session changes, which means a new ARKit world. Calibration is cleared then. A phone that reconnects inside the same session keeps its calibration and its `calibrationVersion`.
- `covariance` is a nominal diagonal (m², rad²) per tracking state; ARKit reports none.
- When a phone's stream stops for 1.5 s, or the phone disconnects, you get one pose with `heartbeat:false`, `trackingState:"unavailable"` and a `calibrationVersion` ending in `-stale`.
- `source:"synthetic"` is simulator motion. Never move a robot with it.

**Input**, the button stream:

```json
{"type":"input","version":1,"phoneId":"phone-2","sessionId":"iphone-x1","controlId":"estop","action":"safety.estop","value":true,"source":"phone","sentAt":1793079054968,"receivedAt":1793079054970}
```

Every action a phone sends is forwarded verbatim, including actions no control declares. `renew: true` marks repeats, `live: true` samples of a drag. `source`/`reason` are as above, minus `bridge`. Inputs from the phone itself carry `latencyMs` like poses, once the gateway knows the phone's clock. A stick sample:

```json
{"type":"input","version":1,"phoneId":"phone-1","controlId":"drive","action":"base.drive","value":{"x":0.5,"y":-0.2},"live":true,"source":"phone","sentAt":1793087775690,"receivedAt":1793087775692}
```

**Status**: gateway replies, tagged `phoneId` when they concern one phone (mostly calibration progress), with `values.accepted` true or false.

**Robot state**: what robots say about themselves (see Feedback to phones below). You get each one as it is sent, and the latest of each right after the configs when you connect.

```json
{"type":"robot_state","version":1,"robotId":"humanoid","state":{"engaged":{"left":true,"right":false},"battery":0.82,"lift":null},"everyMs":200,"sentAt":1793079054951,"receivedAt":1793079054953.2}
```

**WebRTC signaling** (`rtc`), if you request video: see Cameras below.

**HTTP** (from another computer, add `?token=<code>` or `Authorization: Bearer <code>`, except for `/health`):
- `GET /api/state` returns everything: the gateway config plus `phones[]` with each phone's config, latest pose, raw pose and link (`rttMs`, `quality`, whether the clock offset is known), `robots[]`, and the retained `robotStates`.
- `GET /api/pairing` returns `{gatewayId, name, code, addresses, port, url, qrSvg}`: the pairing link and its QR code.
- `GET /health` returns `{ok, gatewayId, name, clients, phones, robots, poseCount}`.
- `/screen?phone=phone-2` serves the phone screen in a desktop browser, acting as that phone.

## Option C: the Python SDK

For a robot written in Python, `sdk/python` (distribution `marionette-sdk`, import `marionette`) does the generic
part of Option B for you, as parts your own control loop picks up: a reconnecting connection that pairs, measures the
clock and keeps only the newest state and frames; a tracker that turns the input stream into each phone's holds,
drags, presses and Stop by the rules this document describes (repeats, dropped drags, mirrors, a restarted gateway); the clutch,
gates and jump detection from the recommended consumer; the robot's screen, state, notices and WebRTC video; the
gateway itself, bundled; and test tools (the real gateway on a free port, scriptable phones). Python 3.12 or later.

```sh
pip install "marionette-sdk[video] @ git+https://github.com/theinstancelabs/marionette.git#subdirectory=sdk/python"
```

```python
import time
from pathlib import Path
from marionette import PhoneTracker, RobotLink, gate

tracker = PhoneTracker()
link = RobotLink("localhost", "humanoid", "Humanoid", screen=Path("humanoid.html"), tracker=tracker).start()
link.state({"engaged": False, "battery": 0.82, "lift": None})
for phone in tracker.snapshot().values():
    reason = gate(phone, time.monotonic())        # None, or why this phone can't drive
```

`sdk/python/README.md` documents every part, and `sdk/python/examples/sim_robot.py` is a complete simulated robot
built from them.

## Option D: the TypeScript SDK

For a robot or console in TypeScript (Node, or a browser page), `packages/sdk` (`@marionette/sdk`) has the parts this document describes, already written and tested. It has the same semantics as the Python SDK:

- **`GatewayClient`**: a reconnecting connection. It accepts an address or a pairing link, a token, and role `console` or `robot`. It answers pings and measures the clock offset, and has a coalescing outbox and clear errors for 4401 and 4409.
- **`PhoneTracker`**: one `Phone` per id, built from configs, poses and inputs, with the rules for holds, drags, Stop, desktop mirrors and gateway restarts already applied (`holding`, `stick`, `presses`, `stop`, `pose.age`).
- **Teleop parts**: `gate()` (the gates in step 3 of the recommended consumer below), `Clutch` (the clutch, with scale, rotation scale, a frame and continuous turns), `cameraFrame`, `JumpDetector`, `PressTracker`, `follow` (a rate limiter) and an opt-in `owners`.
- **`RobotLink`**: the robot connection. It keeps your screen and state and re-sends them, and sends notices and JPEG frames. There's no WebRTC publishing in TypeScript: send JPEG, or use the Python SDK's video publisher.
- **`@marionette/sdk/testing`**: the real gateway in-process (`startGateway()`) and scriptable phones (`SimPhone`), for your robot's tests.

```ts
import { RobotLink, gate } from '@marionette/sdk';
const link = new RobotLink('localhost', { robotId: 'humanoid', name: 'Humanoid', tracker: true });
await link.setScreen(html, 'Humanoid');
setInterval(() => { const now = link.tracker!.now(); for (const phone of link.tracker!.snapshot().values()) { /* gate(phone, now), Stop, the clutch… */ } }, 8);
```

See [packages/sdk/README.md](../packages/sdk/README.md).

## Frames and calibration

- **Operator frame (per phone)**: REP-103, +X forward, +Y left, +Z up, metres. Identity rotation is the phone lying flat, screen up, with its top edge pointing forward. Rolling, pitching and yawing the phone read as rotation about +X, +Y and +Z.
- **Up is always gravity.** Forward is set per phone by a short guided calibration on the phone: hold it flat, move it forward, right, then up. Each phone calibrates independently.
- **Uncalibrated poses** use ARKit's own world, expressed in the same axes, with forward set to the way the phone faced when tracking started. If the operator opened the app facing the robot, that is usually close enough.
- **The frame can change at any time.** `calibrationVersion` (in every pose) and `calibration.epoch` (in the phone config and the `/state` topic) change together. When they change, or the `sessionId` changes, drop any clutch anchor for that phone and make the operator re-engage.
- **Robot mapping:** if the operator calibrates "forward" as the robot's forward, the phone's operator frame maps onto the robot's `base_link` with an identity rotation. Positions are displacements from the calibration spot, so use them relatively (see the clutch below), not as absolute targets.
- **Tracking quality**: treat only `trackingState == "normal"` with `heartbeat == true` and `source == "arkit"` as fit to move the robot. `limited` usually means the camera can't see much (a phone held against a blank desk); positions drift in that state.

## Controls you get by default

The default phone screen sends these. Every value is per phone.

| Control id | Action | Type | Suggested meaning |
|---|---|---|---|
| `deadman` | `teleop.deadman` | hold ("Hold to move") | This phone's arm follows the phone only while held |
| `grip` | `gripper.hold` | hold ("Grip") | Close the gripper while held (or toggle on press) |
| `estop` | `safety.estop` | toggle ("Stop", floating red button; Reset on the phone sets it false) | Stop. Recommend: any phone's Stop stops the whole robot |
| `arm` | `arm.select` | select `left` / `right` | Which arm this phone drives |
| `cameras` | `camera.view` | select `head` / `arms` | Which streams the phone shows (handled by Marionette) |
| `lift` | `lift.toggle` | toggle ("Include lift") | Whether vertical motion beyond the arm's reach goes to the lift |
| `sensitivity` | `teleop.translationScale` | slider 0.1–4.0, live | Translation scale for this phone |
| `drive` | `base.drive` | stick, live: `{x, y}`, x forward and y left, each −1..1, at rest `{0, 0}` | Base translation velocity, as a fraction of the speed limit |
| `turn-left`, `turn-right` | `base.turnLeft`, `base.turnRight` | holds ("Turn left", "Turn right") | Rotate the base in place while held |
| `speed-limit` | `base.speedLimit` | slider 0–100 %, live | The base's top speed, as a percentage of what you allow |
| `calibration*`, `capture-origin`, `reset-origin` | `calibration.*` | buttons | Marionette's own calibration. Ignore them, or pause motion while a phone is calibrating (`calibration.status == "capturing"`) |

Hold semantics:
1. A press sends `value:true`.
2. While held, the phone re-sends it every 200 ms with `renew:true`.
3. On release it sends `value:false`.

If the repeats stop for 600 ms, or the phone drops, the gateway emits a `source:"gateway"` release. Don't rely on the release alone: also time out on your side if no repeat arrives for ~600 ms, and treat a lost pose stream (`heartbeat:false`) as a release.

### Live values: sliders and sticks

Sliders and the stick stream while they are dragged, so they can drive something in real time.
1. Each new value is an input with `live: true`, at most once per phone screen frame (about 60 Hz) and only when it changed.
2. While the finger rests, the phone repeats the latest value every 50 ms (`live` and `renew`). You get at least 20 samples a second for as long as it is touched.
3. Letting go sends the final value without `live`. A stick lets go at `{"x":0,"y":0}`.

If the samples stop for 400 ms, the gateway ends the drag itself (`source:"gateway"`, `reason:"samples stopped"`). The stick comes back at rest; a slider keeps its last value. A phone that is still touching it after that keeps sending samples, and they are relayed, but the gateway counts the drag as ended until the operator lets go. Do the same in your consumer, and also time out on your side: if no sample of a live stick arrives for about 250 ms, command zero.

## A recommended consumer for a bimanual wheeled humanoid with a lift

Build a single node that owns all decisions:

1. **Roster and assignment.** Track phones from the roster. Assign each phone to an arm from its `arm.select` value. If two phones claim the same arm, pick a policy: refuse both until resolved, or keep the first. Marionette won't resolve it for you.
2. **Global stop.** If any connected phone has `safety.estop == true`, hold everything: arms, lift and base. Ignore deadmen until every Stop is off again and each deadman has been released and re-pressed. Treat a phone disconnecting while its arm is engaged the same way for that arm.
3. **Per-arm clutch** (relative teleop). The arm moves only while all of these hold:
   - deadman held, with repeats arriving;
   - pose `heartbeat` true, tracking `normal`, `source` `arkit`;
   - no Stop on any phone;
   - that phone's `calibration.status` is not `capturing`.

   On engage, record `P0` (phone pose) and `E0` (end-effector pose in `base_link`). Then each cycle:
   - `target.position = E0.position + s * R_map * (P.position − P0.position)`, where `s` is that phone's `translationScale` and `R_map` maps the phone's operator frame to `base_link` (identity when calibrated facing the robot's forward).
   - `target.rotation = (R_map * (P.rotation * P0.rotation⁻¹) * R_mapᵀ) * E0.rotation`.
   - Clamp to the workspace and to velocity and acceleration limits, then send to IK.

   On release, any gate failing, or a `calibrationVersion` or `sessionId` change: stop and drop the anchor. The operator re-presses to continue, and engaging never jumps the arm.
4. **Lift.** When that phone's `lift.toggle` is on, give the lift the vertical component the arm can't reach. A simple way: if the arm's IK solution is near its vertical limit, move the lift by the remaining Z error at a capped speed. Alternatively, drive the lift from both phones' average Z while both deadmen are held. Pick one and document it on the phone screen.
5. **Base.** The default screen's **Drive base** section has a stick (`base.drive`), Turn left and Turn right holds, and a speed limit slider; the stick is its own deadman. Each cycle, for the phone you let drive the base:
   - `limit = base.speedLimit / 100` (that phone's value).
   - While `base.drive` is live and its last sample is under ~250 ms old: `vx = v_max * limit * x`, `vy = v_max * limit * y` (a holonomic base; a differential one uses `vx` and ignores `y`, or turns with it).
   - While `base.turnLeft` (or `turnRight`) is held with repeats arriving: `wz = +w_max * limit` (or `-w_max * limit`).
   - Otherwise zero. Zero everything on Stop, the stick's final or gateway-inferred sample, a held button's release or timeout, and a phone disconnect.
   - Ramp `vx`, `vy` and `wz` through your acceleration limits, so letting go decelerates rather than stops dead.
   - If both phones push their sticks, pick a policy (first to push drives, or only the phone assigned to the base). Marionette won't pick.
6. **Gripper.** `gripper.hold` closes the gripper while held, or toggles it on press; choose and say so on the screen.
7. **Feedback to phones.** The phones show tracking, Stop and holds by themselves. To show the robot's own state on them (an arm engaged, at its reach limit, the battery), connect as a robot (see Option B) and send `robot_state`:
   ```json
   {"type":"robot_state","version":1,"state":{"engaged":true,"atLimit":false,"battery":0.82,"lift":null},"everyMs":200}
   {"type":"robot_state","version":1,"phoneId":"phone-1","state":{"arm":"left","blocked":"Calibrate this phone first"},"everyMs":200}
   ```
   - `state` is any JSON object up to 64 KB: nested objects, lists, and `null` for "unknown" are fine.
   - Without `phoneId` it is for every phone, mirror and console; with it, for that phone, its `/screen` mirrors and the consoles. It never comes back to you, and a `phoneId` the gateway doesn't know is dropped. The gateway adds `robotId` and `receivedAt` and doesn't interpret anything else.
   - The gateway keeps the latest of each (per phone, and for every phone), also after you disconnect, and gives it to every phone, mirror and console that connects later. So send the whole state each time, not changes.
   - Re-send it every `everyMs` milliseconds even when nothing changes: a screen calls the robot unresponsive after `max(1500, 3 × everyMs)` ms without one, and offline when the roster says it disconnected.
   - The phone screen gets it with `Marionette.on('robot_state', …)` (each message) or `Marionette.on('robots', …)` (every robot's latest state for all phones and for this phone, its name and whether it is connected, with when it last arrived). The screen kit's `robot()` adds staleness on top.
   - For a one-off notice ("Lift at its top"), send a `status` instead: `{"type":"status","version":1,"sessionId":"humanoid","controlId":"robot.notice","message":"Lift at its top"}`, with `phoneId` for one phone. It reaches the phones and mirrors (never consoles) and isn't kept. Its `values` may be any JSON up to 16 KB. Use your own `controlId`s so the screen can tell your notices from the gateway's replies.
   - A console can send the same `status` messages, which is how a consumer that isn't a robot connection talks to the phones. Older iPhone apps receive `status` but not `robot_state`.

## Customizing the phone screen for your robot

The phone screen is an HTML page served by the gateway, and the app has no native controls. To give the operator robot-specific controls:

1. Copy `apps/backend/src/sample-controls.html` to `config/humanoid.html` and edit it. It uses the `window.Marionette` bridge, documented in the README. For a complete robot screen on the screen kit (a hold-to-move pad, Stop, calibration, cameras over WebRTC and robot state), see `sdk/python/examples/sim_robot.html`; `docs/SCREEN-KIT.md` documents the kit. A robot can send its screen itself when it connects, so the screen lives and deploys with the robot.
2. Declare your controls in the page, so they get per-phone values and hold liveness:
   ```html
   <script type="application/json" id="marionette-config">
   { "controls": [
       { "id": "drive", "type": "button", "label": "Drive", "action": "base.drive", "hold": true },
       { "id": "vx", "type": "slider", "label": "Forward speed", "action": "base.vx", "value": 0, "min": -0.5, "max": 0.5, "step": 0.05, "unit": " m/s" },
       { "id": "lift-up", "type": "button", "label": "Lift up", "action": "lift.up", "hold": true }
     ] }
   </script>
   ```
   If you declare `controls`, the list replaces the defaults. Include any defaults you still want, such as `teleop.deadman`, `safety.estop` and `arm.select`. Calibration actions work whatever ids you use.
3. Run `MARIONETTE_HTML_FILE=config/humanoid.html npm --workspace @marionette/backend run start`. Saving the file pushes it to every phone. Use `http://<gateway>:8787/screen` to develop it in a desktop browser. Once it works, the robot can carry the screen itself: send it from the robot connection as `{"type":"screen","version":1,"html":"…","title":"Humanoid"}` when you connect. The gateway handles it like the file (its block sets the layout, a broken block is refused and the old screen stays), answers with a `status` (`controlId: "screen"`, `values.accepted`), ignores the same HTML sent again, and keeps showing it after you disconnect. The newest screen wins between your pushes and saves of the file.
4. Anything the page sends with `Marionette.sendAction(id, action, value)` reaches consumers as `input`, even if undeclared. A value is a string, number, boolean or stick `{x, y}`. For a value that changes while dragged, use `Marionette.stream(id, action)` (`update(value)` while dragging, `end(value)` on release); it sends live samples at most once per frame and the app repeats the latest while the finger rests. Declare a stick as `{ "id": "pan", "type": "joystick", "label": "Camera pan", "action": "camera.pan", "value": {"x": 0, "y": 0} }`; the default screen draws any stick it doesn't know as a generic stick row.

## Cameras

Declare each real stream (and the views the phones can pick between) in the screen's `marionette-config` block:

```json
"cameraStreams": [{"id":"head","label":"Head","url":"ros:///head/image_raw","status":"live"},
                  {"id":"arm-left","label":"Left arm","url":"ros:///left_wrist/image_raw","status":"live"},
                  {"id":"arm-right","label":"Right arm","url":"ros:///right_wrist/image_raw","status":"live"}],
"cameraViews": [{"id":"head","label":"Head cam","streams":["head"]},{"id":"arms","label":"Arm cams","streams":["arm-left","arm-right"]}]
```

Streams with a `sim://` url are generated by the gateway. Any other url is informational. A camera producer connects to `ws://<gateway>:8787/ws`, sends a console `hello`, then for each frame:

```json
{"type":"camera_frame","version":1,"sessionId":"robot","cameraId":"arm-left","dataUrl":"data:image/jpeg;base64,…","capturedAt":1793079054968}
```

Aim for about 640×360 JPEG at 10–15 Hz per stream. Each frame must be under 2 MB. Phones receive only the streams in the view they picked, and consoles receive all of them.

**WebRTC.** For smoother, lower-latency video, serve a stream over WebRTC from the robot connection; the media goes straight from the robot to each viewer, and the gateway only passes the signaling. Every connection to the gateway has a client id (`c1`, `c2`, …), which signaling uses as an address.

1. Send your screen (which declares the streams), then publish the streams you serve: `{"type":"rtc","version":1,"kind":"publish","streams":["head","arm-left"]}`. An undeclared stream is answered with `{"kind":"error","message":…}`. The config then shows `"transport":"webrtc","publisher":"humanoid"` on those streams, and viewers ask you for video instead of waiting for frames. `unpublish` (`streams`, or none for all) stops it; disconnecting does too.
2. A viewer asks for one stream: you receive `{"type":"rtc","version":1,"kind":"request","stream":"head","peer":"head-1","from":"c3"}`. `from` is the viewer's client id and `peer` its own name for this connection; the pair `(from, peer)` names it.
3. Create a peer connection with the stream's video track and send the offer: `{"type":"rtc","version":1,"kind":"offer","to":"c3","peer":"head-1","sdp":"…"}`. The viewer answers with `{"kind":"answer","from":"c3","peer":"head-1","sdp":"…"}`. Both sides may trickle `candidate`s (`{"kind":"candidate","to":…,"peer":…,"candidate":{"candidate":"…","sdpMid":"0","sdpMLineIndex":0}}`), or send a complete offer and skip them.
4. Either side may send `close`. When the viewer goes away you receive `{"kind":"close","from":"c3","peer":"head-1"}`; free that peer connection.

The gateway stamps `from` on everything it passes on and only passes messages between the two ends of one request, so another client can't reach into a connection. It never decides who may watch what. Keep sending JPEG frames for a stream if you want a fallback for viewers without WebRTC; they are relayed as before.

## Bring-up checklist for the integration

1. Run the gateway, then simulate two phones without iPhones (from the repo root): `DEVICE=a ARM=left npx tsx tools/phone-sim.mts 8787 wander` and `DEVICE=b ARM=right PHASE=7 npx tsx tools/phone-sim.mts 8787 wander`. They send the same hello, ARKit-style transforms and actions as the app (`calibrate` mode runs a full calibration first; `HOST=` points them at another machine). `npx tsx tools/act.mts 8787 phone-2 estop safety.estop true` presses a control as a phone, which is handy for testing your gates. `npx tsx tools/act.mts 8787 phone-1 drive base.drive '{"x":0.5,"y":0}' 2000` pushes Phone 1's stick half forward for 2 s; add `no` at the end to stop the repeats and watch the gateway end the drag.
2. Start the bridge with `--dry-run` and check roster, pose, tracking, buttons and state for both phones.
3. With the robot disabled, verify the gates: Stop on either phone, deadman release, a phone disconnect, tracking `limited`, and a recalibration. Each must stop motion and drop the clutch anchor. For the base: letting go of the stick, a stick whose samples stop, and Stop must each bring it to zero.
4. Then enable one arm at low scale, then both, then the lift and base.

## Known limits

- A pairing code but no TLS: private network or tailnet only. Clients on the gateway's computer need no code by default, so a reverse proxy on that computer would let everyone in; use `MARIONETTE_AUTH=strict` behind one.
- One gateway per robot; phones must reach it directly.
- A phone's identity comes from an id stored in the app's Documents folder. Restoring a backup onto a second phone clones it, and the two phones then replace each other.
- `latencyMs` covers the phone to the gateway only, and is an estimate: it assumes the round trip is symmetric. On a good LAN it is a few to tens of milliseconds. The ROS bridge still stamps poses with its own receive time.
- iOS only (ARKit).
