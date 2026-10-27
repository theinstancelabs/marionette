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

  it('streams a value from your own touch handling, and lets it go with the last value', () => {
    p = page(); p.connect(); p.receive('config', { ...phoneConfig(), controls: [{ id: 'grip', type: 'slider', label: 'Gripper', action: 'gripper.set', value: 0, min: 0, max: 1, step: 0.01 }] });
    const grip = p.K.drag({ action: 'gripper.set' });
    grip.update(0.25); frame(); grip.update(0.5); frame();
    expect(grip.isOpen()).toBe(true); expect(grip.state()).toBe('pending');
    p.window.dispatchEvent(new p.window.Event('blur'));
    expect(p.actions()).toEqual([{ controlId: 'grip', action: 'gripper.set', value: 0.25, live: true }, { controlId: 'grip', action: 'gripper.set', value: 0.5, live: true }, { controlId: 'grip', action: 'gripper.set', value: 0.5 }]);
    expect(grip.isOpen()).toBe(false); expect(grip.state()).toBe('idle');
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
    const group = p.K.group(); const btn = p.K.h('button'); p.K.hold(btn, { controlId: 'grip', group, letGoOnLeave: false }); p.K.letGoOnLeave(group);
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
