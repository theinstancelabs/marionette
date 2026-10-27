# Axol phone screen

`axol.html` is the phone screen for driving Axol with Marionette. The gateway sends it to every phone, and the Marionette app shows it full screen. The consumer on Axol (the `marionette` operation in `axol serve`) reads what the screen sends and answers with robot state. The screen is built on Marionette's default screen (`apps/backend/src/sample-controls.html`), so calibration, Stop, holds and cameras work the same way.

## Run it

From the repository root:

```sh
npm run dev:axol                  # the gateway on 0.0.0.0:8787 with this screen
PORT=18787 npm run dev:axol       # the same on another port
```

Saving `axol.html` pushes it to every phone and mirror. The iPhone app needs no rebuild.

To preview the screen in a desktop browser, open http://localhost:8787/screen. It mirrors the first connected phone, or the one in `?phone=phone-2`, and acts as that phone. A wide window shows it as a phone-width column. For phones without iPhones, run `DEVICE=a ARM=left npx tsx tools/phone-sim.mts 8787 wander` (see the main README).

## What the screen shows

- At the top: the phone's name and tracking, the **Stop** button, and two switches. **Arm** or **Drive** picks the mode. **Left arm** or **Right arm** picks the arm.
- A headline that says what Axol is doing for this phone. Tags below it show **Sim**, the lift height and the base.
- The cameras, with a view picker under them: **Head**, **Both wrists**, **Left wrist**, **Right wrist** and **All three**. With several panes, a tap stacks them full width.
- **Arm** mode: the **Motion scale** slider, **Open gripper** and **Close gripper**, and the **Hold to move** pad. While you hold the pad, slide your thumb down to close the gripper or up to open it. A 200 px slide is the full range. The gauge on the pad shows the grip.
- **Drive** mode: the **Drive speed** slider, **Raise lift** and **Lower lift**, the drive pad, and **Turn left** and **Turn right**. Drag from where your thumb lands: up is forward, left is left.
- **Calibration** (below the cameras) opens the guided calibration.

## What it sends

Declared controls. The gateway keeps their values per phone and repeats held buttons.

| Control id | Type | Action | Values |
|---|---|---|---|
| `deadman` | hold button | `teleop.deadman` | `true` on press, renewed every 200 ms, `false` on release |
| `estop` | toggle | `safety.estop` | Stop. **Reset Stop** sets it to `false`. |
| `arm` | select | `arm.select` | `left`, `right` |
| `cameras` | select | `camera.view` | `head`, `wrists`, `left`, `right`, `all` |
| `scale` | slider | `teleop.translationScale` | 0.25 to 3, step 0.05, default 1 |
| `drive-speed` | slider | `base.speed` | 0.1 to 1, step 0.05, default 0.5 |
| `calibration-start`, `calibration`, `capture-origin`, `calibration-cancel`, `reset-origin`, `calibration-check` | buttons | `calibration.*` | Marionette's own calibration |

Undeclared actions. The gateway relays them to consoles as `input` and keeps no value.

- **`gripper.set`** on control `grip`: a number from 0 (open) to 1 (closed), rounded to 0.01.
  - It is sent when it changes, at most 20 times a second.
  - Outside a slide, the screen's grip follows `grip` in Axol's feedback. A slide starts from there, so pressing the pad never moves the gripper.
  - Nothing is sent while another phone has the arm.
- **`base.command`** on control `drive`: the string `"vx,vy,wz,lift"`.
  - `vx` is forward and `vy` is left, from the drive pad. `wz` is 1 for **Turn left** and -1 for **Turn right**. All three run from -1 to 1 with two decimals, before the speed scale. The middle 8% of the drive pad is still.
  - `lift` is 1 for **Raise lift**, -1 for **Lower lift**, or 0.
  - Pressed controls combine. While any of them is pressed, the command goes out every 100 ms. After the last release, `"0,0,0,0"` goes out once.
  - Everything is released when a finger lifts or a touch is cancelled, when the page loses focus or is hidden, on a mode switch, when this phone's Stop turns on, when the calibration sheet opens, and when the gateway is lost. Pressing again starts a new command stream.

Cameras: the streams are `head` (Head), `left` (Left wrist) and `right` (Right wrist), with `axol://` urls so the gateway draws none of its own. The views are `head`, `wrists` (left and right), `left`, `right` and `all` (head, left and right). A camera producer on Axol pushes `camera_frame` messages for these stream ids. Each phone gets only the streams in its view.

## What it receives

The consumer sends `status` messages to a phone through the gateway (see "Feedback to phones" in `docs/INTEGRATION.md`). The screen reads two kinds:

- `controlId: "axol.feedback"`, with `message: ""` and the flat `values` below. Axol sends it 5 times a second and at once on a change. If none arrives for 1.5 s, the headline says **No answer from Axol**.
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
| `hasBase`, `baseMoving`, `baseFault` | boolean | The base tag, and "Base fault" in Drive mode. Without a base, the drive pad and turning are off. |
| `driving`, `driver` | boolean, string | "Desktop is driving" in Drive mode when someone else drives |
| `stopBy` | string | "Stopped by Phone 2" |
| `streams` | string, like `"head,left,right"` | A pane for a stream Axol doesn't have says so |

Until the first feedback arrives, the lift and drive controls all show.
