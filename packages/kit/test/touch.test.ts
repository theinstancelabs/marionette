import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, phoneConfig, type Page } from './page';

let p: Page;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { expect(p.errors).toEqual([]); p.close(); vi.useRealTimers(); });

const frame = () => vi.advanceTimersByTime(20);

describe('hold', () => {
  it('goes idle → pending → held → dropped as the gateway reports it, and needs a fresh press', () => {
    p = page({ body: '<button id="pad">Hold</button>' }); p.connect(); p.config();
    const pad = p.document.getElementById('pad')!; const states: string[] = [];
    const part = p.K.hold(pad, { action: 'teleop.deadman', onState: (state: string) => states.push(state) });
    expect(pad.dataset.state).toBe('idle'); expect(pad.getAttribute('aria-pressed')).toBe('false');
    p.pointer(pad, 'pointerdown');
    expect(p.actions()).toEqual([{ controlId: 'deadman', action: 'teleop.deadman', value: true }]);
    expect(pad.dataset.state).toBe('pending'); expect(pad.getAttribute('aria-pressed')).toBe('true');
    p.config({ deadman: { held: true } as never });
    expect(pad.dataset.state).toBe('held'); expect(part.state()).toBe('held');
    // The gateway let go (its repeats stopped) while the button is still pressed here: dropped, not pending again.
    p.config({ deadman: { held: false } as never });
    expect(pad.dataset.state).toBe('dropped');
    p.config({ deadman: { held: false } as never });
    expect(pad.dataset.state).toBe('dropped');
    p.pointer(pad, 'pointerup');
    expect(p.actions().at(-1)).toEqual({ controlId: 'deadman', action: 'teleop.deadman', value: false });
    expect(pad.dataset.state).toBe('idle');
    expect(states).toEqual(['idle', 'pending', 'held', 'dropped', 'idle']);
    expect(p.K.holdState('deadman')).toBe('idle');
  });

  it('reads as dropped while the gateway is away and after it comes back, until let go', () => {
    p = page({ body: '<button id="pad">Hold</button>' }); p.connect(); p.config();
    const pad = p.document.getElementById('pad')!; p.K.hold(pad, { controlId: 'deadman' });
    p.pointer(pad, 'pointerdown'); expect(pad.dataset.state).toBe('pending');
    p.connect('reconnecting'); expect(pad.dataset.state).toBe('dropped');
    p.connect('connected'); p.config(); expect(pad.dataset.state).toBe('dropped');
    p.pointer(pad, 'pointerup'); expect(pad.dataset.state).toBe('idle');
    p.pointer(pad, 'pointerdown'); expect(pad.dataset.state).toBe('pending');
  });

  it('releases the control it pressed even when the layout changes, and does nothing without a control', () => {
    p = page({ body: '<button id="pad">Hold</button><button id="none">None</button><button id="off" disabled>Off</button>' }); p.connect(); const c = p.config();
    p.K.hold(p.document.getElementById('none'), { action: 'not.declared' });
    p.K.hold(p.document.getElementById('off'), { controlId: 'grip' });
    p.pointer(p.document.getElementById('none')!, 'pointerdown'); p.pointer(p.document.getElementById('off')!, 'pointerdown');
    expect(p.actions()).toEqual([]);
    const pad = p.document.getElementById('pad')!; const part = p.K.hold(pad, { action: 'teleop.deadman' });
    p.pointer(pad, 'pointerdown');
    p.receive('config', { ...c, controls: c.controls.filter(x => x.id !== 'deadman') });
    part.dispose();
    expect(p.actions()).toEqual([{ controlId: 'deadman', action: 'teleop.deadman', value: true }, { controlId: 'deadman', action: 'teleop.deadman', value: false }]);
    p.pointer(pad, 'pointerdown');
    expect(p.actions()).toHaveLength(2);
  });
});

