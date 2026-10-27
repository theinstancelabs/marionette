# Axol phone screen

`axol.html` is the phone screen for driving Axol with Marionette. The gateway sends it to every phone, and the Marionette app shows it full screen. The consumer on Axol (the `marionette` operation in `axol serve`) reads what the screen sends and answers with robot state. The screen is built on Marionette's default screen (`apps/backend/src/sample-controls.html`), so calibration, Stop, holds, live sliders, the drive stick and cameras work the same way.

The screen needs an iPhone app with live values (sliders and sticks that stream). Older app builds drop the stick's `{x, y}` values.

## Run it

From the repository root:

```sh
npm run dev:axol                  # the gateway on 0.0.0.0:8787 with this screen
PORT=18790 npm run dev:axol       # the same on another port
```

Saving `axol.html` pushes it to every phone and mirror.

To preview the screen in a desktop browser, open http://localhost:8787/screen. It mirrors the first connected phone, or the one in `?phone=phone-2`, and acts as that phone. A wide window shows it as a phone-width column. For phones without iPhones, run `DEVICE=a ARM=left npx tsx tools/phone-sim.mts 8787 wander` (see the main README).

## What the screen shows

- At the top: the phone's name and tracking, the **Stop** button, and two switches. **Arm** or **Drive** picks the mode. **Left arm** or **Right arm** picks the arm.
- A headline that says what Axol is doing for this phone. Tags below it show **Sim**, the lift height and the base.
- The cameras, with a view picker under them: **Head**, **Both wrists**, **Left wrist**, **Right wrist** and **All three**. With several panes, a tap stacks them full width.
- **Arm** mode: the **Motion scale** slider, **Open gripper** and **Close gripper**, and the **Hold to move** pad.
  - While you hold the pad, slide your thumb down to close the gripper or up to open it. A 200 px slide is the full range. The gauge on the pad shows the grip.
  - **Motion scale** is off while you hold the pad.
- **Drive** mode: the **Speed limit** slider, **Raise lift** and **Lower lift**, and the drive stick between **Turn left** and **Turn right**. The stick goes where you touch it and returns to the middle when you let go.
- **Calibration** (below the cameras) opens the guided calibration.

Holds, sliders and the stick show what the gateway knows. A filled button or a blue knob means the gateway hears it. Red means the gateway stopped hearing it while you still touch it: let go, then touch it again.

## What it sends

All controls are declared, so the gateway keeps each phone's values and tracks holds and drags.

| Control id | Type | Action | Values |
|---|---|---|---|
| `deadman` | hold button | `teleop.deadman` | `true` on press, renewed every 200 ms, `false` on release |
| `estop` | toggle | `safety.estop` | Stop. **Reset Stop** sets it to `false`. |
| `arm` | select | `arm.select` | `left`, `right` |
| `cameras` | select | `camera.view` | `head`, `wrists`, `left`, `right`, `all` |
| `scale` | slider, live | `teleop.translationScale` | 0.25 to 3, step 0.05, default 1 |
| `grip` | slider, live | `gripper.set` | 0 (open) to 1 (closed), step 0.01, default 0 |
| `drive` | stick, live | `base.drive` | `{x, y}`: x forward (up the stick), y left, at most 1 together |
| `turn-left`, `turn-right` | hold buttons | `base.turnLeft`, `base.turnRight` | like the deadman |
| `lift-up`, `lift-down` | hold buttons | `lift.up`, `lift.down` | like the deadman |
| `speed-limit` | slider, live | `base.speedLimit` | 0 to 100 %, step 1, default 50 |
| `calibration-start`, `calibration`, `capture-origin`, `calibration-cancel`, `reset-origin`, `calibration-check` | buttons | `calibration.*` | Marionette's own calibration |

How the live controls stream (see "Live values" in the main README):

- While a slider or the stick is dragged, each new value goes out with `live: true`, at most once per screen frame. While the finger rests, the app (or the `/screen` mirror) repeats the latest value every 50 ms with `live` and `renew`. Letting go sends the final value without `live`.
- **Stick:** letting go sends `{x: 0, y: 0}` without `live`.
- **Grip:** the pad slide streams it, and the end of the slide or of the press sends the final value. **Open gripper** and **Close gripper** send 0 and 1 as plain final values.
  - Outside a slide, the screen's grip follows `grip` in Axol's feedback. A slide starts from there, so pressing the pad never moves the gripper.
  - Nothing is sent while another phone has the arm.
- **Scale:** a drag ends, and the slider turns off, as soon as the pad is pressed.
- Everything held or dragged is let go when the page loses focus or is hidden, on a mode switch, when this phone's Stop turns on, and when the calibration sheet opens. When the gateway is lost, the app or mirror ends them itself. Each needs a fresh touch afterwards.

Cameras: the streams are `head` (Head), `left` (Left wrist) and `right` (Right wrist), with `axol://` urls so the gateway draws none of its own. The views are `head`, `wrists` (left and right), `left`, `right` and `all` (head, left and right). A camera producer on Axol pushes `camera_frame` messages for these stream ids. Each phone gets only the streams in its view.

## What it receives

The consumer sends `status` messages to a phone through the gateway (see "Feedback to phones" in `docs/INTEGRATION.md`). The screen reads two kinds:

- `controlId: "axol.feedback"`, with `message: ""`, the flat `values` below and a `sessionId` that names the Axol session (`axol-…`).
  - Axol sends it 5 times a second and at once on a change. If none arrives for 1.5 s, the headline says **No answer from Axol**.
  - If feedback from two different sessions arrives within 2 s, the headline says **Two Axol sessions are using this gateway. Stop one of them.** This happens when a simulated session and the robot use one gateway.
- `controlId: "axol.notice"`, a one-off `message` shown as a toast.

Feedback never shows as a toast. Other statuses, such as the gateway's calibration replies, work as on the default screen.

| Field | Type | On the screen |
|---|---|---|
| `mode` | `"sim"` or `"hardware"` | The **Sim** tag |
| `ready` | boolean | "Axol is starting" until it is true |
| `arm` | `"left"` or `"right"` | The arm named in the headline |
| `state` | `"idle"`, `"engaged"`, `"blocked"` or `"stopped"` | The headline |
| `engaged`, `limited` | boolean | "Moving the left arm", "At reach limit" |
| `reason` | string, `""` when none | The note under "Can't move the left arm" |
| `owner` | string | "Phone 2 has the left arm" when another phone has it. **Open gripper**, **Close gripper** and the grip slide turn off. Empty (or this phone's name) means this phone. |
| `grip` | number, 0 open to 1 closed | The grip gauge, and where the next slide starts |
| `hasLift`, `lift`, `liftMoving` | boolean, number 0 to 1 (-1 unknown), boolean | The lift tag. Without a lift, **Raise lift** and **Lower lift** are hidden. |
| `hasBase`, `baseMoving`, `baseFault` | boolean | The base tag, and "Base fault" in Drive mode. Without a base, the stick and turning are off. |
| `driving`, `driver` | boolean, string | "Desktop is driving" in Drive mode when someone else drives |
| `stopBy` | string | "Stopped by Phone 2" |
| `streams` | string, like `"head,left,right"` | A pane for a stream Axol doesn't have says so |

Until the first feedback arrives, the lift and drive controls all show, and the grip starts from this phone's last value.
