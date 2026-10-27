#!/usr/bin/env node
// Puts the screen kit inline in a screen, the way the gateway does before sending it: the stylesheet tag
// `<link rel="stylesheet" href="marionette-kit.css">` becomes a <style> and `<script src="marionette-kit.js"></script>`
// becomes an inline <script>. Everything else is left alone.
//   node packages/kit/scripts/inline.mjs apps/backend/src/sample-controls.html > /tmp/screen.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const kitDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KIT_SCRIPT_TAG = /<script\b[^>]*\bsrc=["'](?:\.\/)?marionette-kit\.js["'][^>]*>\s*<\/script>/gi;
export const KIT_STYLE_TAG = /<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["'](?:\.\/)?marionette-kit\.css["'][^>]*>/gi;

export function readKit() {
  return { js: fs.readFileSync(path.join(kitDir, 'marionette-kit.js'), 'utf8'), css: fs.readFileSync(path.join(kitDir, 'marionette-kit.css'), 'utf8') };
}
/** The screen with the kit's two tags replaced by the kit itself (functions as replacements, so `$` in the kit stays literal). */
export function inlineKit(html, kit = readKit()) {
  return html.replace(KIT_STYLE_TAG, () => `<style>\n${kit.css}</style>`).replace(KIT_SCRIPT_TAG, () => `<script>\n${kit.js}</script>`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node packages/kit/scripts/inline.mjs <screen.html>'); process.exit(2); }
  process.stdout.write(inlineKit(fs.readFileSync(path.resolve(process.env.INIT_CWD ?? process.cwd(), file), 'utf8')));
}