describe('live values', () => {
  it('streams a slider live, shows pending, live and dropped-until-let-go, and sends the final value', () => {
    p = page(); p.connect(); p.config();
    const out = p.document.createElement('span'); const part = p.K.slider(null, { controlId: 'sensitivity', out });
    p.document.body.append(part.el);
    expect(part.el.getAttribute('min')).toBe('0.1'); expect(part.el.value).toBe('1'); expect(out.textContent).toBe('1.0×');
    part.el.value = '2'; part.el.dispatchEvent(new p.window.Event('input')); frame();
    expect(p.actions()).toEqual([{ controlId: 'sensitivity', action: 'teleop.translationScale', value: 2, live: true }]);
    expect(out.textContent).toBe('2.0×'); expect(out.dataset.state).toBe('pending'); expect(part.el.dataset.state).toBe('pending');
    p.config({ sensitivity: { live: true, value: 2 } as never }); expect(out.dataset.state).toBe('live');
    // The gateway stopped hearing it mid-drag (samples stopped): red until the finger lifts, even if samples resume.
    p.config({ sensitivity: { live: false, value: 2 } as never }); expect(out.dataset.state).toBe('dropped');
    part.el.value = '2.5'; part.el.dispatchEvent(new p.window.Event('input')); frame();
    expect(out.dataset.state).toBe('dropped');
    part.el.dispatchEvent(new p.window.Event('change'));
    expect(p.actions().at(-1)).toEqual({ controlId: 'sensitivity', action: 'teleop.translationScale', value: 2.5 });
    expect(out.dataset.state).toBe('idle');
    // Not dragged and not focused: the slider follows the config.
    p.config({ sensitivity: { value: 3 } as never }); expect(part.el.value).toBe('3'); expect(out.textContent).toBe('3.0×');
  });

  it('streams a stick from where it is touched, at most 1 long, and springs back to rest', () => {
    p = page(); p.connect(); p.config(); const moves: unknown[] = [];
    const part = p.K.stick(null, { action: 'base.drive', edges: ['forward', 'back', 'left', 'right'], onMove: (v: unknown) => moves.push(v) });
    p.document.body.append(part.el);
    part.el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON() {} });
    expect(part.el.querySelectorAll('.mk-edge')).toHaveLength(4); expect(part.el.getAttribute('aria-roledescription')).toBe('stick');
    // Straight up the pad, 35% of its height from the centre: a full push forward.
    p.pointer(part.el, 'pointerdown', { clientX: 100, clientY: 30 }); frame();
    expect(p.actions()).toEqual([{ controlId: 'drive', action: 'base.drive', value: { x: 1, y: 0 }, live: true }]);
    expect(part.el.dataset.state).toBe('pending');
    // The far top-left corner: clamped to the circle, rounded toward zero.
    p.pointer(part.el, 'pointermove', { clientX: 0, clientY: 0 }); frame();
    const corner = p.actions().at(-1).value; expect(corner).toEqual({ x: 0.7, y: 0.7 }); expect(Math.hypot(corner.x, corner.y)).toBeLessThanOrEqual(1);
    p.config({ drive: { live: true } as never }); expect(part.el.dataset.state).toBe('live');
    p.config({ drive: { live: false } as never }); expect(part.el.dataset.state).toBe('dropped');
    p.pointer(part.el, 'pointermove', { clientX: 130, clientY: 100 }); frame();
    expect(part.el.dataset.state).toBe('dropped');
    p.pointer(part.el, 'pointerup');
    expect(p.actions().at(-1)).toEqual({ controlId: 'drive', action: 'base.drive', value: { x: 0, y: 0 } });
    expect(part.el.dataset.state).toBe('idle'); expect(moves.at(-1)).toEqual({ x: 0, y: 0 });
    expect(part.el.querySelector('.mk-knob').style.transform).toBe('');
  });

  it('streams a value from your own touch handling, lets it go with the last value, and ignores it until end()', () => {
    p = page(); p.connect(); p.receive('config', { ...phoneConfig(), controls: [{ id: 'grip', type: 'slider', label: 'Gripper', action: 'gripper.set', value: 0, min: 0, max: 1, step: 0.01 }] });
    let letGo = 0; const grip = p.K.drag({ action: 'gripper.set', onLetGo: () => letGo++ });
    grip.update(0.25); frame(); grip.update(0.25); grip.update(0.5); frame();
    expect(grip.isOpen()).toBe(true); expect(grip.state()).toBe('pending');
    p.window.dispatchEvent(new p.window.Event('blur'));
    const sent = [{ controlId: 'grip', action: 'gripper.set', value: 0.25, live: true }, { controlId: 'grip', action: 'gripper.set', value: 0.5, live: true }, { controlId: 'grip', action: 'gripper.set', value: 0.5 }];
    expect(p.actions()).toEqual(sent); expect(letGo).toBe(1);
    // The finger is still sliding: nothing goes out, and it reads as dropped, until the screen ends the gesture.
    expect(grip.isOpen()).toBe(false); expect(grip.state()).toBe('dropped'); expect(p.K.busy()).toBe(true);
    grip.update(0.75); frame(); p.window.dispatchEvent(new p.window.Event('blur'));
    expect(p.actions()).toEqual(sent); expect(letGo).toBe(1);
    grip.end(0.8); expect(p.actions()).toEqual(sent); expect(grip.state()).toBe('idle'); expect(p.K.busy()).toBe(false);
    // The next gesture streams again.
    grip.update(0.6); frame(); expect(p.actions().at(-1)).toEqual({ controlId: 'grip', action: 'gripper.set', value: 0.6, live: true });
    grip.end(); expect(p.actions().at(-1)).toEqual({ controlId: 'grip', action: 'gripper.set', value: 0.6 });
  });

  it('pushes the stick with the arrow keys', () => {
    p = page(); p.connect(); p.config();
    const part = p.K.stick(null, { action: 'base.drive' }); p.document.body.append(part.el);
    const key = (type: string, k: string) => part.el.dispatchEvent(new p.window.KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
    key('keydown', 'ArrowUp'); frame(); key('keydown', 'ArrowLeft'); frame();
    expect(p.actions().map(a => a.value)).toEqual([{ x: 1, y: 0 }, { x: 0.7, y: 0.7 }]);
    key('keyup', 'ArrowUp'); frame(); key('keyup', 'ArrowLeft');
    expect(p.actions().map(a => a.value)).toEqual([{ x: 1, y: 0 }, { x: 0.7, y: 0.7 }, { x: 0, y: 1 }, { x: 0, y: 0 }]);
    expect(p.actions().at(-1).live).toBeUndefined();
  });

  it('rounds stick values to two decimals toward zero and never longer than 1', () => {
    p = page(); const limit = p.K.stickLimit;
    expect(limit(0.123456, -0.98765)).toEqual({ x: 0.12, y: -0.98 });
    expect(limit(3, 4)).toEqual({ x: 0.6, y: 0.8 });
    expect(limit(-1, -1)).toEqual({ x: -0.7, y: -0.7 });
    expect(Object.is(limit(-0.004, 0).x, 0)).toBe(true);
    for (let i = 0; i < 2000; i++) {
      const x = (Math.random() - 0.5) * 6, y = (Math.random() - 0.5) * 6; const v = limit(x, y);
      expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(v.x)).toBeLessThanOrEqual(Math.abs(x) + 1e-9); expect(Math.abs(v.y)).toBeLessThanOrEqual(Math.abs(y) + 1e-9);
      expect(Math.round(v.x * 100)).toBeCloseTo(v.x * 100, 6); expect(Math.round(v.y * 100)).toBeCloseTo(v.y * 100, 6);
    }
  });
});

