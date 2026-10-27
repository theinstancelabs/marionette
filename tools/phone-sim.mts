// A scripted iPhone for development without real phones, built on the SDK's SimPhone: it sends the same hello, ARKit
// poses and actions the app does. Usage (from the repo root): npx tsx tools/phone-sim.mts <port> [calibrate|wander|follow]
//   env HOST=<gateway host> (default localhost), TOKEN=<pairing code> (off the gateway's computer), DEVICE=<id> (identity
//   kept across runs), YAW=<degrees> (heading, default 30), ARM=left|right, TRACKING=normal|limited, PHASE=<seconds>
//   (offsets the wander), OFFSET_FILE=<path> (follow mode)
//   calibrate: runs guided calibration (flat, forward, right, up), validates it, then wanders.
//   wander:    just streams gentle motion so viewers have something live to draw.
//   follow:    the phone sits wherever OFFSET_FILE (default ./offset.json) says: {"r","f","u"} in metres right/forward/up, "tilt" in radians.
import fs from 'node:fs';
import type { TrackingState } from '@marionette/protocol';
import { SimPhone } from '@marionette/sdk/testing';

const port = Number(process.argv[2] ?? 18787); const mode = process.argv[3] ?? 'wander';
const phone = await SimPhone.connect(`ws://${process.env.HOST ?? 'localhost'}:${port}/ws`, {
  deviceId: process.env.DEVICE, token: process.env.TOKEN, yawDeg: Number(process.env.YAW ?? 30), tracking: (process.env.TRACKING ?? 'normal') as TrackingState,
});
console.log(`connected as ${phone.config?.phone?.name} (${phone.id})`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Tilt rolls the phone about its long axis a little so orientation readouts move too.
const at = (o: { r?: number; f?: number; u?: number; tilt?: number }) => ({ right: o.r ?? 0, forward: o.f ?? 0, up: o.u ?? 0, roll: -(o.tilt ?? 0) });
await sleep(800);
if (process.env.ARM) phone.set('arm.select', process.env.ARM);
if (mode === 'calibrate') {
  await phone.calibrate({ moveMs: 600 });
  console.log('calibrated:', phone.statuses().filter(m => m.phoneId === phone.id).at(-1)?.message);
  const passed = await phone.validate({ moveMs: 600 });
  console.log('validation:', passed ? 'passed' : 'failed', phone.statuses().filter(m => m.phoneId === phone.id).at(-1)?.message);
}
if (mode === 'follow') {
  const file = process.env.OFFSET_FILE ?? 'offset.json';
  setInterval(() => { try { phone.place(at(JSON.parse(fs.readFileSync(file, 'utf8')))); } catch { /* keep the last offset */ } }, 50);
  console.log(`following ${file}`);
} else {
  console.log('wandering; Ctrl-C to stop');
  let t = Number(process.env.PHASE ?? 0);
  setInterval(() => { t += 0.016; phone.place(at({ f: 0.08 * Math.sin(t * 0.6), r: 0.05 * Math.sin(t * 0.9 + 1), u: 0.04 + 0.03 * Math.sin(t * 0.4), tilt: 0.25 * Math.sin(t * 0.5) })); }, 16);
}
