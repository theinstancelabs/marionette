# Integrating Marionette with a robot

This is for whoever builds the robot side: here, the software for a bimanual wheeled humanoid with a lift. It covers what Marionette gives you, how to connect to it, the exact data, and a recommended way to turn that data into robot motion. The README covers running and developing Marionette itself.

## What Marionette is, and what it isn't

Marionette turns iPhones into teleoperation inputs. Each operator holds one or more iPhones (typically one per hand). Each phone runs ARKit and shows a touch screen of controls. A **gateway** (a small Node service) collects everything and republishes it, tagged per phone, to any number of **consumers**. You are writing a consumer.

Marionette provides:
- **One 6-DoF pose stream per phone**, at the ARKit frame rate (~60 Hz), in a right-handed REP-103 frame (+X forward, +Y left, +Z up, metres). Each phone has its own calibration that sets which way is forward.
- **One input stream per phone**: every button press, release, held-button repeat, toggle, selection and slider change, exactly as the operator made it.
- **Each phone's current state**: control values, which hold buttons it is holding, calibration, connection and tracking.
- **Camera return**: any number of camera streams, pushed by robot-side processes and shown on the phones.
- **A customizable phone screen**: the controls on the phone are an HTML page served by the gateway, so you can give the operator exactly the buttons your robot needs.

**Marionette decides nothing about motion.** It has no E-stop latch, no deadman gating, no velocity or workspace limits and no clutch. It doesn't arbitrate between phones and doesn't scale anything. Stop is a per-phone toggle that Marionette relays like any other control. **Your consumer owns every safety and control decision.** Treat everything from Marionette as operator intent plus measurement quality, never as a command to execute blindly.

## Where it lives

```
  iPhone (left hand) ─┐                         ┌─> your consumer (ROS 2 node, controller, …)
                      ├─ Wi-Fi / Tailscale ─> gateway :8787 ─┤
  iPhone (right hand) ┘     WebSocket            │             └─> viewer (desktop monitor, optional)
                                                 └─< camera processes push frames
```

- **Gateway**: `apps/backend` (Node 22+, `npm install && npm --workspace @marionette/backend run start`). It listens on `0.0.0.0:8787` (`PORT` to change it). Run it on the robot's onboard computer if it has Wi-Fi reach to the operator. Your consumer then connects over localhost, and only the phones cross the network. Running it on an operator laptop also works, but the consumer then reaches it over the network. It has no authentication or TLS, so keep it on a private network or a tailnet.
- **Phones**: the iOS app in `apps/mobile`. The operator types the gateway's IP on the phone's connect page.
- **Consumer**: yours. Either connect to the WebSocket directly (any language), or run the provided ROS 2 bridge (`consumers/ros2/marionette_ros2_bridge.py`) and subscribe to topics.
- **Camera producers**: small robot-side processes that push JPEG/PNG frames to the gateway (see Cameras).
- **Viewer**: `apps/viewer`, an optional desktop monitor of every phone. Useful during bring-up.

## Option A: ROS 2 topics (recommended)

```sh
pip install websockets                      # rclpy comes with ROS 2 (Humble or later)
python3 consumers/ros2/marionette_ros2_bridge.py --gateway localhost          # or the gateway's IP
python3 consumers/ros2/marionette_ros2_bridge.py --gateway localhost --dry-run # prints instead of publishing; no ROS needed
```

Phones are named by the gateway in connection order ("Phone 1", "Phone 2", …), and topics use that name (`phone_1`, `phone_2`). A phone keeps its name when it reconnects. All publishers are RELIABLE; latched topics are TRANSIENT_LOCAL with depth 1.