// A stick on the page, 200 px square at the top left.
function stickOn(options: Record<string, unknown> = {}) {
  const part = p.K.stick(null, { action: 'base.drive', ...options }); p.document.body.append(part.el);
  part.el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON() {} });
  return part;
}
const slide = (input: HTMLInputElement, value: number) => { input.value = String(value); input.dispatchEvent(new p.window.Event('input')); };
const knob = (part: any) => (part.el.querySelector('.mk-knob') as HTMLElement).style.transform;

describe('a cut touch stays cut until the operator lets go', () => {
  it('stops a stick when the gateway goes, and never sends from it again until the finger lifts', () => {
    p = page(); p.connect(); p.config(); const moves: unknown[] = [];
    const stick = stickOn({ onMove: (v: unknown) => moves.push(v) });
    p.pointer(stick.el, 'pointerdown', { clientX: 100, clientY: 65 }); frame();
    expect(p.actions()).toEqual([{ controlId: 'drive', action: 'base.drive', value: { x: 0.5, y: 0 }, live: true }]);
    p.config({ drive: { live: true } as never }); expect(stick.el.dataset.state).toBe('live');
    p.connect('reconnecting');
    expect(stick.el.dataset.state).toBe('dropped'); expect(moves.at(-1)).toEqual({ x: 0, y: 0 }); expect(knob(stick)).toBe('');
    // Back, and even a config that says it is live (a host that kept repeating it) doesn't bring it back.
    p.connect('connected'); p.config({ drive: { live: true } as never });
    expect(stick.el.dataset.state).toBe('dropped'); expect(p.K.liveState('drive')).toBe('dropped'); expect(p.K.busy()).toBe(true);
    p.pointer(stick.el, 'pointermove', { clientX: 100, clientY: 30 }); frame(); vi.advanceTimersByTime(1000);
    p.pointer(stick.el, 'pointermove', { clientX: 60, clientY: 40 }); frame();
    expect(p.actions()).toHaveLength(1); expect(knob(stick)).toBe('');
    // The host ended it already: the lift sends only the rest it waits for to end its cut (it passes nothing on).
    p.pointer(stick.el, 'pointerup'); expect(p.actions()).toEqual([{ controlId: 'drive', action: 'base.drive', value: { x: 0.5, y: 0 }, live: true }, { controlId: 'drive', action: 'base.drive', value: { x: 0, y: 0 } }]);
    p.config(); expect(stick.el.dataset.state).toBe('idle'); expect(p.K.busy()).toBe(false);
    p.pointer(stick.el, 'pointerdown', { clientX: 100, clientY: 30, pointerId: 2 }); frame();
    expect(p.actions().at(-1)).toEqual({ controlId: 'drive', action: 'base.drive', value: { x: 1, y: 0 }, live: true });
  });

  it('cuts a slider and a drag() too, and drops a sample still waiting for its frame', () => {
    p = page(); p.connect(); p.config();
    const scale = p.K.slider(null, { controlId: 'sensitivity' }); p.document.body.append(scale.el);
    let letGo = 0; const speed = p.K.drag({ controlId: 'speed-limit', onLetGo: () => letGo++ });
    p.pointer(scale.el, 'pointerdown', { pointerId: 3 }); slide(scale.el, 2); frame(); speed.update(60); frame();
    expect(p.actions()).toEqual([{ controlId: 'sensitivity', action: 'teleop.translationScale', value: 2, live: true }, { controlId: 'speed-limit', action: 'base.speedLimit', value: 60, live: true }]);
    // New values that haven't gone out yet when the gateway goes never go out.
    slide(scale.el, 2.5); speed.update(70); p.connect('reconnecting'); frame();
    expect(p.actions()).toHaveLength(2); expect(letGo).toBe(1);
    expect([scale.el.dataset.state, speed.state(), speed.isOpen()]).toEqual(['dropped', 'dropped', false]);
    p.connect('connected'); p.config({ sensitivity: { value: 2 } as never, 'speed-limit': { value: 60 } as never });
    slide(scale.el, 3); speed.update(80); frame(); vi.advanceTimersByTime(1000);
    expect(p.actions()).toHaveLength(2); expect([scale.el.dataset.state, speed.state()]).toEqual(['dropped', 'dropped']);
    // Letting go sends only the final values the host waits for: the last ones that went out, which the gateway ended
    // the drags at, not the thumb's. The slider shows the gateway's value again.
    p.pointer(scale.el, 'pointerup', { pointerId: 3 }); speed.end(90);
    expect(p.actions().slice(2)).toEqual([{ controlId: 'sensitivity', action: 'teleop.translationScale', value: 2 }, { controlId: 'speed-limit', action: 'base.speedLimit', value: 60 }]);
    expect(scale.el.value).toBe('2'); expect([scale.el.dataset.state, speed.state()]).toEqual(['idle', 'idle']);
    slide(scale.el, 1.5); speed.update(40); frame();
    expect(p.actions().slice(4)).toEqual([{ controlId: 'sensitivity', action: 'teleop.translationScale', value: 1.5, live: true }, { controlId: 'speed-limit', action: 'base.speedLimit', value: 40, live: true }]);
  });

  it('cuts what is touched when the page changes phone, and releases a hold quietly', () => {
    p = page({ body: '<button id="pad">Hold</button>' }); p.connect(); p.config();
    const pad = p.document.getElementById('pad')!; p.K.hold(pad, { action: 'teleop.deadman' }); const stick = stickOn();
    p.pointer(pad, 'pointerdown', { pointerId: 1 }); p.pointer(stick.el, 'pointerdown', { pointerId: 2, clientX: 100, clientY: 30 }); frame();
    p.config({ deadman: { held: true } as never, drive: { live: true } as never });
    expect([pad.dataset.state, stick.el.dataset.state]).toEqual(['held', 'live']); const sent = p.actions().length;
    // A mirror that moved on to another phone, whose own operator holds the deadman and drives.
    const phone2 = { id: 'phone-2', name: 'Phone 2', color: '#2f53b5', connected: true };
    p.config({ deadman: { held: true } as never, drive: { live: true } as never }, { phone: phone2 });
    expect([pad.dataset.state, stick.el.dataset.state]).toEqual(['dropped', 'dropped']);
    p.pointer(stick.el, 'pointermove', { pointerId: 2, clientX: 60, clientY: 60 }); frame();
    p.pointer(pad, 'pointerup', { pointerId: 1 }); p.pointer(stick.el, 'pointerup', { pointerId: 2 });
    // The hold's release would go to the new phone, so none goes; the stick sends only the rest its host waits for.
    expect(p.actions().slice(sent)).toEqual([{ controlId: 'drive', action: 'base.drive', value: { x: 0, y: 0 } }]); expect([pad.dataset.state, stick.el.dataset.state]).toEqual(['idle', 'idle']);
  });

  it('cuts what is touched when the page gets a phone after having none', () => {
    p = page(); p.connect(); p.config({}, { phone: undefined, phones: [] }); const stick = stickOn();
    p.pointer(stick.el, 'pointerdown', { clientX: 100, clientY: 30 }); frame(); const sent = p.actions().length; expect(sent).toBe(1);
    p.config(); expect(stick.el.dataset.state).toBe('dropped');
    p.pointer(stick.el, 'pointermove', { clientX: 60, clientY: 60 }); frame(); expect(p.actions()).toHaveLength(sent);
    p.pointer(stick.el, 'pointerup'); expect(p.actions().slice(sent)).toEqual([{ controlId: 'drive', action: 'base.drive', value: { x: 0, y: 0 } }]);
  });

  it('never turns a press made while the gateway is away into a hold or a drag', () => {
    p = page({ body: '<button id="pad">Hold</button>' }); p.connect(); p.config();
    const pad = p.document.getElementById('pad')!; const changes: boolean[] = []; p.K.hold(pad, { action: 'teleop.deadman', onChange: (on: boolean) => changes.push(on) }); const stick = stickOn();
    let letGo = 0; const speed = p.K.drag({ controlId: 'speed-limit', onLetGo: () => letGo++ });
    p.connect('reconnecting');
    p.pointer(pad, 'pointerdown', { pointerId: 1 }); p.pointer(stick.el, 'pointerdown', { pointerId: 2, clientX: 100, clientY: 30 }); speed.update(70); frame();
    expect(p.actions()).toEqual([]); expect([pad.dataset.state, stick.el.dataset.state, speed.state()]).toEqual(['dropped', 'dropped', 'dropped']);
    expect(changes).toEqual([true]); expect(letGo).toBe(1); expect(knob(stick)).toBe(''); expect(stick.el.classList.contains('mk-dragging')).toBe(false);
    // Back: still dropped, even if a host delivered the press and the gateway reports it held.
    p.connect('connected'); p.config({ deadman: { held: true } as never });
    p.pointer(stick.el, 'pointermove', { pointerId: 2, clientX: 100, clientY: 40 }); speed.update(75); frame();
    expect(p.actions()).toEqual([]); expect([pad.dataset.state, stick.el.dataset.state, speed.state()]).toEqual(['dropped', 'dropped', 'dropped']);
    p.pointer(pad, 'pointerup', { pointerId: 1 }); p.pointer(stick.el, 'pointerup', { pointerId: 2 }); speed.end();
    expect(p.actions()).toEqual([]); expect(changes).toEqual([true, false]); expect(letGo).toBe(1);
    p.config(); p.pointer(pad, 'pointerdown', { pointerId: 1 });
    expect(p.actions()).toEqual([{ controlId: 'deadman', action: 'teleop.deadman', value: true }]); expect(pad.dataset.state).toBe('pending');
  });
});

