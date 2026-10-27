import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalibrationState } from '@marionette/protocol';
import { page, type Page } from './page';

let p: Page;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { expect(p.errors).toEqual([]); p.close(); vi.useRealTimers(); });

const pose = (x = 0, y = 0, z = 0) => ({ type: 'pose', version: 1, sessionId: 's', seq: 1, monotonicTs: 1, position: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, covariance: [0, 0, 0, 0, 0, 0], source: 'arkit', trackingState: 'normal', calibrationVersion: 'arkit-v1', heartbeat: true });
const reference = (epoch: number, mode = 'guided') => ({ mode, sessionId: 's', epoch, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, frame: { x: 0, y: 0, z: 0, w: 1 } });
const result = (move: string, passed: boolean, dominant: string) => ({ move, expected: { forward: '+X', right: '-Y', up: '+Z' }[move], dominant, displacement: { x: 0.1, y: 0, z: 0 }, passed });

function setup() {
  p = page({ body: '<main id="app"><button id="pad">Hold</button></main>' }); p.connect(); p.receive('tracking', { state: 'normal', source: 'arkit' });
  const calibrate = (calibration: Partial<CalibrationState>) => p.config({}, { calibration: { status: 'uncalibrated', epoch: 0, ...calibration } as CalibrationState });
  calibrate({});
  return { cal: p.K.calibration(), calibrate };
}
const sheet = () => p.document.querySelector('.mk-sheet') as HTMLElement;
const text = (selector: string) => (sheet().querySelector(selector)?.textContent ?? '');
const buttons = () => [...sheet().querySelectorAll('button')].map(b => b.textContent);
const track = () => [...sheet().querySelectorAll('.mk-track span')].map(s => `${s.className}:${s.textContent}`);
const frame = () => vi.advanceTimersByTime(20);

