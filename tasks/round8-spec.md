# Round 8 spec: robots talk back, SDKs, pairing, reconnect, WebRTC video, screen kit

Brainstorm items 1, 2, 3, 4, 5, 6 (the WebRTC version) and 10, shaped by Axol's notes from building its bridge
(`almond_axol/marionette/` on `yashas-salankimatt/axol` `feat/marionette-teleop`, read-only copy in `/tmp/axol-ref`).
Branch: `feat/robot-platform` (local commits, nothing pushed). Axol work: a worktree of its `feat/marionette-teleop`.

## Ground rules

- **The gateway relays; the consumer decides** (tasks/lessons.md 2026-10-26). New gateway features route, retain and
  time-stamp data. They never gate motion, latch Stop or arbitrate between phones. Decisions live in the SDKs, as parts
  a consumer picks up, never a loop it must live inside.
- **Additive within protocol version 1.** Every new field is optional and every new message type is ignored by old
  clients. Axol's current bridge (a console sending flat `status`) must keep working against the new gateway on
  loopback. An old app build can still connect where pairing is off or from loopback; anything else needs the new build.
- Frames stay REP-103 (+X forward, +Y left, +Z up, metres).
- Permanent identifiers (state before anything registers them; nothing is published this round):
  Python distribution `marionette-sdk`, import name `marionette`; npm workspaces `@marionette/sdk` and `@marionette/kit`
  (private); URL scheme `marionette://`; Bonjour service `_marionette._tcp`; gateway identity file
  `~/.marionette/gateway.json`.

## 1. Protocol additions (`packages/protocol/src/index.ts`, written first; everything else builds on it)

- `JsonValue` type and `isJsonValue(value, maxBytes)` (finite numbers, depth ≤ 16).
- **Roles.** `HelloMessage.role` adds `'robot'`. New optional hello fields:
  - `token`: the pairing code (any role).
  - `sessionId`: a phone's current pose session, so a reconnect inside one ARKit session keeps its calibration.
  - `robotId` (`^[a-z0-9][a-z0-9-]{0,63}$`) and `name` (≤ 64 chars): a robot's stable id and display name.
- **Close codes.** 4401 pairing code missing or wrong; 4409 a robot with this id is already connected; 4001 replaced
  (exists).
- **`RobotInfo`** `{ id, name, connected, screen?: boolean, streams?: string[] }`, carried as `ConfigMessage.robots?`.
  `ConfigMessage` also gains `gatewayId?` (stable across restarts) and `auth?` (whether pairing is required).
- **`robot_state`** (robot → gateway → phones, mirrors, consoles):
  `{ type, version, robotId?, phoneId?, state: { [k]: JsonValue }, everyMs?, sentAt?, receivedAt? }`.
  ≤ 64 KB serialized. The gateway fills `robotId` and `receivedAt`. Retained per (robot, phone or all).
  `everyMs` is how often the robot re-sends it; a screen calls the robot unresponsive after `max(1500, 3 × everyMs)`.
- **`status.values`** may hold any `JsonValue` (≤ 16 KB), not only flat primitives.
- **`screen`** (robot → gateway): `{ type, version, html, title? }`. The gateway answers the robot with a `status`
  (`controlId: 'screen'`, `values.accepted`).
- **`ping` / `pong`** (either direction; whoever receives a ping answers):
  `ping { type, version, id: number, sentAt: number, rttMs?: number }` and
  `pong { type, version, id, sentAt (echoed), at: number }`. Times are wall-clock milliseconds with fractions. The
  gateway's pings to a phone carry `rttMs`, the round trip it last measured to that phone.
- **Latency stamps.** `PosePacket.sentAt?` (phone wall clock at send). Forwarded `pose` gains `receivedAt?` and
  `latencyMs?`; forwarded `input` gains `latencyMs?`. `latencyMs` is the gateway's estimate of phone-send to
  gateway-receive, using the clock offset from its pings (undefined until known).
- **`rtc`** (signaling only; media never touches the gateway):
  `{ type, version, kind: 'publish'|'unpublish'|'request'|'offer'|'answer'|'candidate'|'close'|'error', streams?,
  stream?, peer?, to?, from?, sdp?, candidate?: { candidate, sdpMid?, sdpMLineIndex? }, message? }`.
