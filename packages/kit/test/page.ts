// A page in jsdom with the real page bridge (htmlBridgeScript from the protocol package) and the kit inlined, the
// way the gateway sends a screen. Timers, animation frames and Date.now go through Node's globals, so vitest's fake
// timers drive the page too.
import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { defaultConfig, htmlBridgeScript, type ConfigMessage, type HtmlBridgeFeature, type UiControl } from '@marionette/protocol';

export const KIT_JS = fs.readFileSync(new URL('../marionette-kit.js', import.meta.url), 'utf8');
export const KIT_CSS = fs.readFileSync(new URL('../marionette-kit.css', import.meta.url), 'utf8');
export const ALL_FEATURES: HtmlBridgeFeature[] = ['live', 'robot_state', 'link', 'rtc', 'reconnect', 'orientation'];

type Win = JSDOM['window'] & Record<string, any>;
export type Page = {
  dom: JSDOM; window: Win; document: Document; K: any; M: any;
  /** Everything the page handed to the host: actions, rtc signaling, disconnects. */
  posted: any[];
  actions(): any[];
  rtc(): any[];
  receive(type: string, payload: unknown): void;
  connect(state?: 'connected' | 'disconnected' | 'reconnecting'): void;
  /** Sends a phone config: the default layout, with `patch` applied to controls by id. */
  config(patch?: Record<string, Partial<UiControl>>, extra?: Partial<ConfigMessage>): ConfigMessage;
  pointer(node: Element, type: string, init?: Record<string, unknown>): void;
  errors: unknown[];
  close(): void;
};

export function phoneConfig(patch: Record<string, Partial<UiControl>> = {}, extra: Partial<ConfigMessage> = {}): ConfigMessage {
  const base = defaultConfig();
  return { ...base, sessionId: 'gateway-1', phone: { id: 'phone-1', name: 'Phone 1', color: '#c98200', connected: true }, phones: [{ id: 'phone-1', name: 'Phone 1', color: '#c98200', connected: true }],
    ...extra, controls: base.controls.map(c => (patch[c.id] ? { ...c, ...patch[c.id] } as UiControl : c)) };
}

export function page(options: { features?: HtmlBridgeFeature[]; body?: string; head?: string; html?: string; setup?: (window: Win) => void } = {}): Page {
  const errors: unknown[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (...args: unknown[]) => errors.push(args));
  virtualConsole.on('jsdomError', (error: Error) => { if (!/Not implemented/.test(String(error && error.message))) errors.push(error); });
  const bridge = `<script>window.posted=[];</script><script>${htmlBridgeScript('function(m){window.posted.push(m);}', options.features ?? ALL_FEATURES)}</script>`;
  const html = options.html
    ? options.html.replace(/<head[^>]*>/i, tag => tag + bridge)
    : `<!doctype html><html><head>${bridge}<style>${KIT_CSS}</style><script>${KIT_JS}</script>${options.head ?? ''}</head><body>${options.body ?? ''}</body></html>`;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole, url: 'http://localhost/screen',
    beforeParse(window: Win) {
      for (const name of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']) window[name] = (...args: unknown[]) => (globalThis as any)[name](...args);
      window.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16);
      window.cancelAnimationFrame = (id: unknown) => clearTimeout(id as never);
      window.Date.now = () => Date.now();
      window.PointerEvent = class extends window.MouseEvent { pointerId: number; constructor(type: string, init: Record<string, any> = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; } };
      options.setup?.(window);
    },
  });
  const window = dom.window as Win;
  const p: Page = {
    dom, window, document: window.document, K: window.MarionetteKit, M: window.Marionette, errors,
    get posted() { return window.posted as any[]; },
    actions: () => (window.posted as any[]).filter(m => m.type === 'action').map(({ controlId, action, value, live }) => (live ? { controlId, action, value, live } : value === undefined ? { controlId, action } : { controlId, action, value })),
    rtc: () => (window.posted as any[]).filter(m => m.type === 'rtc'),
    receive: (type, payload) => window.Marionette._receive({ type, payload }),
    connect: (state = 'connected') => window.Marionette._receive({ type: 'connection', payload: { state, gateway: '192.168.1.20' } }),
    config: (patch = {}, extra = {}) => { const c = phoneConfig(patch, extra); window.Marionette._receive({ type: 'config', payload: c }); return c; },
    pointer: (node, type, init = {}) => { node.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init })); },
    close: () => window.close(),
  };
  return p;
}
