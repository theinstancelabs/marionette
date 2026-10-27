# Audit fixes — calibration, ARKit tracking, HTML bridge, gateway (2026-10-26)

Source: three Opus 5.5 xhigh audits (ARKit path, calibration path, HTML/backend/viewer). Stop rule: no P0/P1 left.

## Frames (single convention)
- ARKit camera: +X toward bottom edge (portrait), +Y right edge, +Z out of screen. Phone body = camera ⊗ Rz(+90°): +X right, +Y top, +Z screen.
- Output/operator frame for every mode: +X right, +Y forward, +Z up; identity = flat, screen up, top forward.

## P0
- [x] Protocol: fix camera→body conversion; uncalibrated output in gravity RFU frame
- [x] Protocol: one calibrated formula (position F⁻¹Δp, rotation F⁻¹·q·q₀⁻¹·F) for quick + guided
- [x] Protocol: guided frame from gravity up + horizontal forward/right, real orthogonality/handedness checks, per-step validation
- [x] Deadman = hold button with renewals; server expires holds; holds keyed per control; owner-only deadman
- [x] E-stop accepted from any connected client before session checks

## P1
- [x] Swift: interruption/failure/tracking-reason delegates, world-reset event, generation counter, permission check, OnDestroy, onTracking on change
- [x] Phone: world reset → new session; drop stale-generation events; AppState releases holds
- [x] Gateway: socket error handler + maxPayload, ping/pong, backpressure, sanitized rebroadcast, Origin check
- [x] Gateway: covariance gate; calibration blocked while teleop engaged; clutch-anchored scaled target
- [x] Phone: guard/validate every server message, drop unknown controls, no pose echo, throttle UI/HTML pose
- [x] WebView: block navigation, check message origin, remount per config, reload on process death
- [x] Viewer: Z-up operator frame → Three.js Y-up, phone mesh in body frame, target ghost
- [x] Phone slider: thumb jump + step grid from min

## P2/P3 (cheap)
- [x] Clear half-finished calibration on session change; capture requires explicit current step
- [x] Calibration epoch/mode/session in reference + calibrationVersion; persistent E-stop state; pinned E-stop
- [x] camera.select validated, frames filtered by active camera, render with Image
- [x] Synthetic fallback source; tracking-state covariance; default tracking 'unavailable'
- [x] Imports via expo / expo/config-plugins; MARIONETTE_HTML_FILE relative to INIT_CWD; README
- [x] Tests: realistic ARKit fixtures; gateway safety cases

## Verification
- [x] npm test, typecheck, lint, viewer build, Swift compile (simulator build)
- [x] Verification subagent (Opus 5.5 xhigh) on the diff — P0/P1 only

## Review (2026-10-26)
- Final verification pass (Opus 5.5 xhigh, read-only): **no P0/P1**. Stop rule met.
- It confirmed frames, column-major packing, the calibration formulas, clutch, gateway safety (E-stop first, owner-only deadman, gates, renew/expire, re-press, releases), phone generation filtering, WebView origin check, iOS Origin vs allowlist, and the viewer frame mapping.
- P2 fixed afterwards: a deadman release sent under a new session ID before that session's first pose (after a world reset) was rejected, so the hold expired and the next press was silently ignored. The gateway now accepts hold releases before the session check (a release only stops motion), and gateway-side releases say "lift and press again". There is a regression test, and a mutation check confirmed it fails without the fix.
- P2 left as is: after a quick origin taken with the phone upright, the viewer shows the phone flat. That's by design, because the calibrated identity = the capture pose.
- Results: backend 18, protocol 15, viewer 2 tests pass (3 consecutive runs); typecheck, lint and viewer build are clean; the ArkitModule simulator xcodebuild succeeded.
- Live e2e (scripted phone with real ARKit transforms at a 30° heading, dev gateway, viewer): guided calibration passed with lift contamination, a 100 mm lift read (0, 0, 100) mm, a 50 mm move at 2× gave a 100 mm target, there were no pose echoes, and releasing the deadman disengaged.
- Not yet done: run on a physical iPhone (ARKit session, interruption/world reset, camera permission, WebView bridge on device).
- Deferred: clock-sync/latency rejection, quaternion sign canonicalization, React error boundary.

# Round 2 — REP-103 frame, calibration check, diagnostics (2026-10-27)

