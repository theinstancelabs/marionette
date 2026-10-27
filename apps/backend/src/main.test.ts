import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bundle } from '../scripts/bundle.js';
import { sleep, tempDir } from './test-helpers.js';

// The single-file gateway with plain node, as the Python SDK runs it (tsx's own wrapper process would hide exits).
const built = tempDir(); let file = '';
beforeAll(async () => { file = await bundle({ outfile: path.join(built, 'marionette-gateway.mjs') }); }, 30_000);
afterAll(() => fs.rmSync(built, { recursive: true, force: true }));
const children: { child: ChildProcessWithoutNullStreams; dir: string }[] = [];

/** The gateway as a child with a pipe on its stdin. */
function run(env: Record<string, string> = {}) {
  const dir = tempDir();
  const child = spawn(process.execPath, [file], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, PORT: '0', MARIONETTE_HOME: dir, MARIONETTE_LOG_DIR: dir, MARIONETTE_MDNS: 'off', MARIONETTE_AUTH: 'off', ...env } });
  children.push({ child, dir });
  const out = { text: '' }; child.stdout.on('data', d => { out.text += d; }); child.stderr.on('data', d => { out.text += d; });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  return { child, out, exited };
}
/** One that listens on a free port; resolves once it does. */
async function gateway(env: Record<string, string> = {}) {
  const { child, out, exited } = run(env);
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setInterval(() => { const found = /listening on http:\/\/0\.0\.0\.0:(\d+)/.exec(out.text); if (found) { clearInterval(timer); resolve(Number(found[1])); } }, 20);
    void exited.then(code => { clearInterval(timer); reject(new Error(`exited ${code}: ${out.text}`)); });
  });
  return { child, port, exited };
}
const listening = (port: number) => fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false);
const within = <T>(promise: Promise<T>, ms: number) => Promise.race([promise.then(() => 'exited'), sleep(ms).then(() => 'running')]);

afterEach(async () => {
  for (const { child, dir } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const gone = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await gone; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('the gateway as a child process', () => {
  it('stops when its parent goes, with MARIONETTE_EXIT_WITH_PARENT=1', async () => {
    const { child, port, exited } = await gateway({ MARIONETTE_EXIT_WITH_PARENT: '1' });
    expect(await listening(port)).toBe(true);
    child.stdin.end(); // what the operating system does to the pipe when the parent ends
    const started = Date.now();
    expect(await exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(await listening(port)).toBe(false);
  }, 20_000);

  it('still exits when it can\'t listen, though the pipe stays open', async () => {
    const { port } = await gateway();
    const { exited } = run({ PORT: String(port), MARIONETTE_EXIT_WITH_PARENT: '1' });
    expect(await within(exited, 5000)).toBe('exited');
  }, 20_000);

  it('ignores its stdin otherwise', async () => {
    const { child, port, exited } = await gateway();
    child.stdin.end();
    expect(await within(exited, 700)).toBe('running');
    expect(await listening(port)).toBe(true);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 20_000);
});