// What the app (apps/mobile/App.tsx: `dropped`, `onHtmlMessage`) and the desktop mirror (apps/backend/src/preview.ts)
// do with a page's drags: when the gateway goes, every drag a live sample went out for is cut; while cut, a control's
// samples are dropped, and a final value (no `live`) ends the cut and is swallowed. A sample while the gateway is away
// cuts its control too.
function cuttingHost() {
  const cut = new Set<string>(); const dragging = new Set<string>(); const gateway: any[] = []; let linked = true; let seen = 0;
  const pump = () => {
    for (const m of p.posted.slice(seen)) {
      seen++; if (m.type !== 'action') continue;
      if (m.live) { if (cut.has(m.controlId)) continue; if (!linked) { cut.add(m.controlId); continue; } dragging.add(m.controlId); gateway.push(m); continue; }
      if (cut.delete(m.controlId)) continue;
      dragging.delete(m.controlId); if (linked) gateway.push(m);
    }
  };
  return {
    gateway, cut, pump,
    drop() { pump(); for (const id of dragging) cut.add(id); dragging.clear(); linked = false; p.connect('reconnecting'); },
    back(patch: Record<string, unknown> = {}) { linked = true; p.connect('connected'); p.config(patch as never); },
  };
}

describe('a cut drag tells its host when the finger lifts', () => {
  it('so the first drag after the gateway comes back reaches it, for a stick, a slider and a drag()', () => {
    p = page(); p.connect(); p.config(); const host = cuttingHost(); const stick = stickOn();
    const out = p.document.createElement('span'); const scale = p.K.slider(null, { controlId: 'speed-limit', out }); p.document.body.append(scale.el);
    const grip = p.K.drag({ controlId: 'sensitivity' });
    p.pointer(stick.el, 'pointerdown', { clientX: 100, clientY: 30 }); p.pointer(scale.el, 'pointerdown', { pointerId: 2 }); slide(scale.el, 70); grip.update(2); frame(); host.pump();
    expect(host.gateway.map(m => m.controlId)).toEqual(['drive', 'speed-limit', 'sensitivity']);
    host.drop();
    p.pointer(stick.el, 'pointermove', { clientX: 100, clientY: 60 }); slide(scale.el, 90); grip.update(3); frame(); host.pump();
    host.back();
    // The fingers lift after the gateway is back: the host swallows what they send and lets the controls go.
    p.pointer(stick.el, 'pointerup'); p.pointer(scale.el, 'pointerup', { pointerId: 2 }); grip.end(); host.pump();
    expect(host.cut.size).toBe(0); expect(host.gateway).toHaveLength(3); expect(scale.el.value).toBe('50'); expect(out.textContent).toBe('50%');
    // The next drags go out, and what the slider shows is what the gateway got.
    p.pointer(stick.el, 'pointerdown', { clientX: 30, clientY: 100, pointerId: 3 }); frame(); p.pointer(stick.el, 'pointerup', { pointerId: 3 });
    p.pointer(scale.el, 'pointerdown', { pointerId: 4 }); slide(scale.el, 20); frame(); slide(scale.el, 10); p.pointer(scale.el, 'pointerup', { pointerId: 4 });
    grip.update(1.5); frame(); grip.end(); host.pump();
    expect(host.gateway.slice(3).map(({ controlId, value, live }) => [controlId, value, !!live])).toEqual([
      ['drive', { x: 0, y: 1 }, true], ['drive', { x: 0, y: 0 }, false],
      ['speed-limit', 20, true], ['speed-limit', 10, false],
      ['sensitivity', 1.5, true], ['sensitivity', 1.5, false],
    ]);
    expect(scale.el.value).toBe('10'); expect(out.textContent).toBe('10%');
  });

  it('also when the finger lifts while the gateway is still away, and the slider then shows where the gateway ended it', () => {
    p = page(); p.connect(); p.config(); const host = cuttingHost();
    const out = p.document.createElement('span'); const scale = p.K.slider(null, { controlId: 'sensitivity', out }); p.document.body.append(scale.el); scale.el.focus();
    p.pointer(scale.el, 'pointerdown'); slide(scale.el, 1.5); frame(); p.config({ sensitivity: { live: true, value: 1.5 } as never }); slide(scale.el, 2); frame(); host.pump();
    host.drop(); slide(scale.el, 2.5); frame(); p.pointer(scale.el, 'pointerup'); scale.el.dispatchEvent(new p.window.Event('change')); host.pump();
    // Let go while away: back to what the page last heard (1.5). The gateway ended the drag at 2, which the page hears
    // once it is back, and the slider follows that although it still has focus.
    expect(scale.el.value).toBe('1.5'); expect(p.document.activeElement).toBe(scale.el);
    host.back({ sensitivity: { value: 2 } }); expect(scale.el.value).toBe('2'); expect(out.textContent).toBe('2.0×');
    const before = host.gateway.length;
    p.pointer(scale.el, 'pointerdown'); slide(scale.el, 1); frame(); slide(scale.el, 0.5); p.pointer(scale.el, 'pointerup'); scale.el.dispatchEvent(new p.window.Event('change')); host.pump();
    expect(host.gateway.slice(before).map(m => m.value)).toEqual([1, 0.5]); expect(scale.el.value).toBe('0.5');
    // Touched again and still focused: a config from elsewhere doesn't move it under the operator.
    p.config({ sensitivity: { value: 3 } as never }); expect(scale.el.value).toBe('0.5');
  });

  it('but owes nothing when no sample had gone out, or the kit already sent the final value', () => {
    p = page(); p.connect(); p.config(); p.K.stop(); const host = cuttingHost(); const stick = stickOn();
    // A push still waiting for its frame when the gateway goes: nothing went out, so nothing is owed.
    p.pointer(stick.el, 'pointerdown', { clientX: 100, clientY: 30 }); host.drop(); frame(); p.pointer(stick.el, 'pointerup'); host.pump();
    expect(p.actions()).toEqual([]); host.back();
    // Stop turned on mid-drag: the kit sent the final value then, so the gateway going later adds nothing at the lift.
    p.pointer(stick.el, 'pointerdown', { clientX: 100, clientY: 30, pointerId: 2 }); frame(); p.config({ estop: { value: true } as never }); host.drop();
    p.pointer(stick.el, 'pointerup', { pointerId: 2 }); host.pump();
    expect(p.actions()).toEqual([{ controlId: 'drive', action: 'base.drive', value: { x: 1, y: 0 }, live: true }, { controlId: 'drive', action: 'base.drive', value: { x: 0, y: 0 } }]);
    expect(host.cut.size).toBe(0);
  });
});

