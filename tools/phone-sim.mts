// A scripted iPhone for development without real phones: it sends the same hello, ARKit camera transforms and
// actions the app does. Usage (from the repo root): npx tsx tools/phone-sim.mts <port> [calibrate|wander|follow]
//   env HOST=<gateway host> (default localhost), DEVICE=<id> (identity kept across runs), YAW=<degrees> (heading, default 30),
//   ARM=left|right, TRACKING=normal|limited, PHASE=<seconds> (offsets the wander), OFFSET_FILE=<path> (follow mode)
//   calibrate: runs guided calibration (flat, forward, right, up), validates it, then wanders.
//   wander:    just streams gentle motion so viewers have something live to draw.
import WebSocket from 'ws';
import { poseFromTransform, rotateVector } from '../packages/protocol/src/index.ts';
const port = Number(process.argv[2] ?? 18787); const mode = process.argv[3] ?? 'wander';
const ws = new WebSocket(`ws://${process.env.HOST ?? 'localhost'}:${port}/ws`); const messages: any[] = [];
ws.on('message', d => messages.push(JSON.parse(d.toString())));
await new Promise(r => ws.once('open', r));
ws.send(JSON.stringify({ type: 'hello', version: 1, role: 'phone', deviceId: process.env.DEVICE ?? `sim-${Math.random().toString(36).slice(2, 9)}` }));
const session = `iphone-sim-${Math.random().toString(36).slice(2, 7)}`; let seq = 0; const yaw = Number(process.env.YAW ?? 30) * Math.PI / 360; const q = { x: 0, y: Math.sin(yaw), z: 0, w: Math.cos(yaw) };
const right = rotateVector(q, { x: 1, y: 0, z: 0 }), top = rotateVector(q, { x: 0, y: 0, z: -1 }), up = { x: 0, y: 1, z: 0 };
const origin = { x: 0.2, y: -0.1, z: 0.3 }; let offset = { r: 0, f: 0, u: 0 }; let tilt = 0;
const position = () => ({ x: origin.x + offset.r * right.x + offset.f * top.x, y: origin.y + offset.u, z: origin.z + offset.r * right.z + offset.f * top.z });
const send = (m: unknown) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
// Tilt rolls the phone about its long axis a little so orientation readouts move too.
setInterval(() => { const p = position(); const c = Math.cos(tilt), s = Math.sin(tilt); const r = { x: right.x * c + up.x * s, y: right.y * c + up.y * s, z: right.z * c + up.z * s }; const u = { x: up.x * c - right.x * s, y: up.y * c - right.y * s, z: up.z * c - right.z * s };
  send(poseFromTransform([-top.x, -top.y, -top.z, 0, r.x, r.y, r.z, 0, u.x, u.y, u.z, 0, p.x, p.y, p.z, 1], session, seq++, performance.now() / 1000, (process.env.TRACKING ?? 'normal') as any)); }, 16);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const action = (controlId: string, name: string, value?: unknown) => send({ type: 'action', version: 1, sessionId: session, controlId, action: name, value, sentAt: Date.now() });
const lastStatus = () => messages.filter(m => m.type === 'status').at(-1)?.message;
const glide = async (to: Partial<typeof offset>, steps = 40) => { const from = { ...offset }; for (let i = 1; i <= steps; i++) { offset = { r: from.r + ((to.r ?? from.r) - from.r) * i / steps, f: from.f + ((to.f ?? from.f) - from.f) * i / steps, u: from.u + ((to.u ?? from.u) - from.u) * i / steps }; await sleep(25); } await sleep(300); };
const step = async (controlId: string, name: string, value?: string) => { action(controlId, name, value); await sleep(400); console.log(`${value ?? name}:`, lastStatus()); };
await sleep(800);
if (process.env.ARM) action('arm', 'arm.select', process.env.ARM);
if (mode === 'calibrate') {
  await step('calibration-start', 'calibration.start'); await sleep(800);
  await step('calibration', 'calibration.capture', 'flat'); await glide({ f: 0.12 }); await step('calibration', 'calibration.capture', 'forward');
  await glide({ f: 0 }); await glide({ r: 0.11 }); await step('calibration', 'calibration.capture', 'right');
  await glide({ r: 0 }); await glide({ u: 0.15 }); await step('calibration', 'calibration.capture', 'up'); await glide({ u: 0 });
  await step('calibration-check', 'calibration.check'); await glide({ f: 0.1 }); await step('calibration-check', 'calibration.check', 'forward');
  await glide({ f: 0 }); await glide({ r: 0.1 }); await step('calibration-check', 'calibration.check', 'right');
  await glide({ r: 0 }); await glide({ u: 0.1 }); await step('calibration-check', 'calibration.check', 'up'); await glide({ u: 0 });
}
// follow: the phone sits wherever OFFSET_FILE (default ./offset.json) says: {"r","f","u"} in metres right/forward/up, "tilt" in radians.
if (mode === 'follow') { const fs = await import('node:fs'); setInterval(() => { try { const o = JSON.parse(fs.readFileSync(process.env.OFFSET_FILE ?? 'offset.json', 'utf8')); offset = { r: o.r ?? 0, f: o.f ?? 0, u: o.u ?? 0 }; tilt = o.tilt ?? 0; } catch { /* keep the last offset */ } }, 50); console.log('following offset.json'); }
else console.log('wandering; Ctrl-C to stop');
let t = Number(process.env.PHASE ?? 0); if (mode !== 'follow') setInterval(() => { t += 0.016; offset = { f: 0.08 * Math.sin(t * 0.6), r: 0.05 * Math.sin(t * 0.9 + 1), u: 0.04 + 0.03 * Math.sin(t * 0.4) }; tilt = 0.25 * Math.sin(t * 0.5); }, 16);
