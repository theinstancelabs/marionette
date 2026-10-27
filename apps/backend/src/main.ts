import path from 'node:path';
import { createDiagnosticsLog, type DiagnosticsLog } from './diagnostics.js';
import { pairingBanner } from './pairing.js';
import { createServer } from './server.js';

/** Runs the gateway: `npm run dev:backend`, `npm --workspace @marionette/backend run start`, or the single-file bundle. */
const port = process.env.PORT ? Number(process.env.PORT) : 8787;
const cwd = process.env.INIT_CWD ?? process.cwd();
let diagnostics: DiagnosticsLog;
try { diagnostics = createDiagnosticsLog({ dir: path.resolve(cwd, process.env.MARIONETTE_LOG_DIR ?? 'logs'), poseHz: Number(process.env.MARIONETTE_POSE_LOG_HZ ?? 10) }); }
catch (error) {
  console.warn(`No diagnostics log (${(error as Error).message}); set MARIONETTE_LOG_DIR to a writable directory`);
  diagnostics = { write: record => { if (record.kind !== 'pose' && record.msg) console.log(`[${record.kind}] ${record.msg}`); }, pose: () => {}, close: () => {} };
}
const gateway = createServer(port, { diagnostics });
gateway.server.listen(port, () => {
  const info = gateway.pairing(); const file = process.env.MARIONETTE_HTML_FILE ? path.resolve(cwd, process.env.MARIONETTE_HTML_FILE) : undefined;
  console.log(`Marionette gateway "${info.name}" listening on http://0.0.0.0:${info.port}\nPhone screen preview: http://localhost:${info.port}/screen (add ?phone=phone-2 to mirror a particular phone)${file ? `\nScreen: live from ${file}` : ''}\nDiagnostics log: ${diagnostics.file ?? 'off'}`);
  pairingBanner(info).then(text => console.log(text), error => console.warn(`No pairing QR code: ${(error as Error).message}`));
});
// Closing sends the Bonjour goodbye, so phones stop listing this gateway at once.
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; setTimeout(() => process.exit(0), 2000).unref(); gateway.close().finally(() => { diagnostics.close(); process.exit(0); }); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
// A program that runs the gateway as its child (the Python SDK does) sets MARIONETTE_EXIT_WITH_PARENT=1 and keeps a
// pipe to its stdin open. However the parent ends, even killed outright, the pipe closes and the gateway stops with it.
// A child the parent forked (a multiprocessing worker, a process pool) inherits the pipe and can keep it open after the
// parent is gone, so the gateway also watches its parent: once it is reparented, its parent has ended. Neither the pipe
// nor the watch keeps the gateway running (one that couldn't listen still exits).
if (process.env.MARIONETTE_EXIT_WITH_PARENT === '1') {
  for (const event of ['end', 'close', 'error'] as const) process.stdin.once(event, stop);
  process.stdin.resume(); (process.stdin as { unref?: () => void }).unref?.();
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) stop(); }, 1000).unref();
}
