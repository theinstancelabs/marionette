import fs from 'node:fs';
import type { RobotLink, ScreenResult } from './robot.js';

export * from './index.js';

export type WatchScreenOptions = { title?: string; /** How often the file is checked (ms, default 250). */ intervalMs?: number };
/**
 * Node only: shows an HTML file as the robot's screen and sends it again whenever it is saved, like the gateway's
 * `MARIONETTE_HTML_FILE`. `ready` is the gateway's answer to the first send; later answers arrive as `screen` events
 * on the link. `stop()` stops watching (the screen stays).
 */
export function watchScreen(link: RobotLink, file: string, options: WatchScreenOptions = {}): { ready: Promise<ScreenResult>; stop: () => void } {
  const ready = link.setScreen(fs.readFileSync(file, 'utf8'), options.title);
  const changed = (current: fs.Stats, previous: fs.Stats) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
    let html: string;
    try { html = fs.readFileSync(file, 'utf8'); } catch (error) { console.warn(`Marionette: ${file} not sent: ${(error as Error).message}`); return; }
    void link.setScreen(html, options.title);
  };
  fs.watchFile(file, { interval: options.intervalMs ?? 250 }, changed);
  return { ready, stop: () => fs.unwatchFile(file, changed) };
}
