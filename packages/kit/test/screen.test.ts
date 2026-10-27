import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@marionette/protocol';
// @ts-expect-error a plain .mjs script without types
import { inlineKit } from '../scripts/inline.mjs';
import { KIT_CSS, KIT_JS, page, type Page } from './page';

const SCREEN = fs.readFileSync(new URL('../../../apps/backend/src/sample-controls.html', import.meta.url), 'utf8');
let p: Page;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { if (p) { expect(p.errors).toEqual([]); p.close(); } vi.useRealTimers(); });

describe('inlining', () => {
  it('replaces the two kit tags with the kit, and the kit never closes its own tag', () => {
    expect(KIT_JS).not.toMatch(/<\/script/i); expect(KIT_CSS).not.toMatch(/<\/style/i);
    expect(SCREEN).toContain('<link rel="stylesheet" href="marionette-kit.css">'); expect(SCREEN).toContain('<script src="marionette-kit.js"></script>');
    const html = inlineKit(SCREEN);
    expect(html).not.toContain('<script src="marionette-kit.js"></script>'); expect(html).not.toContain('<link rel="stylesheet" href="marionette-kit.css">');
    expect(html).toContain(KIT_JS); expect(html).toContain(KIT_CSS);
    expect(inlineKit('<head><link href="./marionette-kit.css" rel="stylesheet"/><script src=\'marionette-kit.js\' defer></script></head>', { js: 'x$&y', css: 'z' })).toBe('<head><style>\nz</style><script>\nx$&y</script></head>');
    expect(Buffer.byteLength(html)).toBeLessThan(512_000 / 4);
  });
});

describe('the default screen on the kit', () => {
  const load = () => { p = page({ html: inlineKit(SCREEN) }); p.connect(); p.receive('tracking', { state: 'normal', source: 'arkit' }); return p.config(); };
  const $ = (id: string) => p.document.getElementById(id)!;

  it('draws Stop, the dock, Drive base and a row for every other control', () => {
    load();
    expect($('state').textContent).toBe('Ready'); expect($('state-note').textContent).toBe('hold the pad to move the left arm');
    expect(p.document.querySelector('.mk-me')!.textContent).toBe('Phone 1');
    expect([...p.document.querySelectorAll('#dock button')].map(b => b.textContent)).toEqual(['Hold to moverelease to let go', 'Grip']);
    expect($('drive').hidden).toBe(false); expect($('drive').querySelector('h2')!.textContent).toBe('Drive base');
    expect([...$('drive').querySelectorAll('.hold.turn')].map(b => b.textContent)).toEqual(['↺Turn left', '↻Turn right']);
    expect($('drive').querySelector('.mk-row')!.textContent).toBe('Speed limit50%');
    expect([...$('rows').children].map(r => r.querySelector('span')!.textContent)).toEqual(['Calibration', 'Active arm', 'Cameras', 'Include lift', 'Translation scale', '192.168.1.20']);
    expect($('rows').querySelector('.mk-link .mk-val')!.textContent).toBe('Not calibrated');
    expect($('cam').hidden).toBe(false); expect($('cam').querySelector('.mk-empty')!.textContent).toBe('Waiting for head');
    expect((p.document.querySelector('.mk-stop') as HTMLElement).hidden).toBe(false);
  });

  it('shows what the gateway says about the pad, the stick and Stop', () => {
    load(); const pad = p.document.querySelector('#dock .pad')!;
    p.pointer(pad, 'pointerdown');
    expect(p.actions()).toEqual([{ controlId: 'deadman', action: 'teleop.deadman', value: true }]);
    expect($('state').textContent).toBe('Holding…'); expect(pad.textContent).toBe('Holding…waiting for the gateway');
    p.config({ deadman: { held: true } as never }); expect($('state').textContent).toBe('Holding'); expect(pad.getAttribute('data-state')).toBe('held');
    p.config({ deadman: { held: false } as never }); expect($('state').textContent).toBe('Hold dropped'); expect(pad.textContent).toBe('Hold droppedlet go and press again');
    p.pointer(pad, 'pointerup'); expect($('state').textContent).toBe('Ready');
    const stick = $('drive').querySelector('.mk-stick') as HTMLElement;
    stick.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON() {} });
    p.pointer(stick, 'pointerdown', { clientX: 100, clientY: 65 }); vi.advanceTimersByTime(20);
    expect(p.actions().at(-1)).toEqual({ controlId: 'drive', action: 'base.drive', value: { x: 0.5, y: 0 }, live: true });
    expect($('drive-state').textContent).toBe('Sending…'); expect($('drive-x').textContent).toBe('+0.50'); expect($('state').textContent).toBe('Driving…');
    p.config({ drive: { live: true } as never }); expect($('drive-state').textContent).toBe('Driving');
    p.pointer(stick, 'pointerup'); expect($('drive-x').textContent).toBe('0.00');
    p.pointer(p.document.querySelector('.mk-stop')!, 'pointerdown'); expect(p.actions().at(-1)).toEqual({ controlId: 'estop', action: 'safety.estop', value: true });
    p.config({ estop: { value: true } as never }); expect($('state').textContent).toBe('Stopped'); expect($('stop-banner').hidden).toBe(false);
    p.connect('reconnecting'); expect($('state').textContent).toBe('Reconnecting…');
  });

  it('opens the calibration sheet from its row, and shows the robot and whether it answers', () => {
    load();
    ($('rows').querySelector('.mk-link') as HTMLElement).click();
    const sheet = p.document.querySelector('.mk-sheet') as HTMLElement; expect(sheet.hidden).toBe(false); expect($('app').hasAttribute('inert')).toBe(true);
    expect((p.document.querySelector('.mk-stop') as HTMLElement).hasAttribute('inert')).toBe(false);
    (sheet.querySelector('.mk-left') as HTMLElement).click(); expect(sheet.hidden).toBe(true);
    expect($('robot').hidden).toBe(true);
    p.config({}, { robots: [{ id: 'axol', name: 'Axol', connected: true, screen: true }] });
    p.receive('robot_state', { type: 'robot_state', version: PROTOCOL_VERSION, robotId: 'axol', state: { ready: true }, everyMs: 200 });
    expect($('robot').textContent).toBe('Axol'); expect($('robot-dot').className).toBe('mk-dot mk-good');
    vi.advanceTimersByTime(1800); expect($('robot').textContent).toBe('Axol · not answering');
    p.config({}, { robots: [{ id: 'axol', name: 'Axol', connected: false }] }); expect($('robot').textContent).toBe('Axol · offline');
  });

  it('toasts replies with no other home', () => {
    load();
    p.receive('status', { type: 'status', version: 1, sessionId: 'g', message: 'Connected to Marionette gateway' });
    expect(p.document.querySelector('.mk-toast')).toBeNull();
    p.receive('status', { type: 'status', version: 1, sessionId: 'g', controlId: 'lift', message: 'Lift is busy' });
    expect(p.document.querySelector('.mk-toast')!.textContent).toBe('Lift is busy');
  });
});