- `CameraStream` gains `transport?: 'jpeg' | 'webrtc'` and `publisher?: string` (robot id), both set by the gateway.
- `HtmlConfigMessage` gains `orientation?: 'portrait' | 'landscape' | 'any'` (from
  `<meta name="marionette-orientation" content="…">`) and `source?: { kind: 'default'|'file'|'robot', robotId? }`.
- **HTML bridge, still version 1, additive:**
  - events add `robot_state` (raw), `robots` (aggregated), `link`, `rtc`;
  - `Marionette.features` lists what the host supports: `live`, `robot_state`, `link`, `rtc`, `reconnect`, `orientation`;
  - `Marionette.rtc(message)` sends signaling through the host (validated by `validateHtmlBridgeRtc`);
  - `ConnectionEvent.state` adds `'reconnecting'`;
  - `robots` is built inside the bridge script from `config.robots` and `robot_state`:
    `{ [robotId]: { id, name, connected, state?, phoneState?, everyMs?, receivedAt? } }`, where `receivedAt` is the
    page's `Date.now()` at delivery and `phoneState` is the state addressed to this phone. Hosts replay every retained
    `robot_state` (one per robot and phone) to a freshly loaded page, not just the last one.
  - `link` payload: `{ rttMs?: number, quality: 'good' | 'fair' | 'poor' | 'unknown' }`
    (good < 60 ms, fair < 150 ms, otherwise poor).

## 2. Gateway (`apps/backend`)

- **Robots.** `role: 'robot'` is a console that may also send `screen`, `robot_state`, `status`, camera frames and `rtc`.
  It receives what a console receives (no camera frames unless it asks). Robots stay in the roster for the gateway's
  lifetime (`connected: false` when gone). A second connection with a connected robot's id is closed with 4409. The
  SDK retries, so it takes over once the first goes away.
- **Robot state.** Retain the latest per (robot, phone or all) and route: with `phoneId` to that phone, its mirrors and
  consoles; without it to every phone, mirror and console; never back to the sender. A phone, mirror or console that
  connects gets the retained states (all of them for consoles, its own and the global ones for a phone or mirror)
  right after its config. Robot state is kept when the robot disconnects; the roster says it is offline.
- **Robot screens.** A robot's `screen` replaces the current screen. The newest wins: a robot push or a save of
  `MARIONETTE_HTML_FILE`, logged either way. It is parsed like a file screen (the `marionette-config` block; a broken
  block is refused with a reply and the previous screen stays). The same HTML again is a no-op. The screen stays when its
  robot disconnects.
- **Kit inlining.** In every screen (default, file, env, robot), `<script src="marionette-kit.js"></script>` and
  `<link rel="stylesheet" href="marionette-kit.css">` are replaced by the kit inline, before the 512 KB check. Also
  serve both over HTTP.
- **Ping, link, latency.** Ping phones and robots every second, and answer every ping. Keep the last 16 RTT samples
  per client; the offset comes from the sample with the lowest RTT. Stamp forwarded poses (`receivedAt`, `latencyMs`)
  and inputs (`latencyMs`). Each ping to a phone carries its last `rttMs`. `/api/state` shows each phone's link.
- **Reconnect in place.** On disconnect, keep the phone's calibration and remember its session. If a phone's hello
  `sessionId` equals that session, the calibration stays (same ARKit world). Otherwise, or if its first pose is from
  another session, it is cleared as today. Holds and drags still end on disconnect, with the same reasons.
