import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HTML_BRIDGE_VERSION, HTML_CONFIG_VERSION, MAX_HTML_CONFIG_BYTES, PROTOCOL_VERSION, defaultConfig, sanitizeConfig, utf8Length, validateHtmlConfig, type ConfigMessage, type HtmlConfigMessage, type ScreenOrientation } from '@marionette/protocol';

export type Layout = Pick<ConfigMessage, 'controls' | 'cameraStreams' | 'cameraViews'>;
/** A screen as it was given (before the kit is inlined), and where it came from. */
export type Screen = { raw: string; title?: string; source: NonNullable<HtmlConfigMessage['source']> };
export type Kit = { js: string; css: string };

// The single-file bundle sets this to the default screen and the kit (scripts/bundle.ts); in the repo they are read from disk.
const embedded = (globalThis as { __marionetteAssets?: Record<string, string> }).__marionetteAssets;
export const defaultScreen = (): string => embedded?.['sample-controls.html'] ?? fs.readFileSync(new URL('./sample-controls.html', import.meta.url), 'utf8');
export const KIT_FILES = { js: 'marionette-kit.js', css: 'marionette-kit.css' } as const;

/**
 * The screen kit, read from `dir` (`MARIONETTE_KIT_DIR`), else the copy built into the bundle, else `packages/kit`.
 * A missing file reads as empty and is reported once. `reload` reads the files again and says whether they changed.
 */
export function loadKit(dir: string | undefined, warn: (message: string) => void) {
  if (!dir && embedded) return { kit: { js: embedded[KIT_FILES.js] ?? '', css: embedded[KIT_FILES.css] ?? '' }, files: [] as string[], reload: () => false };
  const root = dir ?? fileURLToPath(new URL('../../../packages/kit/', import.meta.url));
  const files = [path.join(root, KIT_FILES.js), path.join(root, KIT_FILES.css)]; const missing = new Set<string>();
  const read = (file: string) => {
    try { const text = fs.readFileSync(file, 'utf8'); missing.delete(file); return text; }
    catch { if (!missing.has(file)) { missing.add(file); warn(`${file} not found; screens that include it get an empty kit`); } return ''; }
  };
  const kit: Kit = { js: read(files[0]), css: read(files[1]) };
  return { kit, files, reload: () => { const js = read(files[0]), css = read(files[1]); if (js === kit.js && css === kit.css) return false; kit.js = js; kit.css = css; return true; } };
}

const KIT_SCRIPT = /<script\b([^>]*?)\s+src\s*=\s*(["'])(?:\.?\/)?marionette-kit\.js\2([^>]*)>\s*<\/script\s*>/gi;
const KIT_STYLE = /<link\b[^>]*?\bhref\s*=\s*(["'])(?:\.?\/)?marionette-kit\.css\1[^>]*>/gi;
/**
 * A screen opts into the kit with `<script src="marionette-kit.js"></script>` and
 * `<link rel="stylesheet" href="marionette-kit.css">` (other attributes, and a leading `/` or `./`, are fine). Both
 * become inline copies, so the phone needs nothing but the document; nothing in the kit can close the tag early.
 */
export function inlineKit(html: string, kit: Kit): string {
  return html.replace(KIT_SCRIPT, (_tag, before: string, _quote: string, after: string) => `<script${before}${after}>${kit.js.replace(/<\/(script)/gi, '<\\/$1')}</script>`)
    .replace(KIT_STYLE, () => `<style>${kit.css.replace(/<\/(style)/gi, '<\\/$1')}</style>`);
}
/** From `<meta name="marionette-orientation" content="portrait|landscape|any">`. */
export function screenOrientation(html: string): ScreenOrientation | undefined {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bname\s*=\s*(?:"marionette-orientation"|'marionette-orientation'|marionette-orientation(?=[\s/>]))/i.test(tag)) continue;
    return /\bcontent\s*=\s*["']?(portrait|landscape|any)\b/i.exec(tag)?.[1].toLowerCase() as ScreenOrientation | undefined;
  }
  return undefined;
}

/**
 * A screen can declare its own controls and cameras in
 * `<script type="application/json" id="marionette-config">{"controls": [...], "cameraStreams": [...], "cameraViews": [...]}</script>`.
 * Anything it leaves out keeps the default, except that streams declared without views get
 * one view each. Entries the gateway cannot use are dropped and reported in `warnings`.
 */
export function parseLayout(html: string): { layout: Layout; warnings: string[] } {
  const fallback = defaultConfig();
  const match = /<script[^>]*id=["']marionette-config["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return { layout: { controls: fallback.controls, cameraStreams: fallback.cameraStreams, cameraViews: fallback.cameraViews }, warnings: [] };
  let declared: Partial<Layout>;
  try { declared = JSON.parse(match[1]) as Partial<Layout>; } catch { throw new Error('the marionette-config block is not valid JSON'); }
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw new Error('the marionette-config block is not a JSON object');
  const checked = sanitizeConfig({ ...fallback, sessionId: 'layout', ...declared });
  if (!checked) throw new Error('the marionette-config block is not a valid layout');
  const warnings: string[] = [];
  const pick = <T,>(key: keyof Layout, kept: T[], defaults: T[]): T[] => {
    const list = declared[key]; if (!Array.isArray(list)) return defaults;
    if (kept.length < list.length) warnings.push(`ignored ${list.length - kept.length} of ${list.length} ${key} (each needs the fields in the README)`);
    return kept;
  };
  const controls = pick('controls', checked.controls, fallback.controls);
  // Only the gateway says how a stream is carried.
  const cameraStreams = pick('cameraStreams', checked.cameraStreams, fallback.cameraStreams).map(({ transport: _transport, publisher: _publisher, ...stream }) => stream);
  const cameraViews = Array.isArray(declared.cameraViews) ? pick('cameraViews', checked.cameraViews, fallback.cameraViews)
    : Array.isArray(declared.cameraStreams) ? cameraStreams.map(stream => ({ id: stream.id, label: stream.label, streams: [stream.id] })) : fallback.cameraViews;
  const known = new Set(cameraStreams.map(stream => stream.id));
  for (const view of cameraViews) for (const id of view.streams) if (!known.has(id)) warnings.push(`camera view "${view.id}" names a stream that is not declared: "${id}"`);
  return { layout: { controls, cameraStreams, cameraViews }, warnings };
}

/**
 * Everything the gateway needs from a screen: the `html_config` to send (kit inlined, orientation read) and the
 * layout its block declares. Throws with the reason when it can't be used; the block and the meta tag are read from
 * the screen as written, the 512 KB limit applies with the kit inlined.
 */
export function buildScreen(screen: Screen, kit: Kit, sessionId: string): { config: HtmlConfigMessage; layout: Layout; warnings: string[] } {
  const { layout, warnings } = parseLayout(screen.raw); const orientation = screenOrientation(screen.raw);
  const html = inlineKit(screen.raw, kit);
  const config: HtmlConfigMessage = { type: 'html_config', version: PROTOCOL_VERSION, sessionId, htmlVersion: HTML_CONFIG_VERSION, bridgeVersion: HTML_BRIDGE_VERSION,
    title: screen.title ?? 'Marionette HTML controls', html, ...(orientation ? { orientation } : {}), source: { ...screen.source } };
  if (!validateHtmlConfig(config)) throw new Error(utf8Length(html) > MAX_HTML_CONFIG_BYTES ? `it is ${Math.ceil(utf8Length(html) / 1000)} KB with the kit inlined, over the ${MAX_HTML_CONFIG_BYTES / 1000} KB limit` : 'it is not an HTML document');
  return { config, layout, warnings };
}