describe('after the kit lets go, a drag stays let go until the finger lifts', () => {
  it('ends a slider when Stop turns on, and ignores the rest of that drag', () => {
    p = page(); p.connect(); p.config(); p.K.stop();
    const out = p.document.createElement('span'); const scale = p.K.slider(null, { controlId: 'sensitivity', out }); p.document.body.append(scale.el);
    p.pointer(scale.el, 'pointerdown', { pointerId: 4 }); slide(scale.el, 2); frame();
    p.config({ sensitivity: { live: true, value: 2 } as never });
    // Stop turns on (another finger, or the mirror): the value so far is final.
    p.config({ estop: { value: true } as never, sensitivity: { live: false, value: 2 } as never });
    expect(p.actions()).toEqual([{ controlId: 'sensitivity', action: 'teleop.translationScale', value: 2, live: true }, { controlId: 'sensitivity', action: 'teleop.translationScale', value: 2 }]);
    expect(scale.el.dataset.state).toBe('dropped'); expect(out.dataset.state).toBe('dropped');
    slide(scale.el, 2.5); frame(); slide(scale.el, 3); frame();
    expect(p.actions()).toHaveLength(2); expect(out.textContent).toBe('2.0×');
    scale.el.dispatchEvent(new p.window.Event('change')); p.pointer(scale.el, 'pointerup', { pointerId: 4 });
    expect(p.actions()).toHaveLength(2); expect(scale.el.dataset.state).toBe('idle'); expect(scale.el.value).toBe('2');
    slide(scale.el, 1.5); frame(); expect(p.actions().at(-1)).toEqual({ controlId: 'sensitivity', action: 'teleop.translationScale', value: 1.5, live: true });
  });

  it('springs a stick back when a sheet opens, and ignores the finger until it lifts', () => {
    p = page(); p.connect(); p.config(); const stick = stickOn();
    p.pointer(stick.el, 'pointerdown', { clientX: 100, clientY: 30 }); frame();
    p.K.sheet().show([p.K.h('p', {}, 'More')]);
    expect(p.actions()).toEqual([{ controlId: 'drive', action: 'base.drive', value: { x: 1, y: 0 }, live: true }, { controlId: 'drive', action: 'base.drive', value: { x: 0, y: 0 } }]);
    expect(stick.el.dataset.state).toBe('dropped'); expect(knob(stick)).toBe('');
    // A second finger can't take it over either.
    p.pointer(stick.el, 'pointermove', { clientX: 100, clientY: 50 }); p.pointer(stick.el, 'pointerdown', { pointerId: 2, clientX: 100, clientY: 50 }); frame();
    expect(p.actions()).toHaveLength(2);
    p.pointer(stick.el, 'pointerup'); expect(p.actions()).toHaveLength(2); expect(stick.el.dataset.state).toBe('idle');
  });
});

