# The screen kit

The phone shows an HTML screen that the gateway sends, and the screen talks to the app through `window.Marionette` (the page bridge; see "The phone screen is HTML" in the README). The screen kit is a set of parts for building such a screen: hold buttons, live sliders and sticks, Stop, the status strip, toasts, robot state, cameras (JPEG or WebRTC), guided calibration, sheets and generic control rows. They come from Marionette's default screen (`apps/backend/src/sample-controls.html`, which is now built on the kit), so they behave the way the default screen already does on the phone.

It is a set of parts, not a framework. Use any of them on their own, in your own layout. None of them assumes the default screen's DOM, and your screen keeps its own script, markup and style.

The kit lives in `packages/kit`:

- `marionette-kit.js`: a classic script with no dependencies and no build. It defines `window.MarionetteKit`.
- `marionette-kit.css`: the default screen's look (paper with a faint grid, ink, blue and red) and the styles of the kit's parts.
- `marionette-kit.d.ts`: types for `window.Marionette` and `window.MarionetteKit`, for your editor.

## Opting in

Put these two tags in the screen's `<head>`, before your own style and script:

```html
<link rel="stylesheet" href="marionette-kit.css">
<script src="marionette-kit.js"></script>
```

The gateway replaces both tags with the kit itself before it sends the screen, so the phone never fetches anything. Write them exactly like this. To look at a screen with a gateway that doesn't inline the kit yet, inline it yourself:

```sh
node packages/kit/scripts/inline.mjs my-screen.html > /tmp/my-screen.html
MARIONETTE_HTML_FILE=/tmp/my-screen.html npm run dev:backend      # then open http://localhost:8787/screen
```

The kit works in iOS 16.4+ WKWebView and in desktop Chrome and Safari. It waits for the bridge (`marionette-ready`) by itself, so parts can be made as soon as your script runs. Your own CSS comes after the kit's, so it overrides anything in it. Kit parts use `mk-` class names and `data-state` attributes; the color tokens (`--paper`, `--ink`, `--ink2`, `--blue`, `--red`, `--green`, …) are plain CSS variables you can use too.

## The kit and the bridge

```js
const K = window.MarionetteKit;
K.on('config', config => render(config));   // like Marionette.on, but after the kit has taken the event in
K.on('touch', () => renderHeadline());      // a hold or drag on this page started, ended or changed state
K.latest('tracking');                       // the last tracking event, or undefined
K.control('teleop.deadman');                // the first control with this action, in the latest config
K.byId('grip');                             // a control by id
K.send(K.control('horn.honk'));             // sendAction for a control, with an optional value
K.has('rtc');                               // whether the host lists a feature in Marionette.features
```

`K.on` replays the latest `config`, `connection`, `tracking`, `pose`, `robots` and `link` to a new listener, like `Marionette.on` does. One-off events (`status`, `camera_frame`, `robot_state`, `rtc`) are not replayed.

Look controls up by action, not by id, so the screen still works with a different layout (the default screen does this throughout).

## Holds and drags

The kit knows what this page is pressing or dragging, and what the gateway reports about it in each config (`held` for a hold button, `live` for a slider or stick). Every hold button, slider and stick shows the result in a `data-state` attribute:

| State | Hold button | Slider or stick |
|---|---|---|
| `idle` | not pressed | not dragged |
| `pending` | pressed, not yet reported by the gateway | dragged, not yet reported live |
| `held` / `live` | the gateway has the hold | the gateway hears the drag |
| `dropped` | the gateway let go (its repeats stopped) while it is still pressed here | the gateway stopped hearing it while it is still dragged here |

A dropped touch stays dropped until the operator lets go and touches it again. While the gateway is away (`connection` is `disconnected` or `reconnecting`) everything still touched reads as dropped, and it stays dropped after a reconnect until it is let go. `K.holdState(control)` and `K.liveState(control)` give the same states for your own headline.