describe('calibration', () => {
  it('opens on the intro, starts guided calibration, and follows the steps the gateway reports', () => {
    const { cal, calibrate } = setup();
    expect(sheet().hidden).toBe(true); expect(cal.summary()).toEqual(['Not calibrated', '']);
    cal.open();
    expect(sheet().hidden).toBe(false); expect(p.document.getElementById('app')!.hasAttribute('inert')).toBe(true);
    expect(text('.mk-title')).toBe('Teach it which way is forward'); expect(text('.mk-frame-status')).toBe('Now usingthe phone’s start position');
    expect(buttons()).toEqual(['Close', 'Start calibration', 'Set origin here']);
    (sheet().querySelector('.mk-cta') as HTMLButtonElement).click();
    expect(p.actions()).toEqual([{ controlId: 'calibration-start', action: 'calibration.start' }]);

    calibrate({ status: 'capturing', step: 'flat' }); p.receive('pose', pose()); frame();
    expect(text('.mk-sheet-top b')).toBe('Calibrate1 of 4'); expect(text('.mk-title')).toBe('Hold it flat');
    expect(track()).toEqual(['mk-cur:Flat', ':Forward', ':Right', ':Up']);
    expect(text('.mk-meter-top')).toBe('Tilt0°'); expect(text('.mk-meter .mk-note')).toBe('flat enough, capture when ready');
    const cta = () => sheet().querySelector('.mk-sheet-foot .mk-cta') as HTMLButtonElement;
    expect(cta().textContent).toBe('Capture flat'); expect(cta().disabled).toBe(false);
    p.receive('tracking', { state: 'unavailable', source: 'arkit' }); expect(cta().disabled).toBe(true); expect(text('.mk-meter .mk-note')).toBe('waiting for tracking');
    p.receive('tracking', { state: 'normal', source: 'arkit' });
    cta().click(); expect(p.actions().at(-1)).toEqual({ controlId: 'calibration', action: 'calibration.capture', value: 'flat' });

    calibrate({ status: 'capturing', step: 'forward', anchor: { x: 0, y: 0, z: 0 } }); p.receive('pose', pose(0.012, 0, 0)); frame();
    expect(text('.mk-sheet-top b')).toBe('Calibrate2 of 4'); expect(text('.mk-title')).toBe('Move it forward');
    expect(track()).toEqual(['mk-done:Flat', 'mk-cur:Forward', ':Right', ':Up']);
    expect(text('.mk-meter-top')).toBe('Moved12 mm of 100'); expect(text('.mk-meter .mk-note')).toBe('30 mm is enough to capture');
    p.receive('pose', pose(0.05, 0, 0)); frame();
    expect(text('.mk-meter-top')).toBe('Moved50 mm of 100'); expect(sheet().querySelector('.mk-meter')!.classList.contains('mk-ready')).toBe(true);
    // A refused capture says why, in the sheet.
    p.receive('status', { type: 'status', version: 1, sessionId: 'g', controlId: 'calibration', message: 'Move at least 30 mm', values: { accepted: false } });
    expect(sheet().querySelector('.mk-reply.mk-bad')!.textContent).toBe('Move at least 30 mm');

    // Up captured: the new frame is live, and the sheet says so.
    calibrate({ status: 'capturing', step: 'up', anchor: { x: 0, y: 0, z: 0 } });
    calibrate({ status: 'captured', epoch: 1, reference: reference(1) as never });
    expect(text('.mk-title')).toBe('Calibrated'); expect(buttons()).toEqual(['Close', 'Done', 'Validate (optional)']);
    expect(cal.summary()).toEqual(['Guided', '']);
    (sheet().querySelectorAll('.mk-cta')[0] as HTMLButtonElement).click(); expect(sheet().hidden).toBe(true);
    expect(p.document.getElementById('app')!.hasAttribute('inert')).toBe(false);
  });

  it('walks validation and shows what failed', () => {
    const { cal, calibrate } = setup();
    calibrate({ status: 'captured', epoch: 1, reference: reference(1) as never, check: { step: 'right', results: [result('forward', true, '+X')] as never } });
    expect(text('.mk-sheet-top b')).toBe('Validate2 of 3'); expect(text('.mk-title')).toBe('Move it right');
    expect(track()).toEqual(['mk-pass:Forward ✓', 'mk-cur:Right', ':Up']);
    p.receive('pose', pose(0, -0.08, 0)); frame();
    expect(text('.mk-axes')).toBe('forward0left−80up0'); expect(text('.mk-sheet-body .mk-note')).toBe('moving right, 80 mm');
    expect(sheet().querySelector('.mk-axis.mk-lead')!.textContent).toBe('left−80');
    (sheet().querySelector('.mk-sheet-foot .mk-cta') as HTMLButtonElement).click();
    expect(p.actions().at(-1)).toEqual({ controlId: 'calibration-check', action: 'calibration.check', value: 'right' });
    calibrate({ status: 'captured', epoch: 1, reference: reference(1) as never, check: { results: [result('forward', true, '+X'), result('right', true, '-Y'), result('up', false, '+Y')] as never, passed: false } });
    expect(text('.mk-title')).toBe('That didn’t line up'); expect(text('.mk-body')).toBe('Up went left. Calibrate again and keep each move straight.');
    expect([...sheet().querySelectorAll('.mk-results li')].map(li => li.textContent)).toEqual(['Forwardforward (+X), 100 mm ✓', 'Rightright (−Y), 100 mm ✓', 'Upleft (+Y), 100 mm ✗']);
    expect(buttons()).toEqual(['Close', 'Calibrate again', 'Not now']);
    expect(cal.summary()).toEqual(['Guided, validation failed', 'bad']);
  });

  it('waits for the operator to let go before covering the screen, and lets go when the operator opens it', () => {
    const { cal, calibrate } = setup(); const pad = p.document.getElementById('pad')!; p.K.hold(pad, { action: 'teleop.deadman' });
    p.pointer(pad, 'pointerdown');
    calibrate({ status: 'capturing', step: 'flat' }); expect(sheet().hidden).toBe(true);
    p.pointer(pad, 'pointerup'); expect(sheet().hidden).toBe(false); expect(text('.mk-title')).toBe('Hold it flat');
    (sheet().querySelector('.mk-left') as HTMLButtonElement).click();
    expect(p.actions().at(-1)).toEqual({ controlId: 'calibration-cancel', action: 'calibration.cancel' });
    calibrate({}); expect(sheet().hidden).toBe(true);
    p.pointer(pad, 'pointerdown'); cal.open();
    expect(p.actions().at(-1)).toEqual({ controlId: 'deadman', action: 'teleop.deadman', value: false });
  });

  it('shows replies in the intro, as toasts when closed, and says which statuses it handles', () => {
    const { cal } = setup(); const reply = (message: string, accepted = true) => ({ type: 'status', version: 1, sessionId: 'g', controlId: 'capture-origin', message, values: { accepted } });
    expect(cal.handles(reply('x'))).toBe(true); expect(cal.handles({ controlId: 'grip', message: 'x' })).toBe(false); expect(cal.handles({ message: 'x' })).toBe(false);
    p.receive('status', reply('Origin set')); expect(p.document.querySelector('.mk-toast')!.textContent).toBe('Origin set');
    cal.open(); p.receive('status', reply('No pose yet', false)); expect(sheet().querySelector('.mk-reply.mk-bad')!.textContent).toBe('No pose yet');
  });

  it('builds a Calibration row that opens the sheet, and takes the screen’s own copy', () => {
    p = page({ body: '<div id="rows"></div>' }); p.connect(); p.config({}, { calibration: { status: 'captured', epoch: 2, reference: reference(2, 'quick') as never, check: { results: [], passed: true } } });
    const cal = p.K.calibration({ copy: { introDone: 'Set', validate: 'Validate calibration', steps: { flat: { title: 'Face Axol' } } } });
    const row = cal.row(); p.document.getElementById('rows')!.append(row);
    expect(row.textContent).toBe('CalibrationQuick origin, validated ✓'); expect(row.querySelector('.mk-val')!.className).toBe('mk-val mk-ok');
    row.click(); expect(text('.mk-title')).toBe('Set'); expect(buttons()).toEqual(['Close', 'Calibrate again', 'Validate calibration', 'Set origin here', 'Reset']);
    p.config({}, { calibration: { status: 'capturing', epoch: 2, step: 'flat' } as never });
    expect(text('.mk-title')).toBe('Face Axol'); expect(text('.mk-body')).toContain('Roughly flat');
  });
});