describe('a part whose element leaves the page without dispose()', () => {
  it('releases a hold when its button is replaced mid-press', () => {
    p = page({ body: '<div id="dock"><button id="pad">Hold</button></div>' }); p.connect(); p.config();
    const dock = p.document.getElementById('dock')!; const pad = p.document.getElementById('pad')!; p.K.hold(pad, { action: 'teleop.deadman' });
    p.pointer(pad, 'pointerdown'); p.config({ deadman: { held: true } as never });
    // The screen re-renders its dock with new nodes: the next render notices the button is gone.
    dock.replaceChildren(pad.cloneNode(true)); expect(p.K.busy()).toBe(true);
    p.config({ deadman: { held: true } as never });
    expect(p.actions().at(-1)).toEqual({ controlId: 'deadman', action: 'teleop.deadman', value: false }); expect(p.K.busy()).toBe(false);
    // Or the finger lifts first, wherever the browser sends its pointerup.
    const fresh = p.document.getElementById('pad')!; p.K.hold(fresh, { action: 'teleop.deadman' }); p.pointer(fresh, 'pointerdown', { pointerId: 7 });
    dock.replaceChildren(); p.pointer(p.document.body, 'pointerup', { pointerId: 8 }); expect(p.K.busy()).toBe(true);
    p.pointer(p.document.body, 'pointerup', { pointerId: 7 });
    expect(p.actions().filter(a => a.value === false)).toHaveLength(2); expect(p.K.busy()).toBe(false);
  });

  it('lets go as soon as a screen re-renders a touched part away, with no event from the finger', async () => {
    p = page({ body: '<div id="dock"><button id="pad">Hold</button></div><div id="rows"></div>' }); p.connect(); p.config();
    const dock = p.document.getElementById('dock')!; const rows = p.document.getElementById('rows')!;
    p.K.hold(p.document.getElementById('pad')!, { action: 'teleop.deadman' }); const scale = p.K.slider(null, { controlId: 'sensitivity' }); rows.append(scale.el);
    p.pointer(p.document.getElementById('pad')!, 'pointerdown', { pointerId: 1 }); p.pointer(scale.el, 'pointerdown', { pointerId: 2 }); slide(scale.el, 2); frame();
    // Moving a pressed button within the page (a keyed re-order) keeps it pressed.
    dock.replaceChildren(...dock.children); await Promise.resolve(); expect(p.K.holdState('deadman')).toBe('pending');
    dock.replaceChildren(p.K.h('button', {}, 'Hold')); rows.replaceChildren(); await Promise.resolve();
    expect(p.actions().slice(-2)).toEqual([{ controlId: 'deadman', action: 'teleop.deadman', value: false }, { controlId: 'sensitivity', action: 'teleop.translationScale', value: 2 }]);
    expect(p.K.busy()).toBe(false);
  });

  it('releases a hold whose pointer capture is lost to the document', () => {
    p = page({ body: '<button id="pad">Hold</button>' }); p.connect(); p.config();
    const pad = p.document.getElementById('pad')!; p.K.hold(pad, { action: 'teleop.deadman' }); p.pointer(pad, 'pointerdown', { pointerId: 5 });
    pad.remove(); p.pointer(p.document as never, 'lostpointercapture', { pointerId: 5 });
    expect(p.actions().at(-1)).toEqual({ controlId: 'deadman', action: 'teleop.deadman', value: false });
  });

  it('lets a stick go when it is replaced mid-drag', () => {
    p = page(); p.connect(); p.config(); const stick = stickOn();
    p.pointer(stick.el, 'pointerdown', { clientX: 100, clientY: 30, pointerId: 6 }); frame();
    stick.el.replaceWith(stick.el.cloneNode(true));
    p.pointer(p.document.body, 'pointerup', { pointerId: 6 });
    expect(p.actions().at(-1)).toEqual({ controlId: 'drive', action: 'base.drive', value: { x: 0, y: 0 } }); expect(p.K.busy()).toBe(false);
    // Or at the next render, if the finger is still down.
    const again = stickOn(); p.pointer(again.el, 'pointerdown', { clientX: 100, clientY: 30, pointerId: 9 }); frame();
    again.el.remove(); p.config();
    expect(p.actions().at(-1)).toEqual({ controlId: 'drive', action: 'base.drive', value: { x: 0, y: 0 } }); expect(p.K.busy()).toBe(false);
  });
});

