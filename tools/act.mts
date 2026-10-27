// Acts as a desktop mirror of one phone (like /screen) and sends one action, optionally holding it.
// Usage (from the repo root): npx tsx tools/act.mts <port> <phoneId> <controlId> <action> [value] [holdMs] [renew=yes|no]
//   npx tsx tools/act.mts 8787 phone-2 estop safety.estop true          (turn Phone 2's Stop on)
//   npx tsx tools/act.mts 8787 phone-1 deadman teleop.deadman true 3000  (hold Phone 1's deadman for 3 s)
import WebSocket from 'ws';
const [port, phoneId, controlId, action, raw, holdMs, renew = 'yes'] = process.argv.slice(2);
const value = raw === undefined ? undefined : raw === 'true' ? true : raw === 'false' ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
const ws = new WebSocket(`ws://${process.env.HOST ?? 'localhost'}:${port}/ws`);
await new Promise(r => ws.once('open', r));
ws.send(JSON.stringify({ type: 'hello', version: 1, role: 'console', follow: phoneId }));
await new Promise(r => setTimeout(r, 300));
const send = (extra: object) => ws.send(JSON.stringify({ type: 'action', version: 1, sessionId: 'mirror', controlId, action, value, sentAt: Date.now(), ...extra }));
send({});
if (holdMs) {
  const timer = renew === 'yes' ? setInterval(() => send({ renew: true }), 200) : undefined;
  await new Promise(r => setTimeout(r, Number(holdMs)));
  if (timer) { clearInterval(timer); send({ value: false }); }
  else await new Promise(r => setTimeout(r, 1200));
}
await new Promise(r => setTimeout(r, 300)); ws.close(); console.log('sent', controlId, action, value, holdMs ?? '');
