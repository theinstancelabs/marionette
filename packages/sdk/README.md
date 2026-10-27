# @marionette/sdk

Parts for TypeScript robots (Node) and consoles (Node or a browser) that use Marionette phones. It is a set of parts, not a framework: your robot runs its own control loop and calls these. It has the same parts and semantics as the Python SDK (`sdk/python`), minus video publishing and the gateway runner.

| Import | What | Runs in |
|---|---|---|
| `@marionette/sdk` | `GatewayClient`, `PhoneTracker`, the teleop parts and math, `RobotLink` | Node and browsers |
| `@marionette/sdk/node` | the same, plus `watchScreen()` | Node |
| `@marionette/sdk/testing` | `startGateway()`, `SimPhone`, `messages` | Node |

It is a private workspace package (`npm install` at the repository root links it). In Node it uses the `ws` package; in a browser, the global `WebSocket`. Times are milliseconds throughout: wall-clock ms for stamps, and the tracker's clock (monotonic ms by default) for timeouts.

## GatewayClient

A reconnecting connection to a gateway.

```ts
import { GatewayClient } from '@marionette/sdk';

const client = new GatewayClient('192.168.1.20', { role: 'console', cameras: false, token: 'K7Q2-M9XD' });
client.on('connect', () => console.log('connected'));
client.on('lost', () => console.log('lost the gateway: treat it as everyone letting go'));
client.on('error', (message, code) => console.warn(message)); // 4401: pairing code; 4409: robot id in use
client.on('message', message => { /* every config, pose, input, status, robot_state… */ });
for await (const message of client) { /* or iterate */ }
client.close();
```

- The address can be an IP, `host:port`, a `ws://`/`wss://`/`http(s)://` URL, or a `marionette://pair?…` link. With a link, it tries each host in turn, and the link's code is the token.
- Role `console` (the default) only listens. It can also send notices to the phones. Role `robot` needs a `robotId` (lower-case letters, digits and dashes) and may send its screen, state and frames; `RobotLink` wraps it.
- It reconnects with backoff, 0.5 s doubling to 5 s. It counts as connected once the gateway's config arrives. A wrong or missing pairing code (4401) and a robot id that is already connected (4409) each get a clear `error`, and it keeps retrying. A robot that retries takes over once the other connection with its id goes away. A connection that hears nothing for 3.5 s is dropped and retried.
- It answers the gateway's pings, and pings the gateway every second: `offsetMs` is our clock minus the gateway's (from the fastest of the last 16 round trips), `rttMs` the last round trip, `gatewayNow()` the gateway's clock.
- `send(message, { key })` goes through an outbox. Messages with the same key replace each other while they wait (newest only). By default robot state is keyed per phone and camera frames per stream, and everything else (notices included) is never coalesced. Small messages go before camera frames, and frames wait while more than 1 MB is unsent. While disconnected `send()` returns false and drops the message.

## PhoneTracker and Phone

Folds the gateway's `config`, `pose` and `input` messages into one `Phone` per id. It decides nothing.

```ts
import { GatewayClient, PhoneTracker } from '@marionette/sdk';

const tracker = new PhoneTracker({ mirror: 'stop-only', stopAction: 'safety.estop' });
tracker.attach(client); // feeds it messages, lostGateway() on loss, and the clock offset for pose ages

setInterval(() => {
  const now = tracker.now();
  for (const phone of tracker.snapshot().values()) {
    if (phone.stop) { /* stop everything */ }
    const moving = phone.holding('teleop.deadman', now);   // held, and its renewals arriving (600 ms)
    const scale = phone.number('teleop.translationScale', 1, 0.05, 4);
    const arm = phone.choice('arm.select', ['left', 'right'] as const, 'left');
    const drive = phone.stick('base.drive', now);          // { x, y }; rest when untouched; undefined when it went quiet
    const age = phone.pose?.age(now);                      // ms, from the gateway's stamps and our clock offset
  }
}, 8);
```

It learns holds, drags and buttons from the layout in the configs. No actions are built in apart from Stop. The rules, which the Python SDK shares (see the conformance fixtures below):

- A repeat (`renew`) only extends a hold that is already down; it never starts one.
- Press edges are counted, for holds and plain buttons alike (`presses(action)`). Presses and values of actions no control declares are counted and kept too.
- A drag the gateway ended stays ended (`dropped`) until the operator lets go, whatever samples still arrive. A stick rests; a slider keeps its value.
- Slider and stick values come from the live inputs, because the config only follows a drag's start and end. A config never overwrites a live drag.
- Stop acts from the press itself, before the config follows.
- `lostGateway()` (called for you by `attach`) and a phone dropping let go of everything: no pose, no holds, no drags. Stop stays.
- A restarted gateway names phones afresh. A phone left with Stop on is kept, offline and out of reach, as `<id>@<old gateway session>`. The same goes for a phone that leaves the roster with Stop on (an app too old to say hello), kept as `<id>@<gateway session>`. Phones kept like this stay until `clearStaleStops()`. That call also turns Stop off on offline phones that have it on, and that holds until they reconnect.
- Mirror policy, for the gateway's desktop `/screen` mirror. `allow` treats its inputs like the phone's. `stop-only` (the default) lets it turn Stop on and nothing else; a config can't turn Stop off either, since the gateway republishes a mirror's Stop off. `deny` ignores it.
- Malformed messages are ignored.