describe('letGoOnLeave', () => {
  function pressed() {
    p = page({ body: '<button id="pad">Hold</button><button id="grip">Grip</button>' }); p.connect(); p.config();
    const pad = p.document.getElementById('pad')!; p.K.hold(pad, { action: 'teleop.deadman' }); p.pointer(pad, 'pointerdown');
    return pad;
  }
  const releases = () => p.actions().filter(a => a.value === false);

  it('lets go when the page loses focus or is hidden', () => {
    const pad = pressed(); p.window.dispatchEvent(new p.window.Event('blur'));
    expect(releases()).toEqual([{ controlId: 'deadman', action: 'teleop.deadman', value: false }]); expect(pad.dataset.state).toBe('idle');
    p.pointer(pad, 'pointerdown');
    Object.defineProperty(p.document, 'hidden', { value: true, configurable: true }); p.document.dispatchEvent(new p.window.Event('visibilitychange'));
    expect(releases()).toHaveLength(2);
  });

  it('lets go when a sheet opens or Stop turns on, and only for parts that let go on leave', () => {
    pressed();
    const kept = p.K.hold(p.document.getElementById('grip'), { controlId: 'grip', letGoOnLeave: false }); p.pointer(kept.el, 'pointerdown');
    p.K.sheet().show([p.K.h('p', {}, 'More')]);
    expect(releases().map(a => a.controlId)).toEqual(['deadman']);
    const pad = p.document.getElementById('pad')!; p.pointer(pad, 'pointerdown');
    p.K.stop(); p.config({ estop: { value: true } as never });
    expect(releases().map(a => a.controlId)).toEqual(['deadman', 'deadman']);
    kept.dispose(); expect(releases().map(a => a.controlId)).toEqual(['deadman', 'deadman', 'grip']);
  });

  it('lets your own touch handling and groups go too', () => {
    p = page(); p.connect(); p.config();
    const calls: boolean[] = []; const off = p.K.letGoOnLeave((quiet: boolean) => calls.push(quiet));
    const group = p.K.group(); const btn = p.document.body.appendChild(p.K.h('button')); p.K.hold(btn, { controlId: 'grip', group, letGoOnLeave: false }); p.K.letGoOnLeave(group);
    p.pointer(btn, 'pointerdown');
    p.window.dispatchEvent(new p.window.Event('blur'));
    expect(calls).toEqual([false]); expect(p.actions().at(-1)).toEqual({ controlId: 'grip', action: 'gripper.hold', value: false });
    p.K.letGo(true); expect(calls).toEqual([false, true]);
    off(); p.window.dispatchEvent(new p.window.Event('blur')); expect(calls).toEqual([false, true]);
    p.pointer(btn, 'pointerdown'); group.dispose();
    expect(p.actions().filter(a => a.value === false)).toHaveLength(2);
  });
});

describe('stop, strip and toast', () => {
  it('turns Stop on with a press, shows the banner, and resets it', () => {
    p = page({ body: '<div id="banner"></div>' }); p.connect(); p.config();
    const stop = p.K.stop({ banner: p.document.getElementById('banner') });
    expect(stop.button.hidden).toBe(false); expect(stop.banner.hidden).toBe(true);
    expect(stop.banner.textContent).toBe('Stop is onIt stays on for this phone until you reset it.Reset');
    p.pointer(stop.button, 'pointerdown');
    expect(p.actions()).toEqual([{ controlId: 'estop', action: 'safety.estop', value: true }]);
    p.config({ estop: { value: true } as never });
    expect(stop.isOn()).toBe(true); expect(stop.banner.hidden).toBe(false); expect(stop.button.getAttribute('aria-pressed')).toBe('true');
    p.pointer(stop.button, 'pointerdown'); expect(p.actions()).toHaveLength(1);
    (stop.banner.querySelector('[data-stop-reset]') as HTMLButtonElement).click();
    expect(p.actions().at(-1)).toEqual({ controlId: 'estop', action: 'safety.estop', value: false });
    const c = p.config(); p.receive('config', { ...c, controls: c.controls.filter(x => x.id !== 'estop') }); expect(stop.button.hidden).toBe(true);
  });

  it('tells onChange once when Stop turns on while something is pressed', () => {
    p = page({ body: '<button id="pad">Hold</button>' }); p.connect(); p.config();
    const pad = p.document.getElementById('pad')!; p.K.hold(pad, { action: 'teleop.deadman' });
    const changes: boolean[] = []; p.K.stop({ onChange: (on: boolean) => changes.push(on) });
    p.pointer(pad, 'pointerdown'); p.config({ estop: { value: true } as never });
    expect(changes).toEqual([false, true]); expect(p.actions().at(-1)).toEqual({ controlId: 'deadman', action: 'teleop.deadman', value: false });
    p.config({ estop: { value: false } as never }); expect(changes).toEqual([false, true, false]);
  });

  it('keeps a screen’s own Stop button, and a sheet anywhere on the page, out of what a sheet covers', () => {
    p = page({ body: '<main id="app"><header id="top"><span id="title">Rover</span><button id="stop">Stop</button></header><section id="body"><button id="pad">Hold</button></section><section id="panel" hidden></section></main><footer id="foot"></footer><p id="off" inert></p>' });
    p.connect(); p.config();
    const $ = (id: string) => p.document.getElementById(id)!; const inert = () => ['app', 'top', 'title', 'stop', 'body', 'panel', 'foot', 'off'].filter(id => $(id).hasAttribute('inert'));
    const stop = p.K.stop({ button: $('stop') as HTMLButtonElement }); const more = p.K.sheet({ el: $('panel') });
    more.show([p.K.h('button', { id: 'close' }, 'Close')]);
    // Stop and the open sheet stay; everything around them along the way is covered.
    expect(inert()).toEqual(['title', 'body', 'foot', 'off']);
    p.pointer($('stop'), 'pointerdown'); expect(p.actions().at(-1)).toEqual({ controlId: 'estop', action: 'safety.estop', value: true });
    more.hide(); expect(inert()).toEqual(['off']);
    // The calibration sheet too, with the kit's own sheet element at the end of the body.
    const calibration = p.K.calibration(); calibration.open();
    expect(inert()).toEqual(['title', 'body', 'foot', 'off']); expect((p.document.querySelector('body > .mk-sheet') as HTMLElement).hasAttribute('inert')).toBe(false);
    calibration.close(); expect(inert()).toEqual(['off']);
    // Elements the screen names are covered the same way.
    const named = p.K.sheet({ covers: [$('app')] }); named.show([]); expect(inert()).toEqual(['title', 'body', 'off']); named.hide();
    stop.dispose(); more.show([]); expect(inert()).toEqual(['top', 'body', 'foot', 'off']);
  });

  it('shows the phone, tracking, link and connection in the strip', () => {
    p = page({ body: '<header id="strip"></header>' });
    const strip = p.K.strip(p.document.getElementById('strip'));
    expect(strip.me.textContent).toBe('Connecting…'); expect(strip.tracking.textContent).toBe('Starting tracking');
    p.connect(); p.config();
    expect(strip.me.textContent).toBe('Phone 1'); expect((strip.me.querySelector('.mk-dot') as HTMLElement).style.background).toBe('rgb(201, 130, 0)');
    expect(strip.rule.hidden).toBe(false);
    p.receive('tracking', { state: 'limited', source: 'arkit', reason: 'excessiveMotion' }); expect(strip.tracking.textContent).toBe('Tracking limited');
    p.receive('tracking', { state: 'normal', source: 'synthetic' }); expect(strip.tracking.textContent).toBe('Simulated motion');
    expect(strip.link.hidden).toBe(true);
    p.receive('link', { rttMs: 120.4, quality: 'fair' }); expect(strip.link.hidden).toBe(false); expect(strip.link.textContent).toBe('Link slow · 120 ms'); expect(strip.link.dataset.quality).toBe('fair');
    p.connect('reconnecting'); expect(strip.me.textContent).toBe('Phone 1 · reconnecting'); expect(strip.me.classList.contains('mk-off')).toBe(true); expect(strip.link.hidden).toBe(true);
    p.connect('connected'); p.config({}, { phone: { id: 'phone-1', name: 'Phone 1', color: '#c98200', connected: false } });
    expect(strip.me.textContent).toBe('Phone 1 · offline'); expect(strip.tracking.textContent).toBe('No pose');
  });

  it('shows a toast for a while', () => {
    p = page(); const node = p.K.toast('Saved');
    expect(node.hidden).toBe(false); expect(node.textContent).toBe('Saved');
    vi.advanceTimersByTime(2700); expect(node.hidden).toBe(true);
    expect(p.K.toast('')).toBeUndefined();
  });
});