- **Pairing.** Identity in `$MARIONETTE_HOME/gateway.json` (default `~/.marionette`): `{ id: 'gw-…', token }`. The
  token is 8 characters of Crockford base32 shown as `K7Q2-M9XD` and compared ignoring case, dashes and spaces.
  - Environment: `MARIONETTE_TOKEN` fixes it; `MARIONETTE_AUTH=off|on|strict` (default `on`: loopback needs no token;
    `strict`: everyone does); `MARIONETTE_NAME` (default the host name); `MARIONETTE_MDNS=off`; `MARIONETTE_ADDRESSES`
    overrides the advertised hosts.
  - The token may come as a `?token=` URL parameter or in the hello. An unauthorised socket gets nothing until a valid
    hello; any other message, or 3 s of silence, closes it with 4401. Five bad codes a minute from one address closes
    every further attempt from it with 4401 for a minute.
  - HTTP `/api/*` and `/screen` need the token (`?token=`, `Authorization: Bearer`) unless loopback or off; `/health`
    stays open. `/screen?token=` passes it to its bridge.
  - Pairing link: `marionette://pair?v=1&host=<h1,h2>&port=<p>&code=<token>&id=<gatewayId>&name=<name>`. On start the
    gateway prints the code, the link and a terminal QR code (npm `qrcode`). `GET /api/pairing` (loopback or token)
    returns `{ gatewayId, name, code, addresses, port, url, qrSvg }`.
  - Bonjour: advertise `_marionette._tcp` with TXT `{ id, name, v: '1', auth: '0'|'1' }` (npm `bonjour-service`).
- **WebRTC signaling.** Every socket gets a client id (`c1`, `c2`, …).
  - A robot's `publish { streams }` registers it as the producer of those declared streams. They then show
    `transport: 'webrtc'` and `publisher` in the config, and the gateway stops drawing `sim://` frames for them.
  - A viewer's `request { stream, peer }` goes to the producer with `from: <viewer client id>`; with no producer it
    gets `error`.
  - `offer`, `answer`, `candidate` and `close` carry `to` and `peer`; the gateway checks the pair belongs to one
    request and stamps `from`.
  - When either side goes away, the other gets `close` for each of their peers.
  - Phones, mirrors and consoles can all request.
- **Structured status:** a console's or robot's `status.values` may be nested JSON. The relay copies it.
- **Single-file bundle:** `npm --workspace @marionette/backend run bundle` writes `apps/backend/dist/marionette-gateway.mjs`
  (esbuild, with the default screen and the kit embedded), which runs with plain `node`.
- Tests for each of the above. Existing tests keep passing; one asserts a same-session reconnect keeps calibration.

## 3. Screen kit (`packages/kit`)

Plain JavaScript, no build: `marionette-kit.js` (a classic script defining `window.MarionetteKit`),
`marionette-kit.css`, and `marionette-kit.d.ts` (types for `window.Marionette` and the kit). Built from the
default screen's parts, so the behaviour is the one already on device. A screen opts in with the two tags above.

- `hold(button, { controlId, action })`, with idle, pending, held and dropped states as data attributes.
- `slider(input, …)` and `stick(pad, …)`: live streaming with the same states.
- `letGoOnLeave(group)`: release when the page loses focus or is hidden, or a sheet opens.
- `stop()`: the floating Stop toggle, the banner and Reset.
- `strip()`: the phone's name and color, tracking, link quality and the connection, including reconnecting.
- `toast(text)`.
- `robots` / `robot(id?)`: subscribe to robot state, with `stale` (no update for `max(1500, 3 × everyMs)`) and
  `offline`.
- `cameras(el)`: the panes of the phone's selected view, JPEG or WebRTC per stream (WebRTC only when the host lists
  `rtc` and the stream is `transport: 'webrtc'`). Requests open on view change, close when it changes or the page
  hides, and retry after an error. Several panes side by side; a tap stacks them.
- `calibration`: the whole guided calibration, quick origin and optional validation sheet, moved out of the default
  screen.
- `controlRow(control)`: the generic row for any control a screen doesn't place.
- `apps/backend/src/sample-controls.html` is rewritten on the kit with the same behaviour and copy, and much shorter.
- Tests: vitest + jsdom for the state machines (holds, drags, staleness, the WebRTC request flow against a fake
  `RTCPeerConnection`). Look at it rendered (headless Chrome) on phone-sized windows, portrait and landscape.

## 4. Phone app (`apps/mobile`, `modules/`)

- **Reconnect in place.** After a connection that opened, a drop keeps the WebView and ARKit running and shows a
  native "Reconnecting to …" banner with **Leave**. It retries with backoff (0.5 s doubling to 5 s) until it connects,
  the operator leaves, or the gateway refuses pairing (4401, back to the connect page asking for the code).
  - The hello carries `sessionId` and the token.
  - The WebView doesn't reload when the gateway sends the same HTML again.
  - Holds and drags are released on drop, as today.
  - When the gateway sends pings, 3.5 s without any message counts as a drop.
