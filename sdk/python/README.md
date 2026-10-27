# marionette-sdk: Marionette for Python robots

The Python SDK for [Marionette](../../README.md): the parts every robot driven by Marionette phones would otherwise
write itself. Distribution `marionette-sdk`, import `marionette`.

It is a set of parts, not a framework. Your robot keeps its own control loop, IK, smoothing and rules for who drives
what; it picks up the parts it needs:

| Part | What it does |
|---|---|
| `GatewayClient` | A reconnecting connection to a gateway, as a console or a robot. Thread-safe sending through an outbox that keeps only the newest state and frames, a clock offset from pings, clear errors for pairing (4401) and a duplicate robot id (4409). |
| `PhoneTracker`, `Phone` | Each phone's holds, drags, presses, values, pose and Stop, folded from the gateway's messages with the rules Axol learned on a real robot. |
| `marionette.teleop` | `gate` (why a phone can't drive right now), `Clutch` (relative teleop with scale, rotation scale and a frame), `camera_frame`, `JumpDetector`, `PressTracker`, `follow` (a rate limiter), `owners`. numpy only. |
| `RobotLink` | A robot's own connection: its phone screen, its state, notices and JPEG frames. |
| `marionette.video.VideoPublisher` | WebRTC video from numpy frames, straight to each viewer (`[video]` extra). |
| `marionette.gateway` | The gateway itself, bundled, run from Python or as `marionette-gateway`. |
| `marionette.testing` | Gateway message builders, the real gateway on a free port, and scriptable phones. |

Frames are ROS REP-103 throughout: +X forward, +Y left, +Z up, metres.

## Install

Python 3.12 or later. From the repository (nothing is published to PyPI yet):

```sh
pip install "marionette-sdk @ git+https://github.com/theinstancelabs/marionette.git#subdirectory=sdk/python"
pip install "marionette-sdk[video,gateway] @ git+https://github.com/theinstancelabs/marionette.git#subdirectory=sdk/python"
uv add "marionette-sdk @ git+https://github.com/theinstancelabs/marionette.git#subdirectory=sdk/python"
```

From a checkout: `pip install -e path/to/marionette/sdk/python`, or with uv, in your `pyproject.toml`:

```toml
[tool.uv.sources]
marionette-sdk = { path = "../marionette/sdk/python", editable = true }
```

It needs `websockets>=13` and `numpy>=1.26`. Extras: `video` adds `aiortc>=1.14` for `VideoPublisher`; `gateway` adds
`nodejs-wheel-binaries` so `marionette-gateway` runs on a robot without Node 20+. The test suite passes with
websockets 13, 15 and 17, numpy 2.2 and 2.5, and aiortc 1.14 and 1.15.

## Connect to a gateway

```python
from marionette import GatewayClient

client = GatewayClient("192.168.1.20", token="K7Q2-M9XD", on_message=print).start()   # a background thread
client.wait_connected(5)
...
client.stop()
```

The address is anything the iPhone app accepts (`192.168.1.20`, `robot.local:9000`, `ws://…`, `https://…`) or the
gateway's pairing link (`marionette://pair?…`), whose hosts are tried in turn and whose code is used. On the gateway's
own computer no code is needed.

- **Roles.** `role="console"` (the default) watches every phone. `role="robot", robot_id="arm", name="Arm"` also talks
  back; most robots use `RobotLink` instead. `cameras=True` asks for JPEG camera frames.
- **Reconnecting.** It retries for ever, after 0.5 s doubling to 5 s (from 5 s doubling to 30 s when the pairing code
  is refused, to stay under the gateway's lockout). `connected` is True from the gateway's first config; `error` says
  why the last attempt failed, in plain words: `Pairing code missing or wrong (…)`, `Another robot with id 'arm' is
  connected …; retrying until it goes away` (it takes over once the first one goes), or `Can't reach …`.
- **Listening.** `client.on("message" | "connect" | "lost", callback)`, or the `on_message`, `on_connect` and
  `on_lost` arguments. Callbacks run on the client's event loop, so keep them short. In asyncio code,
  `async for message in client.messages():`.
- **Sending**, from any thread: `client.send(message)` for a message that must go (a notice), and
  `client.queue(key, message)` for one where only the newest matters (state, a frame): a newer one under the same key
  replaces one still waiting. Camera frames wait until every small message has gone. While disconnected, sending
  returns False and drops the message.
- **Clocks.** It pings the gateway every second. `offset_ms` is the gateway's clock minus this computer's (from the
  fastest of the last 16 round trips) and `rtt_ms` the last round trip, timed on the monotonic clock. When this
  computer's clock is set (NTP stepping it, say), `offset_ms` is None from that moment until it is measured again,
  which it is at once. It answers the gateway's pings too.
- **asyncio.** `await client.run()` runs it inside your own loop (stop it with `await client.aclose()`), or
  `async with GatewayClient(…) as client:`.

`marionette.address` has the address rules on their own: `gateway_url(text)`, `parse_pairing_link(text)`,
`normalize_code(code)` and `format_code(code)`.

## Phones

```python
import time
from marionette import PhoneTracker

tracker = PhoneTracker()             # mirror="stop-only", stop_action="safety.estop"
tracker.attach(client)               # or feed it yourself: tracker.apply(message), tracker.lost_gateway()

now = time.monotonic()
for phone in tracker.snapshot().values():   # copies, safe to read without a lock
    phone.holding("teleop.deadman", now)     # held, and its 200 ms repeats still arriving
    phone.presses("teleop.deadman")          # press edges so far (pair with PressTracker)
    phone.number("teleop.translationScale", 1.0, 0.1, 3.0)
    phone.choice("arm.select", ("left", "right"), "left")
    phone.stick("base.drive", now)           # (x forward, y left); (0, 0) at rest; None if its samples stopped
    phone.pose                               # Pose or None
tracker.any_stop()
```

It knows no actions by name. Holds are the screen's buttons with `hold: true`, drags its sliders and sticks, and
everything else is read by control type, so the same tracker serves any screen. Each `Phone` has:

- `value(action, default)`, `number(action, default, lo, hi)`, `choice(action, options, default)`, `flag(action)`;
- `hold(action)` (`down`, `at`, `presses`) and `holding(action, now, timeout=0.6)`;
- `drag(action)` (`value`, `live`, `dropped`, `at`, and `updates`: new values the tracker took from inputs so far,
  not counting repeats, configs, or anything a mirror did unless mirrors may act) and
  `stick(action, now=None, timeout=0.25)`;
- `presses(action)` for plain buttons and holds alike;
- `stop`; `connected`, `name`, `color`, `index` (2 for `phone-2`), `session`; `calibration` (`uncalibrated`,
  `capturing` or `captured`) and `epoch`;
- `pose`: `position` (3,), `rotation` (3×3), `quaternion` (x, y, z, w), `tracking`, `source`, `heartbeat`,
  `calibration` (the gateway's `calibrationVersion`), `session`, `seq`, `received` (the tracker's clock), `stamp` (the
  phone's clock), `sent_at`, `received_at`, `latency_ms` (phone to gateway), `hop_ms` (gateway to here), and
  `age(now)`: seconds since the phone sent it, as far as the stamps tell;
- `to_conformance()`, the shape the shared fixtures check.

The rules, each learned on a robot:

- A repeat (`renew`) only extends a hold that is already down: it never presses again, so a repeat that races a
  release can't restart the hold. The gateway's `held: false` ends a hold; its `held: true` never starts one.
- Press edges are counted, for hold buttons and plain buttons alike.
- A drag the gateway ended (its samples stopped for 400 ms) stays ended, `dropped`, until the finger lifts, whatever
  samples still arrive. A stick comes back to rest; a slider keeps its value.
- Slider and stick values come from the live inputs; the gateway's config only follows a drag's start and end.
- Stop acts from the press itself, not from the config that follows it.
- `lost_gateway()` (called for you when the connection drops): everyone is offline and lets go. Stop stays on.
- A restarted gateway names phones afresh, but a phone left with Stop on survives, offline, as
  `<id>@<old gateway session>` until `clear_stale_stops()`. So does a phone that vanishes from the roster with Stop on.
- `clear_stale_stops()` forgets those, and turns Stop off on offline phones of this gateway (they can't turn it off
  themselves) until they come back.
- A desktop mirror of a phone's screen (the gateway's `/screen`) acts as that phone. `mirror="allow"` treats it like
  the phone; `"stop-only"` (the default) lets it turn Stop on and nothing else; `"deny"` ignores it.
- Unless mirrors may act, the configs the gateway republishes after a mirror's changes can't carry them either. A
  phone's toggles, selects, sliders and sticks are only *seeded* from its config: the first time the tracker sees the
  phone, after `lost_gateway()` or a gateway restart, after the phone left the roster, for a control new to the
  screen (or now of another kind), and for a value that no longer suits its control. After that they follow the
  phone's own inputs. A drag the gateway ends takes the gateway's value only if the tracker saw it live (otherwise it
  was a mirror's): a slider keeps its value, a stick rests. A config may turn Stop on, but once the phone is known
  only the phone itself turns it off.
- The gateway's own inputs only end holds and drags.
- A new phone starts from the screen's defaults (the gateway's own config, without `phone`), never from another
  phone's values; its own config brings its values.
- Anything malformed is ignored.

### Meanings on top

A robot's own meanings are a few lines over `Phone`. Axol's, for example:

```python
ARM, FRAME, SCALE, SPEED = "arm.select", "teleop.frame", "teleop.translationScale", "base.speedLimit"

def arm(phone): return phone.choice(ARM, ("left", "right"), "left")
def frame(phone): return phone.choice(FRAME, ("axol", "head", "left", "right"), "axol")
def scale(phone): return phone.number(SCALE, 1.0, 0.05, 4.0)
def speed(phone): return phone.number(SPEED, 50.0, 0.0, 100.0) / 100.0
def grip(phone): return phone.drag("gripper.set").value       # act on each new one: drag(...).updates
def base_command(phone, now):
    stick = phone.stick("base.drive", now)
    turns = [phone.hold(a) for a in ("base.turnLeft", "base.turnRight")]
    if stick is None or any(h.down and not h.live(now, 0.6) for h in turns):
        return None                                           # a control still touched has gone quiet: stop now
    return (*stick, float(turns[0].down) - float(turns[1].down))
```

## Teleop parts

```python
from marionette import Clutch, JumpDetector, PressTracker, gate
from marionette.teleop import camera_frame, follow

clutch, jumps, presses = Clutch(), JumpDetector(), PressTracker("teleop.deadman")

def tick(phone, now, tip_position, tip_rotation):
    if presses.pressed(phone) and not clutch.engaged and gate(phone, now) is None and phone.holding("teleop.deadman", now):
        clutch.engage(phone.pose, tip_position, tip_rotation, scale=phone.number("teleop.translationScale", 1.0, 0.1, 3.0))
        jumps.reset(phone.pose)
    if clutch.engaged:
        if not phone.holding("teleop.deadman", now) or gate(phone, now) or not clutch.anchor_valid(phone.pose) or jumps.check(phone.pose):
            clutch.release()                     # only a fresh press engages again
        else:
            return clutch.target(phone.pose)     # (position, rotation) for your IK, after your own limits
```

- `gate(phone, now, *, pose_timeout=0.25, max_latency_ms=None, allow_synthetic=False, require_calibration=False)`
  returns why the phone can't drive, in words a phone screen can show ("This phone is offline.", "Finish or cancel
  calibration first.", "No pose from this phone. Keep the app open.", "Tracking is limited. Point the camera at
  something with texture.", …), or None.
- `Clutch` is relative teleop. `engage(pose, robot_position, robot_rotation, *, scale, rotation_scale, frame)` records
  the phone pose `P0` and the target `E0` and moves nothing; `target(pose)` then gives
  `p = E0.p + s·F·(P.p − P0.p)` and `R = exp(r·s·F·θ)·E0.R`, where `θ` is the phone's turn since `P0`, followed
  continuously past half a turn, so a scaled turn never flips. The motion scale `s` scales turns as well as moves.
  `rescale(pose, scale)` and `reframe(pose, frame)` take up a new scale or frame without moving the target, and
  `anchor_valid(pose)` is False after a new ARKit session or calibration. Call `target` every tick while engaged.
- `camera_frame(optical_rotation)` is `F` for moving in a camera's view, from its ROS optical frame's rotation in the
  robot's frame: forward goes along the view, left and up are the image's.
- `JumpDetector(distance=0.04, angle=0.5, speed=4.0, turn_speed=20.0).check(pose)` catches ARKit correcting itself
  in a step, timed on the phone's own clock.
- `PressTracker(action).pressed(phone)`: new presses since the last look, each consumed once; the first sight of a
  phone counts nothing.
- `follow(error, velocity, top, accel, dt)`: the next velocity toward a target, within a speed and acceleration
  limit, landing without overshoot.
- `owners(phones, resources, select, current)`: which connected phone has each resource (`select` is an action like
  `"arm.select"`, or a function); the current owner keeps it, else the lowest-numbered phone.
- Also `rotation_vector`, `exp_rotation`, `unwrap_turn`, `quaternion_to_matrix` and `matrix_to_quaternion`.

## A robot's connection

```python
from pathlib import Path
from marionette import PhoneTracker, RobotLink

tracker = PhoneTracker()
link = RobotLink("localhost", "arm", "Arm", screen=Path("arm.html"), watch=True, tracker=tracker).start()
link.wait_screen()                                   # True, or False with link.screen_error
link.state({"engaged": False, "battery": None, "streams": ["front"]})   # for every phone
link.state({"reason": "Calibrate first"}, phone="phone-1")              # for one phone
link.notice("Lift at its top", phone="phone-1", height=0.6)
link.send_jpeg("front", jpeg_bytes, captured_ms)
```

- `screen` is HTML or a path; with `watch=True` saving the file sends it again. It is sent on every connect.
  `screen_accepted`, `screen_error` and `screen_warnings` hold the gateway's answer.
- `state(dict, phone=None)` keeps the robot's state for every phone or one. It is sent at once when it changes and
  again every `every` seconds (0.2 by default), so a screen can tell a robot that stopped answering. Send the whole
  state each time; nested JSON and `None` are fine (64 KB at most). `clear_state(phone)` stops re-sending one.
- `notice(message, phone=None, **values)` is a `status` with `controlId: "robot.notice"`, never merged with another,
  dropped while the gateway is away.
- `send_jpeg(stream, jpeg, captured_ms)` keeps the newest frame per stream and drops frames while disconnected.
- With `tracker=`, the link feeds it. `link.client` is the underlying `GatewayClient`.

## Video

```python
from marionette.video import VideoPublisher

video = VideoPublisher(link, ["front", "wrist"], fps=30)    # streams the screen declares
video.push("front", rgb)          # (height, width, 3) uint8, from any thread; the newest frame is kept
...
video.close()
```

It publishes its streams on every connect, so the gateway marks them `transport: webrtc` and viewers (the phone
screens, the `/screen` mirror, the desktop viewer) ask the robot for video instead of waiting for JPEG frames. Each
request gets its own aiortc peer connection whose track serves the newest frame at `fps`, H.264 preferred (VP8 as the
fallback; `codec="vp8"` swaps them), with a complete offer. `close` or the gateway going away closes it. There are no
STUN servers by default, since phones and robots meet on a LAN or a tailnet; pass `ice_servers` to add some. Keep
sending JPEG frames too if some viewers can't do WebRTC.

## Running the gateway from Python

The gateway ships inside the package (`marionette/_gateway/marionette-gateway.mjs`, the single-file bundle), so a
robot needs neither this repository nor npm:

```sh
marionette-gateway --name "Lab robot"            # --port, --auth on|off|strict, --token, --no-mdns, --html-file, --home
python -m marionette.gateway --no-mdns
```

```python
from marionette import gateway

gateway.run(port=8787, name="Lab robot")                       # foreground, until Ctrl-C
handle = gateway.start(port=0, auth="off", mdns=False)         # background; port 0 picks a free one
print(handle.port, handle.log)
handle.stop()
```

It needs Node 20 or later: `$MARIONETTE_NODE`, `node` on PATH, or the one the `gateway` extra installs. The pairing
identity lives in `~/.marionette` (`home=` or `--home` to change it), and the diagnostics log in `<home>/logs`.

The gateway is tied to the Python process that started it (`run`, `start`, `marionette-gateway` and
`testing.Gateway` alike): Node gets a pipe on its stdin that only that process holds, and with
`MARIONETTE_EXIT_WITH_PARENT=1` the gateway stops, after its Bonjour goodbye, when the pipe closes. So a robot that
crashes or is killed (even with `SIGKILL`) never leaves a gateway holding its port. A child the robot forked
holds the pipe too, so it ends once the last of them does. The variable works for any program that runs the
gateway as a child this way; without it the gateway ignores its stdin.

## Testing tools

```python
from marionette.testing import Gateway, SimPhone, msg

tracker.apply(msg.config(["phone-1"], "phone-1", msg.default_controls(), "captured"))
tracker.apply(msg.input("phone-1", "teleop.deadman", True))
tracker.apply(msg.let_go("phone-1", "base.drive", {"x": 0, "y": 0}))   # the gateway ending a drag

with Gateway() as gateway, SimPhone(gateway) as phone:
    link = RobotLink(gateway.url, "arm", tracker=tracker).start()
    phone.calibrate()                       # the guided four steps, with real moves
    phone.press("teleop.deadman")           # repeated every 200 ms until release
    phone.move_by((0.05, 0, 0), seconds=0.5)
    with phone.renewals_paused():           # the gateway ends the hold ("renewals stopped")
        ...
```

- `msg` builds the gateway's messages exactly as it sends them: `config` (the gateway's view, or one phone's, with
  `values`, `held` and `live`), `pose`, `input`, `let_go`, `robot_state`, `status`, `html_config`, `ping`, `pong`,
  `rtc`, `hello`, the controls (`button`, `toggle`, `select`, `slider`, `joystick`) and `default_controls()`.
- `Gateway()` runs the bundled gateway on a free port with pairing and Bonjour off and a temporary home and log
  directory (`auth=`, `token=`, `html=` to change that). `url`, `port`, `log`, `log_dir`, `get(path)`, `state()`,
  `session`; `restart()` brings it back on the same port as a new session. It works with `with` and `async with`.
- `SimPhone(gateway)` (blocking) and `AsyncSimPhone` (asyncio) talk to it like the app: hello with a device id, raw
  ARKit poses at 60 Hz, pongs (so poses get latency stamps), the app's repeats. Poses are scripted in the operator's
  frame with `move_to(position, rotation, seconds)` and `move_by(delta, turn, seconds)`; ARKit's world is turned
  `heading` degrees (30 by default), so uncalibrated poses come out turned, and after `calibrate()` the gateway
  publishes the operator frame from where calibration started. Also `press`, `release`, `hold(action, seconds)`,
  `set`, `drag(action, values)`, `stick(x, y)`, `let_go`, `quick_origin`, `tracking(state)`, `disconnect`,
  `reconnect(same_session=True)`, `new_session`, `pause_renewals`, `wait_for(predicate)`, and what it received
  (`config`, `html`, `statuses`, `robot_states`).
- `wait_until(predicate, timeout)` polls a condition, so tests wait on what they mean rather than sleep.

## The example robot

`examples/sim_robot.py` is a simulated arm built from these parts, under 250 lines; it doubles as documentation and
as the way to check the whole system in simulation:

```sh
marionette-gateway --no-mdns                    # or npm run dev:backend
python examples/sim_robot.py                    # --gateway <address or pairing link> --token <code>
```

It connects as `sim-arm` ("Sim arm"), sends its own screen (`examples/sim_robot.html`, on the screen kit: a
hold-to-move pad, a motion-scale slider, Stop, calibration, two camera panes, a line of robot state that says when the
robot is stale or offline), publishes its state at 5 Hz, sends a notice for each event, serves two WebRTC test-pattern
cameras showing the gripper from the front and the top, and drives a virtual gripper from the phones with
`PhoneTracker`, `gate`, `Clutch`, `JumpDetector` and `PressTracker`. `--allow-synthetic` lets the simulator app's
synthetic motion drive it; `--require-calibration` refuses uncalibrated phones. `tests/test_example.py` drives it with
a `SimPhone`.

## Conformance

`sdk/conformance/tracker/*.json` are fixtures both SDKs run: gateway messages, clock steps, and the expected
`Phone.to_conformance()` shapes. `py-*.json` are written by `scripts/make_conformance.py` (messages from `msg`,
expectations by hand); the TypeScript SDK's are `ts-*.json`. `tests/test_conformance.py` runs every file in the folder.

## Developing

```sh
uv venv -p 3.12 sdk/python/.venv
VIRTUAL_ENV=sdk/python/.venv uv pip install -e "sdk/python[dev,gateway]"
sdk/python/.venv/bin/python -m pytest sdk/python                  # about 25 s
python3 sdk/python/scripts/sync_gateway.py                         # after changing the gateway, protocol or kit
sdk/python/.venv/bin/python sdk/python/scripts/make_conformance.py
```

The tests use the real bundled gateway, so run `npm install` at the repository root and `sync_gateway.py` before
testing a gateway change, and commit the copied bundle with it.