User report from the device test: in the viewer, forward phone motion looked like it went up in Z, and motion looked "weird". The gateway trace showed forward = +Y (old frame). The leading suspects are the viewer perspective (operator forward drawn going into the screen) and unlabelled axes, but that isn't proven. Plan: add diagnostics plus a post-calibration check, and keep the calibration measurement logic as it is.

Decision (user): output frame = ROS REP-103: **X forward, Y left, Z up** (right-handed). Check expectations: forward → +X, right → −Y, up → +Z.

- [x] Protocol: body frame X top / Y left / Z screen (camera ⊗ Rz 180°); uncalibrated ARKit→operator (−z, −x, y); calibrated F columns (forward, left, up). Guided/quick measurement unchanged.
- [x] Protocol: check steps `check-forward/right/up`, `checkCalibrationMove` (largest component on the expected axis + sign, ≥30 mm), shared step labels/instructions, sanitizeConfig keeps a validated `check`.
- [x] Gateway: after `up`, activate the frame and run the 3 check moves (each measured from the previous press); result in `config.calibration.check`; teleop stays blocked until the check finishes.
- [x] Gateway: JSONL diagnostics log (poses at 10 Hz: raw ARKit + operator, top/left/screen axes in both frames; calibration captures/rejects/frame/check; session; teleop), plus console lines for calibration.
- [x] Viewer: REP-103 scene mapping, phone mesh in the new body frame, labelled axes, live motion-direction + top-edge/screen readouts, check results.
- [x] Phone + HTML sample: axis labels, check steps and results.
- [x] Tests updated + new check tests; README frames/calibration/logging.
- [x] Verify: tests/typecheck/lint/build, simulated e2e with real ARKit transforms, rebuild + reinstall the iPhone app
- [x] Live device check by the user (calibration + check + viewer views), then read `logs/gateway-*.jsonl`
- [x] Check moves measured from the flat spot instead of the previous press (device run showed the user lowers the phone after `up`)
- [ ] Device re-run with the flat-spot check

## Review (round 2)
- Frame is now REP-103 (X forward, Y left, Z up). Guided and quick measurement are unchanged; only the camera→body rotation (Rz 180°), the uncalibrated world→operator mapping (−z, −x, y) and the frame columns (forward, left, up) changed. Mutation checks (old body rotation, old world mapping, old frame columns, a left-handed check) each fail protocol tests.
- Guided calibration now ends with three check moves (forward → +X, right → −Y, up → +Z, largest component, ≥30 mm, each from the previous press). Teleop stays blocked until the check finishes. Results are shown on the phone, in the viewer and in the HTML page.
- Diagnostics: `logs/gateway-<time>.jsonl` (poses at 10 Hz with raw/operator positions, quaternions and top/left/screen axes; calibration captures, rejects, frame, checks; session/tracking/hold/teleop/E-stop) plus console lines.
- Viewer: labelled axes, 3D/Top/Side views, "Moving (0.5 s)" dominant-axis readout, top-edge/screen direction readouts.
- Results: protocol 18, backend 19, viewer 2 tests pass; typecheck, lint and viewer build are clean. Scripted-phone e2e at a 30° heading: the check passed (+X/−Y/+Z), 100 mm single-axis moves read exactly on-axis, the 2× clutch gave (0, −100, 0) mm, a deliberately wrong forward check reported "forward → -Y ✗ expected +X", and teleop was refused during the check. The viewer's Moving readout followed each sweep. The iPhone Release build is installed.
- Likely explanation of the original report (not yet confirmed on device): in the angled 3D view, forward motion goes into the screen and looks like a lift. Top/Side views and the numeric readout now separate them.
- Device run 1 (iPhone 16 Pro Max, gateway log 01:15): guided frame forward [0.049, 0, -0.999] / left [-0.999, 0, -0.049] / up [0, 1, 0], heading -2.8°. Check: right → -Y ✓ (141 mm) and up → +Z ✓ (243 mm). Forward read x +116 (correct axis) but z -287 because the phone was lowered from the up capture first, so the chained check failed. All 573 calibrated poses had top edge → +X and screen → +Z. Conclusion: the frame is right on the device, and the chained check design was fragile. Each check move is now the calibrated position from the flat spot.

# Round 3 — UI/UX redesign: HTML-first phone, paper console (2026-10-27)

User: the uncalibrated frame now looks right on device. The calibration UX (small text in a small HTML box) is bad. The HTML must be the whole phone screen and do everything over the same gateway routes: calibration, validation, camera, E-stop. No native fallback controls. Before connecting, both apps show a simple IP page. The viewer becomes a Rerun-like console in a paper theme (Notion × Rerun), sketchy but restrained. The calibration check is validation only.