- **Ping:** answer every `ping` with a `pong`, and turn `rttMs` into the `link` bridge event. Every pose carries `sentAt`.
- **Relays:** `robot_state` goes to the page, replayed per robot and phone. `rtc` goes both ways. `Marionette.features`
  says what this host supports.
- **WebView:** `allowsInlineMediaPlayback` and `mediaPlaybackRequiresUserAction={false}`, for WebRTC `<video>`.
- **Pairing:**
  - `scheme: 'marionette'` deep links (iOS Camera opens a scanned QR in the app).
  - A **Scan QR code** button (expo-camera).
  - **Nearby** gateways via Bonjour: a new local Expo module `modules/discovery` (Swift `NWBrowser` plus endpoint
    resolution), with `NSBonjourServices` and `NSLocalNetworkUsageDescription`.
  - Codes are saved per gateway id and address, and a pairing-code field appears when a gateway asks for one.
  - A pairing link tries each host and uses the first that answers.
- **Orientation and iPad:** `orientation: 'default'` and `supportsTablet: true`. A screen's `orientation` locks it
  (expo-screen-orientation), unlocked on the connect page. The connect page works in landscape.
- App `version` 1.1.0.
- Checks: typecheck, lint, and an iOS simulator build. A headless simulator run (`simctl boot`, never Simulator.app,
  never osascript) opens a pairing link with `simctl openurl` and takes screenshots.

## 5. Python SDK (`sdk/python`, distribution `marionette-sdk`, import `marionette`)

A set of parts, not a framework. Dependencies: `websockets>=13`, `numpy`. Extras: `video` (`aiortc>=1.14`) and
`gateway` (`nodejs-wheel-binaries`, for robots without Node).

- `address`: `gateway_url()` (as the app parses addresses) and `parse_pairing_link()`.
- `GatewayClient`: a reconnecting connection.
  - Role `console` or `robot`; a token; hello fields.
  - An outbox keyed for coalescing: newest-only for state and frames, never coalesced for notices. Small and
    time-critical messages go first.
  - Thread-safe `send` from control threads.
  - Pings the gateway for its clock offset, so ages can be computed.
  - `connected` and `error` (a clear message for 4401 and 4409); `on_lost`.
  - Async and background-thread forms.
- `PhoneTracker`: folds config, pose and input into one `Phone` per id. It learns holds and drags from the layout
  (button `hold`, slider, joystick), with no hard-coded actions. Thread-safe snapshots. The rules from Axol:
  - A repeat only extends a hold that is down.
  - Press edges are counted, for holds and plain buttons alike.
  - A drag the gateway ended stays ended (`dropped`) until the finger lifts.
  - Slider values come from inputs.
  - Stop acts from the press itself.
  - A lost gateway means everyone lets go.
  - A restarted gateway gives new ids, but a phone left with Stop on survives as `<id>@<old gateway>` until
    `clear_stale_stops()`.
  - Mirror policy: `allow`, `stop-only` (default) or `deny`.
  - Pose ages use the latency stamps.
  - Each phone also gives `to_conformance()`.
- `teleop` (numpy only):
  - `gate()` returns a reason or None: connected, calibrating, calibration required, pose age and latency, source,
    tracking.
  - `Clutch`: engage, then target with scale, rotation scale and a frame `F`. It unwraps turns past half a turn, and
    `rescale` and `reframe` never move the target. `anchor_valid` checks session and calibration.
  - `camera_frame(optical)`, `unwrap_turn`, `rotation_vector`, `exp_rotation`, `JumpDetector`, `PressTracker`
    (each press consumed once), `follow()` (a rate limiter) and an opt-in `owners()`.
- `RobotLink`: a robot-role client.
  - `screen` (HTML or a path, with `watch` to re-push on save).
  - `state(dict, phone=None)`, re-sent every `every` seconds and at once on change.
  - `notice()`, `send_jpeg()`, and an optional tracker it feeds.
- `video.VideoPublisher(link)`: `push(stream, rgb)` from any thread. Each `request` gets an aiortc peer connection with
  H.264 preferred (VP8 fallback), sends a non-trickle offer and handles `close`. Publishes its streams.