describe('controlRow', () => {
  it('draws switches, choices, sliders, sticks and buttons, and follows the config in place', () => {
    p = page({ body: '<div id="rows"></div>' }); p.connect(); const c = p.config();
    const rows = p.document.getElementById('rows')!; const group = p.K.group();
    const by = (id: string) => c.controls.find(x => x.id === id)!;
    for (const id of ['lift', 'arm', 'sensitivity', 'drive', 'grip', 'calibration-start']) rows.append(p.K.controlRow(by(id), { group }));
    const sw = rows.querySelector('.mk-switch') as HTMLButtonElement; expect(sw.getAttribute('aria-checked')).toBe('true');
    sw.click(); expect(p.actions().at(-1)).toEqual({ controlId: 'lift', action: 'lift.toggle', value: false });
    const seg = rows.querySelectorAll('.mk-seg button'); expect([...seg].map(b => b.textContent)).toEqual(['Left arm', 'Right arm']);
    (seg[1] as HTMLButtonElement).click(); expect(p.actions().at(-1)).toEqual({ controlId: 'arm', action: 'arm.select', value: 'right' });
    p.config({ lift: { value: false } as never, arm: { value: 'right' } as never });
    expect(sw.getAttribute('aria-checked')).toBe('false'); expect(seg[1].getAttribute('aria-pressed')).toBe('true');
    expect(rows.querySelector('.mk-range')).not.toBeNull(); expect(rows.querySelector('.mk-stick')).not.toBeNull();
    const buttons = [...rows.querySelectorAll('.mk-btn')]; expect(buttons.map(b => b.textContent)).toEqual(['Grip (hold)', 'Start guided calibration']);
    p.pointer(buttons[0], 'pointerdown'); expect(buttons[0].getAttribute('data-state')).toBe('pending');
    (buttons[1] as HTMLButtonElement).click(); expect(p.actions().at(-1)).toEqual({ controlId: 'calibration-start', action: 'calibration.start' });
    group.dispose(); expect(p.actions().at(-1)).toEqual({ controlId: 'grip', action: 'gripper.hold', value: false });
    // A bare segmented picker, with options the robot can't do turned off (never the selected one).
    let have = ['head'];
    const views = p.K.segments(null, { action: 'camera.view', disabled: (value: string) => !have.includes(value) });
    expect([...views.el.children].map((b: any) => [b.textContent, b.getAttribute('aria-pressed'), b.disabled])).toEqual([['Head cam', 'true', false], ['Arm cams', 'false', true]]);
    have = ['head', 'arms']; views.render(); expect(views.el.children[1].disabled).toBe(false);
    views.el.children[1].click(); expect(p.actions().at(-1)).toEqual({ controlId: 'cameras', action: 'camera.view', value: 'arms' });
    const picker = p.K.controlRow({ id: 'mode', type: 'select', label: 'Mode', action: 'mode.set', value: 'b', options: ['a', 'b', 'c', 'd'].map(v => ({ label: v.toUpperCase(), value: v })) });
    expect(picker.querySelector('select').value).toBe('b');
  });
});
