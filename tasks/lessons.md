# Lessons

## 2026-10-27 — Don't dismiss a visual symptom with aggregate numbers
- **What happened:** The user said the phone in the viewer moved "the same directions" after calibration, then "forward goes upwards in Z". I answered "not a bug" using the gateway's numbers (calibrated heading 3.7° from default). The numbers were right, but the user was describing what the **viewer** drew: forward motion going into an angled 3D view looks like a lift, and the axes had no labels.
- **Rule:** When the user reports what they *see*, look at that same view with the same data (screenshot the viewer while replaying the motion) before concluding. Make the display unambiguous (labels, top/side views, a numeric "moving along" readout) rather than explaining it away.

## 2026-10-27 — Pick robot frames by convention and confirm early
- **What happened:** I chose +X right, +Y forward, +Z up for the operator frame. The user expected forward = +X. Their literal ask (forward +X, right +Y, up +Z) is left-handed, so I asked and they chose ROS REP-103 (X forward, Y left, Z up).
- **Rule:** For anything robot-facing, default to REP-103 and state the frame in the first plan. If a requested frame is left-handed, flag it before building.

## 2026-10-27 — Long preview evaluates can stall the page's socket
- **What happened:** A `preview_evaluate` with a ~19 s async loop timed out at 15 s. The viewer's existing WebSocket then stopped delivering messages (fresh sockets were fine), which looked like a viewer bug.
- **Rule:** Keep preview evaluates short. For sampling, install a `setInterval` that writes into `window` and read it back in a later call. Reload before trusting a page after an evaluate timeout.

## 2026-10-27 — Say it when you change how something runs
- **What happened:** Port 5173 was taken, so I started the viewer on 15173 and only mentioned it inside a long summary. Later the session ended and every server stopped. The user went to 5173 and found nothing.
- **Rule:** Any change to ports, URLs, addresses, or which processes are running gets its own clear line when it happens ("Viewer moved to http://localhost:15173 because 5173 is busy"). After a session restart, check what's still running and say so before giving the user URLs.

## 2026-10-27 — Never drive desktop apps with the user's mouse
- **What happened:** To check the new iPhone app I booted the iOS Simulator and tapped it with AppleScript (`activate` + System Events `click at`, `keystroke`). Every call pulled the Simulator to the front and moved the pointer while the user was working: "You keep stealing focus from my mouse".
- **Rule:** No GUI automation that takes the foreground, the pointer or the keyboard (osascript/System Events clicks or keystrokes, `open -a`, activating apps). Verify UI through things that run off-screen: the T3 browser preview, headless scripts, `simctl io screenshot` with no input, unit/e2e tests. If a check truly needs real taps, ask the user first or ask them to do it.

## 2026-10-26 — Gate each feature on what it actually needs
- **What happened:** Calibration reused the teleop gate (ARKit `normal` + covariance) while telling the user to lay the phone flat on the desk. That blinds the back camera, so ARKit sat in `limited` for minutes and the Capture button never enabled ("stuck at waiting for good tracking"). The gateway log showed it straight away: tilt 0–3°, position frozen, `limited` throughout.
- **Rule:** Don't reuse a safety gate for a non-safety feature; write down what each feature needs (calibration needs gravity plus rough moves, teleop needs good tracking). For ARKit flows, never instruct a pose that covers or blinds the camera. On a device bug, read `logs/gateway-*.jsonl` before guessing.

## 2026-10-26 — Marionette relays; the consumer decides
- **What happened:** My multi-phone plan kept a gateway E-stop latch and per-phone deadman gating as "advisory" state. The user: the E-stop should be a signal like every other button; a consumer (e.g. a ROS 2 node with a pose topic and a buttons topic) decides stopping, scale and safety. That is the whole reason the phone screen is customizable HTML.
- **Rule:** Marionette's job is to deliver per-phone pose and input streams that a consumer can attribute (plus the calibration that defines each phone's axes). Don't build consumer decisions into the gateway: no latches, gates, arbitration or refusals based on robot semantics. When a feature smells like control policy, relay it as data and document how a consumer would use it.

## 2026-10-26 — Scratch ports: check they're free, stop by PID
- **What happened:** A viewer subagent picked port 18791 for a scratch gateway without checking it, then stopped "its" server with a kill by port. That port belonged to the user's OpenClaw gateway, which went down until launchd restarted it.
- **Rule:** Before using a scratch port, check it with `lsof -nP -iTCP:<port> -sTCP:LISTEN`. Record the PIDs you start and stop only those; never `kill $(lsof -t -i:<port>)` for a port you didn't verify was yours. Put this in every subagent brief that starts servers, along with the ports that must not be touched.