- `marionette.gateway`: runs the bundled gateway (`_gateway/marionette-gateway.mjs`, copied from the backend bundle)
  with Node 20+ or `nodejs-wheel-binaries`; a `marionette-gateway` console script.
- `marionette.testing`:
  - message builders, so tests stop writing gateway messages by hand;
  - `Gateway()`, a context manager running the real bundled gateway on a free port (auth off, mDNS off, temporary log
    directory);
  - `SimPhone`, a scriptable phone: hello and device id, poses in operator terms converted to ARKit raw, press,
    release, hold, drag, stick, set, guided calibration and quick origin, disconnect and reconnect (same or new
    session), and tracking state.
- Conformance fixtures in `sdk/conformance/tracker/*.json`: messages, time steps and expected `to_conformance()`
  shapes, run by both SDKs.
- The ROS 2 bridge gains `--token` and accepts a pairing link.
- pytest: unit tests plus integration tests against `testing.Gateway()`.

## 6. TypeScript SDK (`packages/sdk`, `@marionette/sdk`)

The same parts as the Python SDK, minus video and the gateway runner: `GatewayClient` (browser `WebSocket` or Node
`ws`), `PhoneTracker`, teleop math, `RobotLink`, and `testing` (`startGateway()` in-process, `SimPhone`). It passes the
conformance fixtures. `tools/phone-sim.mts` and `tools/act.mts` move onto it.

## 7. Viewer (`apps/viewer`)

- The connect page accepts a pairing code (asked for on 4401) or a pasted pairing link.
- Robots in the roster, and a robot-state inspector (global and per phone, as a JSON tree, with stale and offline).
- Each phone's latency, from the stamps.
- **Pair a phone:** the QR code, the code and the addresses, from `/api/pairing`.
- Camera panes play WebRTC streams and fall back to JPEG.

## 8. Axol (worktree of `feat/marionette-teleop`)

- `gateway.py` is replaced by the SDK's `RobotLink` (robot id `axol`, name `Axol`).
- `phones.py` keeps only Axol's meanings over the SDK's `PhoneTracker` (arm, frame, scale, speed, grip, resets,
  base command).
- `teleop.py`: the clutch, gates, jump detection and press edges come from the SDK. Axol keeps its filter, limits,
  reach and `owners` policy, or the SDK's opt-in `owners`.
- The screen moves into the Axol repo, rebuilt on the kit. The robot sends it on connect.
- Feedback goes out as `robot_state` with real lists and nulls (`frames`, `streams`, battery and lift `null` when
  unknown); notices as `status`.
- Cameras over WebRTC from `CameraHub` frames, with JPEG kept as the fallback.
- Tests move to `marionette.testing` (the real gateway plus SimPhones). Axol's suite passes, and a sim session drives
  an arm from SimPhones.
- `marionette-sdk` comes in through uv sources until it is published (flag: Axol's PyPI metadata can't carry a git
  dependency).

## 9. Verification (sim only; no robot)

1. Gateway with pairing on, the Python example sim robot (robot screen on the kit, 5 Hz structured state, notices,
   WebRTC test-pattern cameras, a virtual gripper through `Clutch`) and Python SimPhones:
   - calibrate, hold and move: the target follows, scaled;
   - a scaled turn past 180° stays continuous;
   - a gateway restart with Stop on keeps Stop;
   - a dropped drag stays dropped;
   - a same-session reconnect keeps calibration;
   - a 4409 duplicate robot is refused.
2. The `/screen` mirror in the T3 browser preview: WebRTC video playing, robot state, stale and offline when the robot
   is killed, the link indicator, calibration.
3. The headless iOS simulator: open a pairing link, then screenshots of the robot screen with video, the Reconnecting
   banner when the gateway stops, and recovery when it starts again.
4. Axol sim with SimPhones: an arm follows, the screen comes from the robot, cameras arrive over WebRTC, and Axol's
   tests pass.
5. Viewer: the robots panel, the Pair modal and WebRTC panes, in the T3 preview.
6. Review: Opus 5.5 xhigh reviewers per area; fix large, realistic findings only. Bounded to two rounds, with the stop
   rule "no P0/P1 left".