| `Phone` | |
|---|---|
| `id`, `name`, `color`, `connected`, `session`, `ordinal` (`phone-2` → 2), `stale` | identity |
| `values`, `value(action)`, `number(action, fallback, min, max)`, `choice(action, options, fallback)` | control values by action |
| `stop` | the Stop action is `true` |
| `hold(action)` → `{ down, at, presses }`, `holding(action, now, timeoutMs = 600)` | hold buttons |
| `drag(action)` → `{ kind, live, dropped, value, at }`, `stick(action, now, timeoutMs = 250)` | sliders and sticks |
| `presses(action)` | press count; compare counts, or use `PressTracker` |
| `calibration` (`uncalibrated`, `capturing`, `captured`), `epoch` | re-anchor when the epoch changes |
| `pose`: `position` `[x, y, z]`, `rotation` (3×3), `quaternion`, `tracking`, `source`, `calibration`, `session`, `seq`, `stamp`, `sentAt`, `receivedAt`, `latencyMs`, `age(now)` | the operator-frame pose, or `null` |
| `copy()`, `toConformance()` | |

`tracker.snapshot()` (copies), `tracker.get(id)`, `tracker.anyStop()`, `tracker.gateway` (its session) and `tracker.apply(message)` for feeding it by hand.

## Teleop parts

Plain arrays and no dependencies: vectors `[x, y, z]`, rotations as 3×3 row-major matrices, quaternions as the protocol's `{ x, y, z, w }`. The defaults are Axol's (`TELEOP_DEFAULTS`).

```ts
import { Clutch, JumpDetector, PressTracker, cameraFrame, follow, gate, TELEOP_DEFAULTS, type Phone, type Pose } from '@marionette/sdk';

const clutch = new Clutch({ rotationScale: 1 });
const presses = new PressTracker('teleop.deadman');
const jumps = new JumpDetector();

function tick(phone: Phone, tip: Pose, now: number) {
  if (presses.pressed(phone) && !gate(phone, now, { requireCalibration: true })) {
    clutch.engage(phone.pose!, tip, { scale: phone.number('teleop.translationScale', 1, 0.05, 4), frame: undefined /* or cameraFrame(optical) */ });
    jumps.reset(phone.pose);
  }
  if (!clutch.engaged) return;
  const reason = !phone.holding('teleop.deadman', now) ? 'let go' : gate(phone, now)
    ?? (!clutch.anchorValid(phone.pose) ? 'Tracking restarted.' : jumps.check(phone.pose) ? 'Tracking jumped.' : undefined);
  if (reason) { clutch.release(); return; }
  const target = clutch.target(phone.pose!, phone.number('teleop.translationScale', 1, 0.05, 4)); // a new scale never moves it
  // filter target, then rate-limit it: velocity = follow(error, velocity, TELEOP_DEFAULTS.maxSpeed, TELEOP_DEFAULTS.maxAccel, dt)
}
```

- `gate(phone, now, { poseTimeoutMs = 250, maxLatencyMs, allowSynthetic, requireCalibration })` returns the reason a phone can't drive, or undefined. The checks: offline, calibrating, not calibrated (if required), no fresh pose, a slow link (if limited), simulated motion, no ARKit, tracking that isn't normal.
- `Clutch` maps a phone pose to a target relative to the anchor taken at `engage`: `p = E0.p + s·F·(P.p − P0.p)` and `R = exp(r·s·F·θ)·E0.R`. Here `θ` is the phone's turn since the anchor, followed continuously past half a turn, so a scaled turn never jumps. `rescale` and `reframe` take up a new scale or frame `F` from where the target is, so they never move it. `anchorValid(pose)` checks the ARKit session and calibration.
- `cameraFrame(optical)` is `F` for moving in a camera's frame, built from its ROS optical frame's rotation: the phone's forward goes along the view.
- `JumpDetector` flags an ARKit correction: a step over 4 cm at more than 4 m/s, or a turn over 0.5 rad at more than 20 rad/s. `PressTracker` consumes each press once, and presses from before it saw a phone don't count. `follow` is the rate limiter. `owners(phones, current, { choices, choose })` is an opt-in policy: the phone that engaged a choice keeps it, otherwise the lowest-numbered phone choosing it gets it.
- Math: `unwrapTurn`, `rotationVector`, `expRotation`, `matrixFromQuaternion`, `quaternionFromMatrix`, `matMul`, `matVec`, `transpose`, `identity`, `add`, `sub`, `scale`, `dot`, `norm`.

