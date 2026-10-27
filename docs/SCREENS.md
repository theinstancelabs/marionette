# Phone screens

The gateway sends a `html_config` message beside the `config` message, and the iPhone shows that document full screen in `react-native-webview`. There are no native controls behind it: the default screen (`apps/backend/src/sample-controls.html`) has Stop (this phone's toggle, with a banner and Reset while it is on), the hold-to-move pad, a grip, live pose, the cameras, **Drive base** (the stick between Turn left and Turn right, what it is sending, and the speed limit), every other control as a row, and full-screen guided calibration and optional validation. Hold buttons show what the gateway knows: **Holding…** until the gateway reports the hold, **Holding** once it does, and **Hold dropped** if the gateway lets go while the button is still pressed (its repeats stopped arriving), which needs a fresh press. The stick and sliders work the same way: blue once the gateway hears them live, red (**Dropped**) if it stops hearing them mid-drag. The stick follows the finger anywhere on the pad and springs back when let go; on the desktop mirror the arrow keys push it too. It finds controls in the config by action rather than by id, so a different layout still gets a working screen; anything it doesn't know is drawn as a generic button, switch, choice, slider or stick. The point is that the screen is yours: make it send exactly the buttons your consumer needs. HTML is trusted developer content: keep the gateway on a private network; the document is not sanitized. The protocol validates the message schema, bridge version, and a 512 KB UTF-8 size limit. The WebView cannot navigate away from the supplied document; http(s) links open in Safari.

## Your own screen

To make your own screen, copy the default document and point the gateway at it (relative paths resolve from the directory you run the command in). For a complete robot screen built on the screen kit, see `sdk/python/examples/sim_robot.html`, which the example robot sends as its own screen; a robot normally sends its screen itself (see [Robots](PROTOCOL.md#robots)) rather than the gateway loading a file. The gateway pushes the file to every phone again whenever you save it:

```sh
MARIONETTE_HTML_FILE=./config/operator.html npm run dev:backend
# or a fixed string
MARIONETTE_HTML='<!doctype html><button>Developer UI</button>' npm run dev:backend
```

The default screen is built on the **screen kit** (`packages/kit`): hold buttons, live sliders and sticks, Stop, the status strip, toasts, robot state, cameras over JPEG or WebRTC, guided calibration and generic rows, as parts you can use in any layout. A screen opts in with `<link rel="stylesheet" href="marionette-kit.css">` and `<script src="marionette-kit.js"></script>`, and the gateway puts the kit inline. See [SCREEN-KIT.md](SCREEN-KIT.md).

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

## What the gateway does to a screen

Whichever screen is showing (the default, a file, `MARIONETTE_HTML` or a robot's, see [Robots](PROTOCOL.md#robots)), the gateway does three things to it before sending it. It replaces `<script src="marionette-kit.js"></script>` and `<link rel="stylesheet" href="marionette-kit.css">` (other attributes, and a leading `/` or `./`, are fine) with inline copies of the screen kit from `packages/kit`, so the phone needs nothing but the document; the 512 KB limit counts the inlined kit, `MARIONETTE_KIT_DIR` reads the kit from another directory, and saving a kit file pushes the screen again. Both files are also served at `/marionette-kit.js` and `/marionette-kit.css`. It reads `<meta name="marionette-orientation" content="portrait|landscape|any">` into `html_config.orientation`, which the app locks to. And it says where the screen came from in `html_config.source`.

## Working on a screen in a desktop browser

Open `http://localhost:8787/screen` in a desktop browser to work on the screen without the phone. It is the same document with the same bridge, carried over the gateway's WebSocket. It mirrors the first connected phone (or the one in `?phone=phone-2`), shows that phone's state, and acts as that phone: its presses reach consumers with `source: 'mirror'`. Each action it sends names that phone (`phoneId`): when the gateway moves the mirror to another phone, what it still had on the way for the old one is dropped instead of reaching the new one. A mirror whose actions name no phone (an older page, the SDK's `SimPhone`) has them dropped for a second after a move instead. It gets robot state and can play WebRTC video like the app, shows its own link to the gateway, and reconnects in place when the gateway restarts, reloading only when the screen itself changed. From another computer, add the pairing code (`/screen?token=K7Q2M9XD`). The document is also available as JSON at `GET /api/html-config`.

## The page bridge: `window.Marionette`

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
Marionette.on('status', status => renderStatus(status.message));   // gateway replies, and feedback from consumers
Marionette.on('camera_frame', frame => { panes[frame.cameraId].src = frame.dataUrl; });
Marionette.on('tracking', t => renderTracking(t.state, t.reason, t.message)); // ARKit as the phone sees it
Marionette.on('connection', c => renderGateway(c.gateway));
Marionette.latest('config');   // the last config, or undefined
Marionette.disconnect();       // back to the connect page
```

`on` calls a new listener straight away with the last value of that type, so a page that subscribes late still starts from the current state. `sendAction` accepts a control id, action name, an optional string, number, boolean or stick (`{x, y}`) value, and `{ live: true }` for a sample of a value being dragged (`stream` does this for you). For a control the config marks `hold: true`, send `true` on press and `false` on release; the app repeats the press while it is held and releases it if the document reloads or the app leaves the foreground. A drag is ended the same way: a stick at rest, a slider at its last value. A calibration capture names the step the gateway is waiting for (`config.calibration.step`) and a validation move names `config.calibration.check.step`. The app converts bridge actions into the version 1 WebSocket `action` message.