| Topic | Type | Contents |
|---|---|---|
| `/marionette/phones` | `std_msgs/String` (latched) | Roster JSON: `{"phones":[{"id":"phone-1","name":"Phone 1","topic":"/marionette/phone_1","color":"#c98200","connected":true}, …]}` |
| `/marionette/<phone>/pose` | `geometry_msgs/PoseStamped` | Pose in frame `<phone>/operator`; stamp is bridge receive time. Published only while the stream is live. |
| `/marionette/<phone>/tracking` | `std_msgs/String` (latched) | `{"phone":"phone-1","state":"normal"}`. States are `normal`, `limited`, `initializing`, `relocalizing` and `unavailable`. It goes `unavailable` when the stream stops, the phone disconnects or the bridge loses the gateway. |
| `/marionette/<phone>/buttons` | `std_msgs/String` | One JSON object per input event (see below). Repeats included. |
| `/marionette/<phone>/state` | `std_msgs/String` (latched) | `{"phone","name","connected","controls":[{"control","action","value"}…, {"control","action","held"}…],"calibration":{"status","epoch","mode","validated"}}`, on change. A node that starts late learns current values here, for example that Stop is already on. |

A `buttons` event looks like this:

```json
{"phone":"phone-1","control":"deadman","action":"teleop.deadman","value":true,"repeat":true,"source":"phone","received_at_ms":1793079134142,"sent_at_ms":1793079134141}
```

`source` is one of:
- `phone`: the phone itself.
- `mirror`: the desktop `/screen` mirror acting as that phone.
- `gateway`: a release the gateway inferred because a held button stopped repeating, or its phone disconnected. `reason` says which.
- `bridge`: the bridge lost the gateway and released every hold it knew about.

`repeat: true` marks the 200 ms re-send of a held button. Typed message definitions would be a sensible follow-up; for now the JSON is the contract.

The bridge has only been exercised in dry-run mode (it was written without a ROS install). Expect to verify it on the robot.

## Option B: the WebSocket protocol directly

Connect to `ws://<gateway>:8787/ws` and send:

```json
{"type":"hello","version":1,"role":"console"}
```

Add `"cameras": false` if you don't want camera frames. A console only listens; any action it sends is refused. The authoritative types and validators live in `packages/protocol/src/index.ts`. Everything below is JSON.

**Gateway config** (no `phone` field): sent on connect and whenever a phone joins or leaves.

```json
{"type":"config","version":1,"sessionId":"marionette-ab12cd3","serverName":"Marionette local gateway",
 "phones":[{"id":"phone-1","name":"Phone 1","color":"#c98200","connected":true,"sessionId":"iphone-k3v9q2ma"}],
 "controls":[…layout with default values…],
 "cameraStreams":[{"id":"head","label":"Head","url":"sim://head","status":"live"}, …],
 "cameraViews":[{"id":"head","label":"Head cam","streams":["head"]},{"id":"arms","label":"Arm cams","streams":["arm-left","arm-right"]}],
 "calibration":{"status":"uncalibrated","epoch":0}}
```

**Phone config** (has `phone`): one phone's state. It is sent on connect, whenever that phone changes something, and on roster changes.
- `controls[].value` holds that phone's current value for toggles, selects and sliders.
- Hold buttons carry `held: true|false`.
- `calibration` is `{status: "uncalibrated"|"capturing"|"captured", epoch, step?, reference?, check?}`.

**Pose**, per phone at about 60 Hz:

```json
{"type":"pose","version":1,"phoneId":"phone-1","sessionId":"iphone-k3v9q2ma","seq":1834,"monotonicTs":5123.41,
 "position":{"x":0.084,"y":-0.012,"z":0.041},"rotation":{"x":0.01,"y":-0.02,"z":0.13,"w":0.99},
 "covariance":[0.0025,0.0025,0.0025,0.01,0.01,0.01],"source":"arkit","trackingState":"normal",
 "calibrationVersion":"guided-v2:2","heartbeat":true}
```

- `monotonicTs` is the phone's clock in seconds, monotonic within a `sessionId`.
- `seq` restarts when the session changes, which means a new ARKit world. Calibration is cleared then.
- `covariance` is a nominal diagonal (m², rad²) per tracking state; ARKit reports none.
- When a phone's stream stops for 1.5 s, or the phone disconnects, you get one pose with `heartbeat:false`, `trackingState:"unavailable"` and a `calibrationVersion` ending in `-stale`.
- `source:"synthetic"` is simulator motion. Never move a robot with it.

**Input**, the button stream:

