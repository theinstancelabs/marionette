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

/**
 * Each start tag `open` finds (a fresh global regex for the tag name, like `/<script\b/gi`): where it starts, its
 * attributes, and where it ends, just after the first `>`. The search goes on after that `>` (another `<script` among
 * a tag's attributes belongs to that tag) and stops at a tag that never closes (none after it can). So a screen is read
 * once: a `[^>]*` regex reads the rest of an unclosed tag again from every `<` in it, which a robot could make take minutes.
 */
export function* startTags(html: string, open: RegExp): Generator<{ start: number; attributes: string; end: number }> {
  for (let found = open.exec(html); found; found = open.exec(html)) {
    const close = html.indexOf('>', open.lastIndex); if (close < 0) return;
    yield { start: found.index, attributes: html.slice(open.lastIndex, close), end: close + 1 };
    open.lastIndex = close + 1;
  }
}
/** Swaps each tag `open` finds for what `replace` gives (through `end`, when that is past the tag); undefined keeps the tag. */
function replaceTags(html: string, open: RegExp, replace: (tag: { attributes: string; end: number }) => { text: string; end?: number } | undefined): string {
  const parts: string[] = []; let from = 0; let length = 0;
  for (const tag of startTags(html, open)) {
    const swap = tag.start < from ? undefined : replace(tag); if (!swap) continue;
    parts.push(html.slice(from, tag.start), swap.text); length += tag.start - from + swap.text.length; from = swap.end ?? tag.end;
    // A screen that names the kit again and again would grow without bound before the size check.
    if (length > MAX_HTML_CONFIG_BYTES) throw new Error(`it is over the ${MAX_HTML_CONFIG_BYTES / 1000} KB limit with the kit inlined`);
  }
  return parts.join('') + html.slice(from);
}
const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);
const isWord = (char: string | undefined) => char !== undefined && /\w/.test(char);
const KIT_SRC = /src\s*=\s*(["'])(?:\.?\/)?marionette-kit\.js\1/gi;
const KIT_HREF = /href\s*=\s*(["'])(?:\.?\/)?marionette-kit\.css\1/gi;
/**
 * A screen opts into the kit with `<script src="marionette-kit.js"></script>` and
 * `<link rel="stylesheet" href="marionette-kit.css">` (other attributes, and a leading `/` or `./`, are fine). Both
 * become inline copies, so the phone needs nothing but the document; nothing in the kit can close the tag early.
 * Throws when the result is over the screen size limit.
 */
export function inlineKit(html: string, kit: Kit): string {
  const js = kit.js.replace(/<\/(script)/gi, '<\\/$1'); const css = kit.css.replace(/<\/(style)/gi, '<\\/$1');
  // `src` after white space, then only white space before `</script>`; the tag keeps its other attributes.
  const scripts = replaceTags(html, /<script\b/gi, ({ attributes, end }) => {
    for (const src of attributes.matchAll(KIT_SRC)) {
      const at = src.index ?? 0; if (!isSpace(attributes[at - 1])) continue;
      const closing = /\s*<\/script\s*>/iy; closing.lastIndex = end; if (!closing.test(html)) return undefined;
      let before = at; while (isSpace(attributes[before - 1])) before--;
      return { text: `<script${attributes.slice(0, before)}${attributes.slice(at + src[0].length)}>${js}</script>`, end: closing.lastIndex };
    }
    return undefined;
  });
  return replaceTags(scripts, /<link\b/gi, ({ attributes }) => {
    for (const href of attributes.matchAll(KIT_HREF)) { const at = href.index ?? 0; if (at > 0 && !isWord(attributes[at - 1])) return { text: `<style>${css}</style>` }; }
    return undefined;
  });
}
/** From `<meta name="marionette-orientation" content="portrait|landscape|any">`. */
export function screenOrientation(html: string): ScreenOrientation | undefined {
  for (const { start, end } of startTags(html, /<meta\b/gi)) {
    const tag = html.slice(start, end);
    if (!/\bname\s*=\s*(?:"marionette-orientation"|'marionette-orientation'|marionette-orientation(?=[\s/>]))/i.test(tag)) continue;
    return /\bcontent\s*=\s*["']?(portrait|landscape|any)\b/i.exec(tag)?.[1].toLowerCase() as ScreenOrientation | undefined;
  }
  return undefined;
}

/** What the first `<script … id="marionette-config">` holds, up to its `</script>`; undefined without one. */
function configBlock(html: string): string | undefined {
  for (const { attributes, end } of startTags(html, /<script/gi)) {
    if (!/id=["']marionette-config["']/i.test(attributes)) continue;
    const close = /<\/script>/gi; close.lastIndex = end; const found = close.exec(html);
    return found ? html.slice(end, found.index) : undefined;
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
  const block = configBlock(html);
  if (block === undefined) return { layout: { controls: fallback.controls, cameraStreams: fallback.cameraStreams, cameraViews: fallback.cameraViews }, warnings: [] };
  let declared: Partial<Layout>;
  try { declared = JSON.parse(block) as Partial<Layout>; } catch { throw new Error('the marionette-config block is not valid JSON'); }
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw new Error('the marionette-config block is not a JSON object');
  const checked = sanitizeConfig({ ...fallback, sessionId: 'layout', ...declared });
  if (!checked) throw new Error('the marionette-config block is not a valid layout');
  const warnings: string[] = [];
  const pick = <T,>(key: keyof Layout, kept: T[], defaults: T[]): T[] => {
    const list = declared[key]; if (!Array.isArray(list)) return defaults;
    if (kept.length < list.length) warnings.push(`ignored ${list.length - kept.length} of ${list.length} ${key} (each needs the fields in docs/SCREENS.md)`);
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
