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
const stop = () => { setTimeout(() => process.exit(0), 1000).unref(); gateway.close().finally(() => { diagnostics.close(); process.exit(0); }); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