The kit doesn't rely on the host or the gateway for this. It cuts a touch when the connection drops, when this page's phone changes (a mirror that moves on to another phone), when the touch begins while the gateway is away, and when the kit lets go of it (see [Letting go](#letting-go)). A cut touch sends nothing more: no new samples, no repeat, and no release or final value for a touch the host already ended. It reads as `dropped` whatever a later config says, until the finger lifts; only a fresh touch counts again.

### hold

```js
const pad = K.hold(document.querySelector('#pad'), {
  action: 'teleop.deadman',                       // or controlId: 'deadman'
  onState: state => label.textContent = { pending: 'Holding…', held: 'Holding', dropped: 'Hold dropped' }[state] || 'Hold to move',
});
```

It sends `true` on press and `false` on release, to the control that was pressed even if the config changed in between. The app repeats the press while it is held. A press does nothing if the button is `disabled` or `aria-disabled="true"`, if it isn't on the page, or if the layout has no such control. `onChange(pressed)` is called on press and release. Style it with `[data-state=held]` and friends.

A button taken off the page mid-press (a screen re-rendering with `replaceChildren` without `dispose()`) lets go at once: while anything is touched the kit watches the page, and it follows the pressing finger on the window too, not just on the button. A button moved within the page (a keyed re-order) stays pressed. Sliders and sticks do the same.

### slider, stick and drag

```js
const scale = K.slider(document.querySelector('#scale'), { action: 'teleop.translationScale', out: document.querySelector('#scale-value') });
const drive = K.stick(null, { action: 'base.drive', edges: ['forward', 'back', 'left', 'right'], onMove: v => show(v) });
document.querySelector('#drive-cell').append(drive.el);
```

- `slider(input, options)` streams every value while the thumb is dragged (marked `live`, at most once a frame), and sends the final value when it is let go. Pass `null` for a new `<input type="range">`. It takes `min`, `max`, `step` and the value from the control (now, or once the config arrives), follows the config while it isn't dragged or focused, and writes the formatted value into `out` (with the same `data-state`). `slider.finish()` ends a drag now.
- `stick(pad, options)` turns an element (or a new one, with `null`) into a spring-return stick. A touch anywhere on it pushes the stick that far from the centre, and it follows the finger until let go, when it sends `{x: 0, y: 0}`. The arrow keys push it too. `x` is up the pad (forward) and `y` is to the left, each from −1 to 1, rounded to two decimals toward zero, never longer than 1 together (`K.stickLimit(x, y)` does the rounding). `aria-disabled="true"` turns it off.
- `drag(options)` is a live value fed by your own touch handling, such as a thumb sliding on a pad to set a gripper: `update(value)` streams, `end(value?)` sends the final value (the last one if you leave it out). Call `end()` when the finger lifts. When the drag is cut (the kit lets go of it, the gateway goes or the phone changes), `update()` does nothing until `end()`, which then sends nothing, and `state()` reads `dropped`. `onLetGo()` tells your touch handling when that happens, so it can show the thumb let go:

```js
const pad = document.querySelector('#grip-pad');
const grip = K.drag({ action: 'gripper.set', onLetGo: () => pad.classList.remove('sliding') });
const at = e => K.clamp((e.clientX - pad.getBoundingClientRect().left) / pad.clientWidth, 0, 1);
pad.addEventListener('pointerdown', e => { pad.setPointerCapture(e.pointerId); pad.classList.add('sliding'); grip.update(at(e)); });
pad.addEventListener('pointermove', e => { if (pad.hasPointerCapture(e.pointerId)) grip.update(at(e)); });
pad.addEventListener('pointerup', () => { pad.classList.remove('sliding'); grip.end(); });   // after onLetGo too
```

### Letting go

Every hold, slider, stick and drag lets go when the page loses focus or is hidden, when a sheet opens and when this phone's Stop turns on. Pass `letGoOnLeave: false` to a part to keep it out of that.

A slider, stick or drag that is let go of mid-gesture sends its final value (for a stick, rest), and the rest of that gesture is ignored: it reads `dropped` until the finger lifts (for `drag()`, until `end()`), so a finger still sliding after Stop turns on, or behind a sheet, never starts it again. A slider then shows the gateway's value again.

```js
const dock = K.group();                          // parts that are rebuilt together
K.hold(button, { controlId: x.id, group: dock });
dock.dispose();                                  // lets go of them and unhooks them, before you remove the buttons
K.letGoOnLeave(endSlide);                        // your own touch handling lets go at the same moments
K.letGo();                                       // let go of everything now
K.letGo(true);                                   // …without telling the gateway (it already ended them, e.g. it went away)
```

`letGoOnLeave(target)` takes a function, a group or a part, and returns a function that undoes it.

## Stop

```js
const stop = K.stop({ banner: document.querySelector('#stop-banner') });
stop.isOn();
```

This is the floating round Stop button, above the page and every sheet. It is hidden when the layout has no `safety.estop` control. Pressing it turns a toggle Stop on (a plain Stop button just sends a press). Stop is this phone's own signal, which the consumer reads; Marionette itself stops nothing. While it is on, the button looks pressed in and the banner shows. An empty `banner` element gets the default banner ("Stop is on", "It stays on for this phone until you reset it.", **Reset**); a banner with your own content needs a `[data-stop-reset]` button. Pass `button` to use your own button (a sheet never covers it, wherever it is on the page), `onChange(on)` to follow it, and `letGo: false` to keep holds when Stop turns on. `--mk-stop-right` moves the button (the default screen moves it into its desktop column).

## Status strip

```js
const strip = K.strip(document.querySelector('header'));
```

This adds three chips to the start of the element, then:

- this phone's name, with a dot in the color the viewer draws it in, and a line in that color across the top of the screen. With no phone it shows the gateway address or **Connecting…**. It adds **· offline** for a mirror whose phone is gone and **· reconnecting** while the app reconnects.
- tracking: **Tracking good**, **Tracking limited**, **Starting tracking**, **Finding its place**, **No tracking**, **Simulated motion** or **No pose**.
- the link, from the host's `link` event: **Link good**, **Link slow** or **Link poor**, with the round trip in milliseconds. On a phone held upright it shows only when the link is slow or poor.

Anything already in the element (a More button, say) stays after the chips. `strip.me`, `strip.tracking` and `strip.link` are the chips, if you want to hide them.

## Toasts

```js
K.toast('Arm is resetting');
K.toast(notice.message, { above: document.querySelector('.controls'), ms: 4000 });
```

A short message near the bottom for 2.6 s. `above` puts it just above an element, so it never covers a thumb; `--mk-toast-bottom` moves it for the whole screen. Empty text shows nothing.

## Robots and their state

```js
K.robot(robot => {                 // the robot whose screen this is, else the first connected one
  if (!robot) return showNoRobot();
  if (robot.offline) return say(robot.name + ' is offline');
  if (robot.stale) return say('No answer from ' + robot.name);
  say(robot.values.ready ? robot.name + ' ready' : robot.name + ' is starting');
});
K.robot('cart', cart => …);        // one robot by id
K.robots(all => …);                // every robot, by id
```

Robots come from `config.robots` and the bridge's `robots` event. Each one has `id`, `name`, `connected`, `screen` (whether this is its screen), `state` (its state for every phone), `phoneState` (its state for this phone), `values` (`state` with `phoneState` over it), `everyMs`, `receivedAt` and `ageMs`, plus:

- `offline`: the robot has disconnected. It stays listed with its last state.
- `stale`: it is connected but has sent nothing for `staleAfterMs` = `max(1500, 3 × everyMs)` milliseconds, counted from its last state, or from when the page saw it connect if it has sent none. The kit checks this four times a second, so a robot that stops answering turns stale without another message.

Callbacks run at once, whenever a robot changes, answers, goes stale or goes offline. Each returns an unsubscribe function. The default screen shows the robot's name under its headline, with **· not answering** or **· offline**.

## Cameras

```js
const cams = K.cameras(document.querySelector('figure'), {
  empty: (id, label, state) => state === 'unavailable' ? label + ' video unavailable, retrying' : 'Waiting for the ' + label.toLowerCase() + ' camera',
});
```

This shows one pane per stream in the view this phone picked with the `camera.view` select (or the first view), side by side and never cropped. With several streams a tap (or Enter) stacks them full width (`aria-expanded`). The element gets `data-panes` (the count, for layouts such as a large first pane) and `--panes`. Each pane is `.mk-pane[data-stream]` with `data-transport` (`jpeg` or `webrtc`) and `data-state` (`waiting`, `live` or `unavailable`). Call `cams.render()` when something your `empty` text depends on changes.

A stream goes over **WebRTC** when the host lists `rtc` in `Marionette.features`, the page has `RTCPeerConnection`, and the gateway marks the stream `transport: 'webrtc'` (a robot publishes it). Otherwise the pane shows the stream's `camera_frame` JPEGs, as before. A WebRTC pane also shows JPEG frames for its stream until the video plays. The robot is the offerer and nothing trickles:

1. The page sends `Marionette.rtc({ kind: 'request', stream, peer })` with a fresh peer name (`head-k3x9…`).
2. On the robot's `offer` for that peer, the page sets it as the remote description, creates an answer, sets it, waits for ICE gathering to finish (at most 2 s), and sends `answer { to: offer.from, peer, sdp }`. `candidate` messages are added if they arrive.
3. The remote track plays in a `<video autoplay playsinline muted>`.

On `error`, `close` or a `failed` connection, the pane shows as unavailable and the page asks again after 2 s, then 4, 8 and every 10 s, for as long as the stream stays in view and on WebRTC. An offer that doesn't come within 10 s counts as a failure too. A view change, a hidden page or the stream leaving WebRTC sends `close` and tears the connection down. While the gateway is away, connections are dropped without a message (the gateway closes the robot's end); they are asked for again once it is back. An offer for a request the page has given up on gets a `close`. There are no STUN servers by default, because phones and robots meet on a LAN or a tailnet; pass `iceServers` to add some.

## Sheets

```js
const more = K.sheet();
more.show([K.sheetTop('Close', 'More', '', () => more.hide()), body]);
more.hide();
```

A full-screen panel, at most 430 px wide. Only one sheet is open at a time. Opening one lets go of every hold and drag and makes the page behind it inert: everything in `<body>` (or the elements you pass as `covers`) except Stop buttons, sheets, toasts and the color line. Where one of those sits inside another element, that element stays as it is and its other children are covered instead, so a Stop button in your header and a sheet element anywhere on the page stay usable. `sheetTop(left, title, count, onLeft)` is the top bar, with its right side clear for Stop.

## Calibration

```js
const calibration = K.calibration();
rows.append(calibration.row());            // "Calibration  Guided, validated ✓ ›"; a tap opens the sheet
calibration.open();                        // or open it yourself
K.on('status', m => { if (!calibration.handles(m) && m.message) K.toast(m.message); });
```

This is the default screen's whole guided calibration, quick origin and optional validation, in a sheet, with the same copy and drawings. The intro says what is in use and offers **Start calibration**, **Validate**, **Set origin here** and **Reset** (each only if the layout has its `calibration.*` control). The gateway drives the steps: the sheet follows `config.calibration` through the four captures (flat, forward, right, up) with a live drawing and meter, then **Calibrated**, and through the three validation moves to the results. A run started elsewhere (the desktop mirror, say) opens the sheet here too, once the operator has let go of everything.

The gateway's replies to captures and checks show in the sheet. Replies to start, quick origin, reset and cancel show in the intro, or as a toast while no sheet is open. `handles(status)` says whether a status is one of these, so your own status handler can skip it. `summary()` gives the short state (`['Guided, validated ✓', 'ok']`), and `available()` says whether the layout has calibration at all.

Pass `copy` to use your own words. It is merged over the defaults (`CALIBRATION_COPY` in `marionette-kit.js`), so you only name what changes:

```js
K.calibration({ copy: {
  introTitle: 'Set which way is forward',
  introBody: 'Stand behind the robot, facing the way it faces. Then make four short moves with the phone.',
  steps: { flat: { body: 'Hold the phone roughly flat, screen up, top edge pointing the way the robot faces.' } },
  notes: { flatReady: 'Flat enough. Capture when ready.' },
} });
```

## Rows

```js
for (const control of unplaced) rows.append(K.controlRow(control, { group: rowParts }));
```

The default screen's row for a control it doesn't place: a switch for a toggle, segments for a select with up to three options (a picker beyond that), a live slider, a stick, or a button (a hold button if the control is one). Values follow the config in place, so a drag in progress isn't reset. Put rows you rebuild in a group and dispose of it first.

`K.segments(el, { action, disabled })` is the segmented picker on its own (the arm, the camera view). `disabled(value, control)` turns options off, such as frames the robot can't use; the selected option always stays on. Call `render()` when what it depends on changes.

## Helpers

`K.h(tag, props, ...children)` builds an element (`class`, `on…` listeners, attributes; children may be nested arrays, `null` and `false` are skipped). `K.setText(node, text)` only writes when the text changed. Also: `K.svg(markup)`, `K.format(control, value)` (a slider value with its step's decimals and unit), `K.signed(n)`, `K.signed2(n)`, `K.mm(metres)`, `K.clamp`, `K.staleAfterMs(everyMs)`, `K.linkQuality(rttMs)`, `K.TRACKING_WORDS`, `K.AXIS_WORDS` and `K.ACTIONS` (the actions the kit's parts look for by default).

## A complete robot screen

A screen for a robot with an arm, a base and one camera. The robot sends `robot_state` with `ready` and `battery`.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<title>Rover</title>
<script type="application/json" id="marionette-config">
{ "controls": [
    { "id": "deadman", "type": "button", "label": "Hold to move", "action": "teleop.deadman", "hold": true },
    { "id": "estop", "type": "toggle", "label": "Stop", "action": "safety.estop", "value": false },
    { "id": "drive", "type": "joystick", "label": "Drive", "action": "base.drive", "value": { "x": 0, "y": 0 } },
    { "id": "speed", "type": "slider", "label": "Speed", "action": "base.speedLimit", "value": 50, "min": 0, "max": 100, "step": 1, "unit": "%" },
    { "id": "calibration-start", "type": "button", "label": "Start calibration", "action": "calibration.start" },
    { "id": "calibration", "type": "button", "label": "Capture", "action": "calibration.capture" },
    { "id": "calibration-cancel", "type": "button", "label": "Cancel", "action": "calibration.cancel" }
  ],
  "cameraStreams": [{ "id": "front", "label": "Front", "url": "rover://front", "status": "live" }] }
</script>
<link rel="stylesheet" href="marionette-kit.css">
<script src="marionette-kit.js"></script>
<style>
main{padding:0 16px 24px}
h1{font-size:28px;margin:8px 0 2px}
.cam{margin:12px 0}
.controls{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:end}
.pad{height:120px;border-radius:20px;border:2.5px solid var(--blue);background:#fff;color:var(--blue);font-weight:600;touch-action:none}
.pad[data-state=pending]{background:var(--blue-wash)}.pad[data-state=held]{background:var(--blue);color:#fff}
.pad[data-state=dropped]{border-color:var(--red);color:var(--red)}
</style>
</head>
<body>
<header id="strip"></header>
<div id="stop-banner" hidden></div>
<main>
  <h1 id="state">Connecting…</h1><p class="mk-note" id="note"></p>
  <figure class="cam" id="cam"></figure>
  <div class="controls"><button class="pad" id="pad">Hold to move</button><div id="stick"></div></div>
  <p>Speed <output class="mk-val" id="speed-value"></output></p>
  <div id="speed"></div>
  <div id="rows"></div>
</main>
<script>
(() => {
  const K = window.MarionetteKit, $ = id => document.getElementById(id);
  K.strip($('strip'));
  const stop = K.stop({ banner: $('stop-banner') });
  const calibration = K.calibration();
  K.cameras($('cam'));
  K.hold($('pad'), { action: 'teleop.deadman' });
  $('stick').append(K.stick(null, { action: 'base.drive', edges: ['forward', 'back', 'left', 'right'] }).el);
  $('speed').append(K.slider(null, { action: 'base.speedLimit', out: $('speed-value') }).el);
  $('rows').append(calibration.row());
  let rover;
  K.robot(r => { rover = r; headline(); });
  function headline() {
    const conn = K.latest('connection'), pad = K.holdState(K.control('teleop.deadman'));
    const [title, note] = !conn || conn.state !== 'connected' ? ['Connecting…', '']
      : stop.isOn() ? ['Stopped', 'reset Stop when it’s safe']
      : !rover || rover.offline ? ['No rover', 'start the rover']
      : rover.stale ? ['No answer from the rover', 'check it is running']
      : pad === 'dropped' ? ['Hold dropped', 'let go and press again']
      : pad === 'held' ? ['Moving', 'release to stop']
      : [rover.values.ready ? 'Ready' : 'Starting', typeof rover.values.battery === 'number' ? 'battery ' + rover.values.battery + '%' : ''];
    K.setText($('state'), title); K.setText($('note'), note);
  }
  for (const type of ['config', 'connection', 'touch']) K.on(type, headline);
  K.on('status', m => { if (!calibration.handles(m) && m.message && m.message !== 'Connected to Marionette gateway') K.toast(m.message); });
})();
</script>
</body>
</html>
```

The default screen (`apps/backend/src/sample-controls.html`) is a larger example: it finds every control by action, docks the pad and other holds, groups the stick, the turn holds and the speed limit into **Drive base**, draws a row for everything else, and lays itself out in two columns on a phone on its side or an iPad.

## Tests

`npm --workspace @marionette/kit test` runs the kit's tests (vitest and jsdom). They load the real page bridge (`htmlBridgeScript` from `@marionette/protocol`) and the kit into jsdom the way the gateway sends a screen, and cover the hold and drag states, the stick math, letting go, robot staleness with fake timers, the WebRTC request, offer, answer, close and retry flow against a fake `RTCPeerConnection`, the JPEG fallback, the calibration sheet, and the default screen itself. `npm --workspace @marionette/kit run typecheck` checks the declarations against the protocol's types.