## RobotLink

A robot's connection: a `GatewayClient` with role `robot` that keeps what the robot says.

```ts
import { RobotLink } from '@marionette/sdk';
import { watchScreen } from '@marionette/sdk/node';

const link = new RobotLink('localhost', { robotId: 'humanoid', name: 'Humanoid', everyMs: 200, tracker: true });
const result = await link.setScreen(html, 'Humanoid');  // { accepted, message, warnings }; sent again on every reconnect
// or, in Node: const { ready, stop } = watchScreen(link, 'config/humanoid.html'); — sent again on every save
link.state({ engaged: { left: true, right: false }, battery: 0.82, lift: null });  // for every phone
link.state({ arm: 'left', blocked: 'Calibrate this phone first' }, 'phone-1');      // for one phone
link.notice('Lift at its top', { phoneId: 'phone-1' });                            // a one-off status, controlId robot.notice
link.sendJpeg('head', jpegBytes, capturedAtMs);                                    // newest frame per stream
link.tracker!.snapshot();                                                           // the phones, from the same connection
```

- State is any JSON object up to 64 KB. It goes out at once when it changes, again every `everyMs` while it stays the same, and again on reconnect. `state(null, phoneId)` stops re-sending one.
- `link.on('screen', result => …)` hears every answer to a screen. A screen with a broken `marionette-config` block is refused, and the previous one stays.
- WebRTC video isn't published from TypeScript. Send JPEG frames (`sendJpeg`), or use the Python SDK's `VideoPublisher` for video. Signaling messages can still go through `link.send()`.

## Testing

`@marionette/sdk/testing` runs a robot's tests against what it will meet on the day: the real gateway, in-process, and scriptable phones.

```ts
import { RobotLink } from '@marionette/sdk';
import { SimPhone, messages, startGateway } from '@marionette/sdk/testing';

const gateway = await startGateway();                 // pairing and Bonjour off, a temporary home, a free port
const link = new RobotLink(gateway.url, { robotId: 'axol', tracker: true }); await link.client.whenConnected();
const phone = await SimPhone.connect(gateway.url, { deviceId: 'left-hand' });
await phone.calibrate();                               // guided calibration through the gateway
phone.press('teleop.deadman');                         // renewed every 200 ms until release()
phone.moveTo({ x: 0.1, y: 0, z: 0 });                  // where consumers will see it, in its operator frame
phone.stick('base.drive', { x: 0.5, y: 0 }); phone.letGo('base.drive');
phone.pauseRenewals();                                 // the link freezes: the gateway ends holds and drags
await phone.reconnect();                               // same ARKit session: calibration kept ({ newSession: true }: not)
await gateway.restart();                               // same port and gateway id, new session and phone ids
await gateway.close();
```

- `startGateway(options)` takes the gateway's own options (`auth: 'strict', token`, `holdTimeoutMs`, …). It returns `url`, `port`, `http`, `state()` (`/api/state`), `restart()` and `close()`.
- `SimPhone` says hello with a device id and session, and streams raw ARKit poses at 60 Hz, converted from operator-frame targets (`moveTo`, `glideTo`) through the protocol's `rawPoseFor`, or placed physically relative to where it started (`place`, `glide`). It answers pings, optionally with a clock offset (`clockOffsetMs`). The controls: `press`/`release`/`hold`, `tap`, `set`, `drag`/`stick`/`letGo`, `act`, and `request(action, value)`, which waits for the gateway's reply. Calibration: `calibrate()`, `validate()`, `quickOrigin()`. Connection: `setTracking`, `disconnect`, `reconnect`. With `mirrorOf: 'phone-1'` it is a desktop mirror instead. `messages`, `statuses()`, `robotStates()`, `config` and `waitFor()` show what it received.
- `messages.config / phone / pose / input / robotState` build gateway messages for unit tests.

`tools/phone-sim.mts` and `tools/act.mts` are built on `SimPhone` (see the README's "Developing without iPhones").

## Conformance fixtures

`sdk/conformance/tracker/*.json` holds messages, time steps and expected phone shapes (`Phone.toConformance()`). Both SDKs run every fixture: `test/conformance.test.ts` here, and the Python suite. The fixtures prefixed `ts-` come from this SDK and those prefixed `py-` from the Python one. A fixture lists `steps`: `{ "message": … }`, `{ "advance": seconds }`, `{ "lost": true }`, `{ "clear_stale_stops": true }`, or `{ "expect": { "phones": { id: partial phone }, "absent": [ids], "any_stop": bool } }`. Clocks start at 1000.0 s, and expected phones match partially and recursively.

## Checks

```sh
npm --workspace @marionette/sdk test        # unit tests, the fixtures, and integration tests against the real gateway
npm --workspace @marionette/sdk run typecheck
```