Design tokens (engineering notebook): paper #fafaf6 with a #dfe5ee grid, graphite #2e3033, ballpoint blue #2f53b5 (live/primary), red pen #d23a2f (stop/fail), green pencil #3f7d4e (pass), highlighter #f6e36b (active). Type: IBM Plex Sans (UI, tabular numbers), Kalam (margin notes and axis labels only), IBM Plex Mono (addresses/IDs only); system fallbacks (Noteworthy on iOS) so the phone works offline.

- [x] Mockups (phone connect / home / calibration step; viewer connect / console) → user check-in (approved: "go ahead and build it out")
- [x] Phone native: IP page (accepts IP, IP:port or ws:// URL; remembers the last one) → full-screen WebView; loading and error states; on disconnect, back to the IP page with the reason. Remove native pose/calibration/control/camera/safety UI. ARKit and hold logic unchanged.
- [x] Bridge (additive, still v1): `on()` replays the last value of each type; new `tracking` and `connection` events; `Marionette.disconnect()`; safe-area-aware full-screen page.
- [x] Default phone screen (sample HTML): status strip with E-stop, big hold-to-move pad, grip, live pose, camera return, settings, generic rendering for unknown config controls, full-screen calibration wizard (drawn step illustrations, live distance, big capture button, gateway errors inline), optional Validate with live axis meters.
- [x] Gateway: calibration completes at `up` (teleop allowed); validation is a separate `calibration.check` control (start / forward / right / up / cancel), measured from the flat spot, and never gates anything.
- [x] Viewer: IP page → console with streams panel (visibility toggles), spatial view (3D/Top/Side on graph paper with handwritten axis labels), X/Y/Z time-series plot, camera, inspector (pose, calibration + validation, teleop, controls), timeline + event log.
- [x] Tests, README, rebuild + reinstall phone, e2e (scripted phone + viewer screenshots).

## Review (round 3)
- **Gateway / protocol:** guided calibration is done at `up` (teleop allowed). Validation is `calibration.check` (start / forward / right / up / cancel), measured from the flat spot, never gates teleop, refused while engaged, and cancelling keeps the last result. `calibration.cancel` restores the frame from before `start`. `calibration.anchor` drives the live meters. Replies carry `values.accepted`. Renewals carry `renew: true` and can't start a hold. `/screen` serves the phone page for a desktop browser; `MARIONETTE_HTML_FILE` hot-reloads on real content changes.
- **Shared bridge:** `htmlBridgeScript(post)` in protocol, used by the app and the preview: `on()` replays the last value, plus `tracking`, `connection`, `latest()` and `disconnect()`.
- **Phone:** the native connect page (address parser, recent addresses in expo-file-system, 8 s timeout, clear errors) leads to the gateway page full screen, with no native controls. The default page has a floating Stop, E-stop banner, hold pad, grip, pose, camera, config-driven rows, a full-screen calibration wizard with live drawings and meters, and optional validation where the drawing follows the calibrated position.
- **Viewer** (Opus 5.5 xhigh subagent): connect page, then a Rerun-style paper console with streams, 3D/Top/Side view, plot, camera, inspector, timeline and log.
- **Independent review** (Opus 5.5 xhigh) found 3 P1s, all fixed and tested:
  - The deadman could stick if the dock was rebuilt mid-hold. Fixed in the page (release what was pressed; dispose before rebuild), in the app (any release for a held id ends it), and in the gateway (renewals can't start holds). The same gap in the viewer's hold cards is fixed too.
  - The E-stop was unreachable behind the sheets. Stop now floats above everything; sheets wait for the pad to be released; validation is refused while engaged.
  - wss labels downgraded to ws. Labels now keep `wss://`, with a round-trip test.
- **P2s also fixed:** releases are sent before the socket closes; holds drop on a new document or a WebView crash; `originWhitelist` is `*` so the navigation handler runs; preview Disconnect stays disconnected and unsent actions are reported; hot reload skips unchanged files; hold buttons beyond two get rows; the inconsistent-up message shows; the tilt meter uses gravity; listener leak fixed; release messages use control labels.
- **Verification:**
  - `npm test`: protocol 20, gateway 24, viewer 24. Typecheck, lint and the viewer build are clean.
  - Desktop preview runs: the full calibration and validation flow, E-stop latch and reset, and Stop staying on top over the sheets.
  - iOS simulator: connect page, live page, lost connection and unreachable address.
  - Device Release build installed on the iPhone.
  - Gateway tests flaked once (2 of 22) while an Xcode build loaded the CPU; repeated runs pass. They use short sleeps.
- **Not done:** an on-device run of the new UI (it's installed and waiting for you). The phone still has to be opened by hand.

## Round 4: calibration stuck at "waiting for good tracking" (2026-10-26)
User: on device, calibration sat at "waiting for good tracking". It should capture within a rough tolerance of flat, even handheld; it's only a rough axis alignment. (Teleop already works uncalibrated.)

Root cause (gateway log `logs/gateway-2026-10-27T04-19-35-628Z.jsonl`): calibration started at 04:30:29. Tracking went `limited` at 04:30:13 and only recovered at 04:32:48. The phone lay on the desk the whole time (tilt 0–3°, position still to the millimetre), so the back camera saw nothing. Every capture and check, in the gateway (`isUsablePose`) and on the sheet (Capture button disabled), requires `normal` tracking. The tilt tolerance (30°) was never the blocker.

- [x] Gateway: calibration captures, validation checks and quick origin accept ARKit `normal` or `limited` (fresh, heartbeat, not synthetic). Teleop stays `normal`-only.
- [x] Phone sheet: Capture/Check follow the same gate; under limited tracking the move steps hint to lift the phone so the camera sees the room; "waiting for tracking" only when capture is really blocked.
- [x] Copy: handheld instead of "lay it on a table / slide" (sheet, protocol step text, gateway messages, README).
- [x] Tests: limited tracking captures a full guided calibration and validation; initializing, relocalizing and synthetic are refused; the teleop gate is unchanged.
- [x] Verify: npm test, typecheck, lint; scripted phone with limited tracking through the desktop preview; rebuild and reinstall the phone app if anything native changed (the HTML is served by the gateway, so the page itself needs only a gateway restart).

## Review (round 4)
- **Fix:** a new gateway gate `isCalibrationPose` (ARKit, heartbeat, fresh, `normal` or `limited`) covers guided captures, validation checks and quick origin. Teleop and holds still use `isUsablePose` (`normal` and covariance). The phone sheet mirrors it (`canCalibrate`, which also refuses synthetic motion). Under limited tracking, a move step whose meter hasn't reached 30 mm says to hold the phone up so the camera sees the room. The flat tolerance is now named (`FLAT_TOLERANCE_DEGREES = 30`; `FLAT_DEG` in the page), and the copy is handheld ("Hold it flat… in your hand is fine", "move" rather than "slide").
- **Tests:** gateway 25 (new: a full guided calibration and validation on limited tracking that never engages teleop; initializing, relocalizing and synthetic are refused for calibration), protocol 20, viewer 24. Typecheck and lint are clean.
- **E2E:** a scratch gateway on 18787 with a scripted phone reporting `limited`, driven through `/screen` in the preview. Capture was enabled at 11° tilt; flat, forward, right and up were captured (heading 32.6° against the simulated 30°, with 1 cm of forward drift added on purpose); validation passed +X / −Y / +Z. One preview tab hung after the iPhone preset resize. A fresh tab ran the same flow with a heartbeat (longest gap 201 ms), so it was the tab, not the page.
- **Deployed:** the gateway on 8787 was restarted (no clients were connected) and serves the new page. No native change, so the app wasn't rebuilt.
- **Not done:** an on-device retry by the user.

## Round 5: several phones, one gateway (2026-10-26)
User: support several phones on one backend (two iPhones, one per hand, one arm each); same phone UI; the viewer shows every phone in its own color at the same polish. After the plan and mockup check-in: Stop must not be a hard gateway E-stop either. Every control is a signal associated with its phone. A consumer (e.g. a ROS 2 node: one topic for button presses, one for the phone's pose) plugs into the gateway and decides stopping, scale and so on; that's why the screen is customizable HTML. Also: support several camera streams at once, with a Head cam / Arm cams toggle (one simulated head stream, or two simulated arm streams side by side). Then have a subagent check the work, find and fix bugs and UI/UX issues, and report back.

Mockup approved (viewer with two phones, the phones' identity chip and color rule). Phone colors are amber `#c98200` and orchid `#b04fc4`, validated with the dataviz palette script against the paper and the axis colors; no third hue passed, so later phones are graphite and named.

- [x] Protocol: `hello`, `PhoneInfo`, per-phone `config` (`phone`) plus the gateway view (`phones` roster), `phoneId` on pose and status, `input` (the verbatim button stream), `cameraViews` + `selectedCameraView`, `phoneColor`; removed `teleop`, `safety`, `activeCameraId`, `teleop_target` and the clutch.
- [x] Gateway rewrite as a relay: per-phone records (pose, watchdog, calibration, values, holds); hello/deviceId identity with takeover; legacy phones; 250 ms console grace; routing (phones see only their own config, status and camera view; consoles see everything; `/screen?phone=` mirrors act as that phone); holds tracked only for liveness, with gateway-inferred releases relayed; no arbitration, no E-stop latch, no deadman gating; three simulated camera streams in two views; any client can feed a declared stream; a screen can declare controls and cameras (`marionette-config` JSON block); undeclared actions relayed; per-phone diagnostics.
- [x] Phone screen: identity chip and top color rule; Stop is the phone's own toggle with Reset; pad shows Holding once the gateway confirms; headline without teleop semantics; one or two camera panes for the phone's view.
- [x] App: hello with a persisted device id; camera frames for its view only; ignores another phone's config or status. Device build r7 succeeded (not yet installed).
- [x] ROS 2 bridge (`consumers/ros2`): per-phone `pose` (PoseStamped), `buttons` (JSON events), `tracking`, roster; pure translation with unit tests; `--dry-run`.
- [x] Viewer (Opus 5.5 xhigh subagent): per-phone store, phone pills, per-phone streams tree, stations in 3D with Overlay, per-phone plot strips, camera panel with its own view, read-only inspector with phone tabs, phone-tagged events, two simulated phones. 56 tests.
- [x] README rewritten (several phones, consuming Marionette with a message table, ROS 2, cameras, custom screens with declared controls).
- [x] Review subagent A (gateway, protocol, phone screen, app, bridge): 7 P1s and many P2s fixed (see below).
- [x] Review subagent B (viewer UI/UX and integration with the reviewed gateway): 2 P1s and about a dozen P2s fixed; 65 viewer tests.
- [x] Device build r8 with the review fixes, installed on the iPhone (not launched).

## Review (round 5)
- **Design:** the gateway is a relay. Per-phone pose and input streams, tagged with the phone, go to consoles. Marionette keeps values, hold liveness and calibration, and decides nothing about motion: no Stop latch, no deadman gating, no arbitration, no clutch. Several phones connect at once, each with its own identity and color.
- **Review A** (gateway, protocol, phone screen, app, bridge) fixed 7 P1s:
  - script injection through `/screen?phone=`
  - consoles missing phone configs on disconnect and reconnect
  - the app could lock onto another phone's identity after a slow hello
  - best-effort ROS poses that reliable subscribers never receive
  - no latched per-phone ROS state for late starters
  - bridge crashes and stale latched topics when the gateway drops
  - a pad stuck on "Holding…" after the gateway dropped a hold

  It also fixed P2s: takeover resets, hot-reload edge cases, CORS limited to the WebSocket origin rule, uncropped 16:9 camera panes, headline priorities, and bridge shutdown and address parsing.
- **Review B** (viewer) fixed 2 P1s, Stop clipped in the top bar with many phones and Stop not shown clearly in the inspector, plus P2s: 3D label collisions, a WebGL context leak, duplicate release lines, takeover narration, duplicated calibration instructions, tab overflow, copy and accessibility.
- **Verification:** gateway 25, viewer 65, protocol 20 and bridge tests pass; typecheck, lint and build are clean. Live checks used two to six scripted phones, the `/screen` mirror and the bridge in dry-run mode. Device build r8 is installed on the iPhone.
- **Docs and tools:** README (several phones, consuming Marionette, ROS 2, cameras, custom screens, developing without iPhones), `docs/INTEGRATION.md` for the robot-side agent, `tools/phone-sim.mts` and `tools/act.mts`.
- **Repo:** pushed to `theinstancelabs/marionette` (private).
- **Incidents:** the viewer subagent briefly killed OpenClaw on port 18791, and launchd restarted it (lesson recorded). The 8787 gateway and the 15173 viewer each hit the background time limit once and were restarted with longer limits.
- **Not done or known limits:**
  - The rclpy bridge has never run under real ROS 2.
  - A device id restored from a backup clones a phone's identity.
  - On-device test with two real iPhones.
