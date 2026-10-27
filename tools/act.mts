// Acts as a desktop mirror of one phone (like /screen) and sends one action, optionally holding it, with the SDK's SimPhone.
// Usage (from the repo root): npx tsx tools/act.mts <port> <phoneId> <controlId> <action> [value] [holdMs] [renew=yes|no]
//   npx tsx tools/act.mts 8787 phone-2 estop safety.estop true          (turn Phone 2's Stop on)
//   npx tsx tools/act.mts 8787 phone-1 deadman teleop.deadman true 3000  (hold Phone 1's deadman for 3 s)
//   npx tsx tools/act.mts 8787 phone-1 drive base.drive '{"x":0.5,"y":0}' 2000   (push Phone 1's stick half forward for 2 s)
// A stick value (JSON {x, y}) streams live samples while held, repeated every 50 ms, then lets go back to rest.
// With renew=no the repeats stop, so the gateway ends the hold or the drag itself. env HOST, TOKEN as for phone-sim.
import type { ControlValue } from '@marionette/protocol';
import { SimPhone } from '@marionette/sdk/testing';

const [port, phoneId, controlId, action, raw, holdMs, renew = 'yes'] = process.argv.slice(2);
const parse = (text: string) => { try { return JSON.parse(text); } catch { return text; } };
const value = (raw === undefined ? undefined : parse(raw)) as ControlValue | undefined;
const stick = !!value && typeof value === 'object';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const mirror = await SimPhone.connect(`ws://${process.env.HOST ?? 'localhost'}:${port}/ws`, { mirrorOf: phoneId, token: process.env.TOKEN });
if (renew !== 'yes') mirror.pauseRenewals();
if (stick) {
  mirror.drag(action, value!, { controlId });
  if (holdMs) { await sleep(Number(holdMs)); if (renew === 'yes') mirror.letGo(action); else await sleep(1200); }
  else mirror.letGo(action);
} else if (holdMs) {
  mirror.press(action, { controlId, value });
  await sleep(Number(holdMs));
  if (renew === 'yes') mirror.release(action); else await sleep(1200);
} else mirror.act(action, value, { controlId });
await sleep(300); mirror.close(); console.log('sent', controlId, action, JSON.stringify(value), holdMs ?? '');