```json
{"type":"input","version":1,"phoneId":"phone-2","sessionId":"iphone-x1","controlId":"estop","action":"safety.estop","value":true,"source":"phone","sentAt":1793079054968,"receivedAt":1793079054970}
```

Every action a phone sends is forwarded verbatim, including actions no control declares. `renew: true` marks held-button repeats. `source`/`reason` are as above, minus `bridge`.

**Status**: gateway replies, tagged `phoneId` when they concern one phone (mostly calibration progress), with `values.accepted` true or false.

**HTTP**:
- `GET /api/state` returns everything: the gateway config plus `phones[]` with each phone's config, latest pose and raw pose.
- `GET /health` returns `{ok, clients, phones, poseCount}`.
- `/screen?phone=phone-2` serves the phone screen in a desktop browser, acting as that phone.

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
| `sensitivity` | `teleop.translationScale` | slider 0.1–4.0 | Translation scale for this phone |
| `calibration*`, `capture-origin`, `reset-origin` | `calibration.*` | buttons | Marionette's own calibration. Ignore them, or pause motion while a phone is calibrating (`calibration.status == "capturing"`) |

Hold semantics:
1. A press sends `value:true`.
2. While held, the phone re-sends it every 200 ms with `renew:true`.
3. On release it sends `value:false`.

If the repeats stop for 600 ms, or the phone drops, the gateway emits a `source:"gateway"` release. Don't rely on the release alone: also time out on your side if no repeat arrives for ~600 ms, and treat a lost pose stream (`heartbeat:false`) as a release.

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
5. **Base.** The default screen has no base controls; add them (see the next section). Example: a custom screen sends `base.vx` and `base.wz` slider values while a "Drive" hold button is held. The consumer drives the base only while that hold is alive, and zeroes velocity on release, timeout or Stop.
6. **Gripper.** `gripper.hold` closes the gripper while held, or toggles it on press; choose and say so on the screen.
7. **Feedback.** The phones show tracking, Stop and holds by themselves. To show robot state on the phones (for example "arm at joint limit"), put it in the camera stream overlay for now. There is no consumer-to-phone message channel yet; add one to the gateway if needed.

## Customizing the phone screen for your robot

The phone screen is an HTML page served by the gateway, and the app has no native controls. To give the operator robot-specific controls:

1. Copy `apps/backend/src/sample-controls.html` to `config/humanoid.html` and edit it. It uses the `window.Marionette` bridge, documented in the README.
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
3. Run `MARIONETTE_HTML_FILE=config/humanoid.html npm --workspace @marionette/backend run start`. Saving the file pushes it to every phone. Use `http://<gateway>:8787/screen` to develop it in a desktop browser.
4. Anything the page sends with `Marionette.sendAction(id, action, value)` reaches consumers as `input`, even if undeclared. Values must be a string, number or boolean. Send two actions rather than an object.

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

## Bring-up checklist for the integration

1. Run the gateway, then simulate two phones without iPhones (from the repo root): `DEVICE=a ARM=left npx tsx tools/phone-sim.mts 8787 wander` and `DEVICE=b ARM=right PHASE=7 npx tsx tools/phone-sim.mts 8787 wander`. They send the same hello, ARKit-style transforms and actions as the app (`calibrate` mode runs a full calibration first; `HOST=` points them at another machine). `npx tsx tools/act.mts 8787 phone-2 estop safety.estop true` presses a control as a phone, which is handy for testing your gates.
2. Start the bridge with `--dry-run` and check roster, pose, tracking, buttons and state for both phones.
3. With the robot disabled, verify the gates: Stop on either phone, deadman release, a phone disconnect, tracking `limited`, and a recalibration. Each must stop motion and drop the clutch anchor.
4. Then enable one arm at low scale, then both, then the lift and base.

## Known limits

- No authentication or TLS: private network or tailnet only.
- One gateway per robot; phones must reach it directly.
- A phone's identity comes from an id stored in the app's Documents folder. Restoring a backup onto a second phone clones it, and the two phones then replace each other.
- Pose timestamps are the phone's monotonic clock (`monotonicTs`). The ROS bridge stamps poses with receive time; latency on a good LAN is a few to tens of milliseconds.
- iOS only (ARKit).
