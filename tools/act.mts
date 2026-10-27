// Acts as a desktop mirror of one phone (like /screen) and sends one action, optionally holding it.
// Usage (from the repo root): npx tsx tools/act.mts <port> <phoneId> <controlId> <action> [value] [holdMs] [renew=yes|no]
//   npx tsx tools/act.mts 8787 phone-2 estop safety.estop true          (turn Phone 2's Stop on)
//   npx tsx tools/act.mts 8787 phone-1 deadman teleop.deadman true 3000  (hold Phone 1's deadman for 3 s)
//   npx tsx tools/act.mts 8787 phone-1 drive base.drive '{"x":0.5,"y":0}' 2000   (push Phone 1's stick half forward for 2 s)
// A stick value (JSON {x, y}) streams live samples while held, repeated every 50 ms, then lets go back to rest.
// With renew=no the repeats stop, so the gateway ends the hold or the drag itself.
import WebSocket from 'ws';
const [port, phoneId, controlId, action, raw, holdMs, renew = 'yes'] = process.argv.slice(2);
const parse = (text: string) => { try { return JSON.parse(text); } catch { return text; } };
const value = raw === undefined ? undefined : parse(raw);
const stick = !!value && typeof value === 'object';
const ws = new WebSocket(`ws://${process.env.HOST ?? 'localhost'}:${port}/ws`);
await new Promise(r => ws.once('open', r));
ws.send(JSON.stringify({ type: 'hello', version: 1, role: 'console', follow: phoneId }));
await new Promise(r => setTimeout(r, 300));
const send = (extra: object) => ws.send(JSON.stringify({ type: 'action', version: 1, sessionId: 'mirror', controlId, action, value, sentAt: Date.now(), ...(stick ? { live: true } : {}), ...extra }));
send({});
if (holdMs) {
  const timer = renew === 'yes' ? setInterval(() => send({ renew: true }), stick ? 50 : 200) : undefined;
  await new Promise(r => setTimeout(r, Number(holdMs)));
  if (timer) { clearInterval(timer); send(stick ? { value: { x: 0, y: 0 }, live: undefined } : { value: false }); }
  else await new Promise(r => setTimeout(r, 1200));
} else if (stick) send({ value: { x: 0, y: 0 }, live: undefined });
await new Promise(r => setTimeout(r, 300)); ws.close(); console.log('sent', controlId, action, JSON.stringify(value), holdMs ?? '');
