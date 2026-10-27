import { describe, expect, it } from 'vitest';
import { defaultConfig, type CalibrationCheckResult, type ConfigMessage, type InputMessage, type PosePacket, type StatusMessage, type UiControl } from '@marionette/protocol';
import { EventJournal, calibrationEvents, configEvents, controlEvents, inputDraft, inputText, isRejection, kindForText, knownStep, phoneEvents, phoneState, rosterEvents, statusDraft, type ConsoleEvent } from './events';

const base = (): ConfigMessage => ({ ...defaultConfig(), sessionId: 'gw' });
const withValue = (config: ConfigMessage, id: string, value: string | number | boolean): ConfigMessage => ({ ...config, controls: config.controls.map(c => c.id === id ? { ...c, value } as UiControl : c) });
const status = (message: string, controlId?: string, values: StatusMessage['values'] = {}, phoneId?: string): StatusMessage => ({ type: 'status', version: 1, sessionId: 'gw', controlId, message, values, phoneId });
const control = (id: string) => base().controls.find(candidate => candidate.id === id)!;
const input = (over: Partial<InputMessage>): InputMessage => ({ type: 'input', version: 1, phoneId: 'phone-1', controlId: 'deadman', action: 'teleop.deadman', value: true, source: 'phone', receivedAt: 1, ...over });
const result = (move: CalibrationCheckResult['move'], passed: boolean): CalibrationCheckResult => ({ move, expected: '+X', dominant: passed ? '+X' : '+Z', displacement: { x: 0.1, y: 0, z: 0 }, passed });
const reference = { mode: 'guided' as const, sessionId: 'p', epoch: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, frame: { x: 0, y: 0, z: 0, w: 1 } };
const messages = (drafts: { message: string }[]) => drafts.map(d => d.message);

describe('calibration progress', () => {
  it('logs guided calibration steps', () => {
    const idle = base().calibration;
    expect(messages(calibrationEvents(idle, { status: 'capturing', epoch: 0, step: 'flat' }))).toEqual(['Guided calibration started']);
    expect(messages(calibrationEvents({ status: 'capturing', epoch: 0, step: 'flat' }, { status: 'capturing', epoch: 0, step: 'forward', anchor: { x: 0, y: 0, z: 0 } }))).toEqual(['Flat reference captured']);
    expect(messages(calibrationEvents({ status: 'capturing', epoch: 0, step: 'up' }, { status: 'captured', epoch: 1, reference }))).toEqual(['Up captured; guided frame is live (epoch 1)']);
    expect(messages(calibrationEvents({ status: 'captured', epoch: 1, reference }, { status: 'uncalibrated', epoch: 2 }))).toEqual(['Calibration cleared']);
    expect(messages(calibrationEvents({ status: 'capturing', epoch: 1, step: 'right', reference }, { status: 'captured', epoch: 1, reference }))).toEqual(['Calibration cancelled; previous frame kept']);
  });

  it('logs validation results as they arrive', () => {
    const captured = { status: 'captured' as const, epoch: 1, reference };
    const started = { ...captured, check: { step: 'forward' as const, results: [] } };
    const one = { ...captured, check: { step: 'right' as const, results: [result('forward', true)] } };
    const failed = { ...captured, check: { results: [result('forward', true), result('right', true), result('up', false)], passed: false } };
    expect(messages(calibrationEvents(captured, started))).toEqual(['Validation started']);
    expect(calibrationEvents(started, one)).toMatchObject([{ kind: 'validation', tone: 'pass' }]);
    expect(calibrationEvents(one, failed).map(e => [e.tone, e.message.split(' (')[0]])).toEqual([['pass', 'right → +X ✓'], ['fail', 'up → +Z ✗ expected +X'], ['fail', 'Validation failed']]);
    expect(messages(calibrationEvents(started, captured))).toEqual(['Validation cancelled']);
    expect(calibrationEvents(one, one)).toEqual([]);
  });

  it('does not re-log an older result that a cancel restores', () => {
    const validated = { status: 'captured' as const, epoch: 1, reference, check: { results: [result('forward', true), result('right', true), result('up', true)], passed: true } };
    // Cancelling a guided calibration brings back the validated frame.
    expect(messages(calibrationEvents({ status: 'capturing', epoch: 1, step: 'right', reference }, validated))).toEqual(['Calibration cancelled; previous frame kept']);
    // Cancelling a new validation brings back the previous result.
    const rerun = { ...validated, check: { step: 'right' as const, results: [{ ...result('forward', true), displacement: { x: 0.097, y: 0.004, z: 0 } }] } };
    expect(messages(calibrationEvents(rerun, validated))).toEqual(['Validation cancelled']);
    // Restarting a validation part way is a new start.
    expect(messages(calibrationEvents(rerun, { ...validated, check: { step: 'forward', results: [] } }))).toEqual(['Validation started']);
  });

  it('ignores calibration steps it does not know', () => {
    expect(knownStep('tilt')).toBeUndefined();
    expect(knownStep('up')).toBe('up');
    expect(calibrationEvents({ status: 'capturing', epoch: 0, step: 'flat' }, { status: 'capturing', epoch: 0, step: 'tilt' as never })).toEqual([]);
  });
});

describe('control changes', () => {
  it('logs Stop in red, choices by their option label, and nothing for holds', () => {
    const a = base();
    expect(controlEvents(a, withValue(a, 'estop', true))).toEqual([{ kind: 'safety', message: 'Stop on', tone: 'fail' }]);
    expect(controlEvents(withValue(a, 'estop', true), a)).toEqual([{ kind: 'safety', message: 'Stop off', tone: 'normal' }]);
    expect(messages(controlEvents(a, withValue(withValue(a, 'arm', 'right'), 'cameras', 'arms')))).toEqual(['Active arm: Right arm', 'Cameras: Arm cams']);
    expect(controlEvents(a, withValue(withValue(a, 'cameras', 'arms'), 'lift', false)).map(e => `${e.kind}: ${e.message}`)).toEqual(['camera: Cameras: Arm cams', 'settings: Include lift off']);
    const held = { ...a, controls: a.controls.map(c => c.id === 'deadman' ? { ...c, held: true } as UiControl : c) };
    expect(configEvents(a, held)).toEqual([]);
  });

  it('keys slider changes so a drag settles into one line', () => {
    expect(controlEvents(base(), withValue(base(), 'sensitivity', 1.5))).toEqual([{ kind: 'settings', message: 'Translation scale: 1.5×', tone: 'normal', key: 'control:sensitivity', settleMs: 600 }]);
  });
});

describe('roster', () => {
  it('notices phones connecting, leaving and coming back', () => {
    const one = { id: 'phone-1', name: 'Phone 1', color: '#c98200', connected: true };
    const two = { id: 'phone-2', name: 'Phone 2', color: '#b04fc4', connected: true };
    expect(rosterEvents([], [one, two]).map(e => `${e.phoneId}: ${e.message}`)).toEqual(['phone-1: Connected', 'phone-2: Connected']);
    expect(rosterEvents([one, two], [one, { ...two, connected: false }]).map(e => `${e.phoneId}: ${e.message}`)).toEqual(['phone-2: Disconnected']);
    expect(rosterEvents([one, { ...two, connected: false }], [one, two]).map(e => `${e.phoneId}: ${e.message}`)).toEqual(['phone-2: Reconnected']);
    expect(rosterEvents([one, two], [two]).map(e => `${e.phoneId}: ${e.message}`)).toEqual(['phone-1: Disconnected']);
    expect(rosterEvents([{ ...one, connected: false }], [])).toEqual([]);
    // A takeover keeps the phone connected; only a new connection clears its session.
    expect(rosterEvents([{ ...one, sessionId: 'a' }], [one]).map(e => e.message)).toEqual(['Reconnected, replacing its previous connection']);
    expect(rosterEvents([one], [{ ...one, sessionId: 'a' }])).toEqual([]);
    expect(rosterEvents([{ ...one, sessionId: 'a' }], [{ ...one, sessionId: 'b' }])).toEqual([]);
  });
});

describe('inputs', () => {
  const deadman = control('deadman'), arm = control('arm'), capture = control('calibration');
  it('logs presses and releases of holds, never their renewals', () => {
    expect(inputDraft(input({}), deadman, false)).toEqual({ kind: 'input', tone: 'normal', phoneId: 'phone-1', message: 'Hold to move pressed' });
    expect(inputDraft(input({ renew: true }), deadman, true)).toBeUndefined();
    expect(inputDraft(input({}), deadman, true)).toBeUndefined();
    expect(inputDraft(input({ value: false }), deadman, true)?.message).toBe('Hold to move released');
    expect(inputDraft(input({ value: false, source: 'gateway', reason: 'hold not renewed' }), deadman, true)?.message).toBe('Hold to move released by the gateway (hold not renewed)');
    expect(inputDraft(input({ source: 'mirror' }), deadman, false)?.message).toBe('Hold to move pressed (desktop mirror)');
    // The phone letting go of a hold the gateway already ended is not news.
    expect(inputDraft(input({ value: false }), deadman, false)).toBeUndefined();
  });

  it('leaves settings and calibration to the configs, and logs undeclared actions', () => {
    expect(inputDraft(input({ controlId: 'arm', action: 'arm.select', value: 'right' }), arm, false)).toBeUndefined();
    expect(inputDraft(input({ controlId: 'calibration', action: 'calibration.capture', value: 'flat' }), capture, false)).toBeUndefined();
    expect(inputDraft(input({ controlId: 'estop', action: 'safety.estop', value: true }), control('estop'), false)).toBeUndefined();
    expect(inputDraft(input({ controlId: 'open', action: 'gripper.open', value: 0.4 }), undefined, false)).toMatchObject({ kind: 'input', message: 'gripper.open: 0.4', key: 'input:open', settleMs: 600 });
  });

  it('says what each input did, for the inspector', () => {
    expect(inputText(input({}), deadman)).toBe('pressed');
    expect(inputText(input({ value: false, source: 'gateway', reason: 'phone disconnected' }), deadman)).toBe('released by the gateway (phone disconnected)');
    expect(inputText(input({ value: 'right' }), arm)).toBe('→ Right arm');
    expect(inputText(input({ value: 2.25 }), control('sensitivity'))).toBe('→ 2.3×');
    expect(inputText(input({ value: 'flat' }), capture)).toBe('pressed (flat)');
    expect(inputText(input({ value: false }), control('lift'))).toBe('off');
  });
});

describe('gateway replies', () => {
  it('reads refusals from accepted: false and names the phone', () => {
    const refused = status('Move the phone at least 30 mm forward of the flat reference', 'calibration', { accepted: false }, 'phone-2');
    expect(isRejection(refused)).toBe(true);
    expect(statusDraft(refused, base())).toEqual({ kind: 'calibration', message: refused.message, tone: 'fail', phoneId: 'phone-2' });
    expect(statusDraft(status('Validated: forward +X, right −Y, up +Z', 'calibration-check', { accepted: true }, 'phone-1'), base())).toMatchObject({ kind: 'validation', tone: 'pass' });
    expect(statusDraft(status('Connected to Marionette gateway'), base())).toEqual({ kind: 'session', message: 'Connected to Marionette gateway', tone: 'normal', phoneId: undefined });
    expect(kindForText('Tracking degraded')).toBe('tracking');
  });
});

describe('pose stream', () => {
  const pose = (over: Partial<PosePacket> = {}) => ({ sessionId: 'p1', heartbeat: true, trackingState: 'normal', ...over }) as PosePacket;
  it('notices a stream starting, its tracking changing, and it stopping', () => {
    const none = phoneState(undefined, 0, 0);
    const here = phoneState(pose(), 1000, 1100);
    expect(messages(phoneEvents(none, here))).toEqual(['Streaming poses, tracking good']);
    expect(messages(phoneEvents(here, phoneState(pose({ trackingState: 'limited' }), 1200, 1200)))).toEqual(['Tracking limited']);
    expect(messages(phoneEvents(here, phoneState(pose(), 1000, 5000)))).toEqual(['Pose stream stopped']);
    expect(messages(phoneEvents(here, phoneState(pose({ heartbeat: false }), 1200, 1200)))).toEqual(['Pose stream stopped']);
  });
  it('leaves a disconnected phone to the roster', () => {
    expect(phoneEvents(phoneState(pose(), 1000, 1100), phoneState(undefined, 0, 0), false)).toEqual([]);
  });
});

describe('event journal', () => {
  const journal = () => { const log: ConsoleEvent[] = []; return { log, j: new EventJournal(events => log.push(...events)) }; };

  it('pairs a transition with the gateway explanation of the same phone, whichever comes first', () => {
    const { log, j } = journal();
    // Explanation after the transition.
    j.propose([{ kind: 'calibration', message: 'Flat reference captured', tone: 'normal', pair: 'replace', phoneId: 'phone-1' }], 0);
    j.explain({ kind: 'calibration', message: 'Move the phone straight forward', tone: 'normal', phoneId: 'phone-1' }, 10);
    // Explanation before the transition, as the gateway sends calibration replies.
    j.explain({ kind: 'calibration', message: 'Hold the phone roughly flat', tone: 'normal', phoneId: 'phone-2' }, 20);
    j.propose([{ kind: 'calibration', message: 'Guided calibration started', tone: 'normal', pair: 'prefix', phoneId: 'phone-2' }], 21);
    j.flush();
    expect(log.map(e => `${e.phoneId}: ${e.message}`)).toEqual(['phone-1: Move the phone straight forward', 'phone-2: Guided calibration started. Hold the phone roughly flat']);
  });

  it('never pairs across phones', () => {
    const { log, j } = journal();
    j.propose([{ kind: 'calibration', message: 'Flat reference captured', tone: 'normal', pair: 'replace', phoneId: 'phone-1' }], 0);
    j.explain({ kind: 'calibration', message: 'Flat reference captured. Move forward', tone: 'normal', phoneId: 'phone-2' }, 1);
    j.flush();
    expect(log.map(e => `${e.phoneId}: ${e.message}`)).toEqual(['phone-1: Flat reference captured', 'phone-2: Flat reference captured. Move forward']);
  });

  it('drops a result the explanation already describes, and lets a roster change explain a stopped stream', () => {
    const { log, j } = journal();
    j.explain({ kind: 'validation', message: 'forward → +X ✓ (x 101, y 0, z 0 mm). Back at the flat spot…', tone: 'pass', phoneId: 'phone-1' }, 0);
    j.propose([{ kind: 'validation', message: 'forward → +X ✓ (x 101, y 0, z 0 mm)', tone: 'pass', phoneId: 'phone-1' }], 1);
    j.propose([{ kind: 'session', message: 'Pose stream stopped', tone: 'normal', pair: 'replace', phoneId: 'phone-2' }], 2);
    j.explain({ kind: 'session', message: 'Disconnected', tone: 'normal', phoneId: 'phone-2' }, 3);
    j.flush();
    expect(log.map(e => e.message)).toEqual(['forward → +X ✓ (x 101, y 0, z 0 mm). Back at the flat spot…', 'Disconnected']);
  });

  it('puts a change the explanation does not cover before it', () => {
    const { log, j } = journal();
    j.explain({ kind: 'validation', message: 'Validated: forward +X, right −Y, up +Z', tone: 'pass', phoneId: 'phone-1' }, 10, true);
    j.propose([{ kind: 'validation', message: 'up → +Z ✓ (x 0, y 0, z 100 mm)', tone: 'pass', phoneId: 'phone-1' }, { kind: 'validation', message: 'Validated: forward +X, right −Y, up +Z', tone: 'pass', pair: 'replace', phoneId: 'phone-1' }], 11);
    j.flush();
    expect(messages(log)).toEqual(['up → +Z ✓ (x 0, y 0, z 100 mm)', 'Validated: forward +X, right −Y, up +Z']);
    expect(log[0].at).toBe(10);
  });

  it('holds events until due, and settles keyed drafts into their latest value', () => {
    const { log, j } = journal();
    j.propose([{ kind: 'input', message: 'Grip pressed', tone: 'normal', phoneId: 'phone-1' }], 0);
    for (const [at, value] of [[0, '1.1×'], [200, '1.4×'], [400, '1.8×']] as const) j.propose([{ kind: 'settings', message: `Translation scale: ${value}`, tone: 'normal', phoneId: 'phone-1', key: 'control:sensitivity', settleMs: 600 }], at);
    j.flush(300);
    expect(messages(log)).toEqual(['Grip pressed']);
    j.flush(900);
    expect(messages(log)).toEqual(['Grip pressed']);
    j.flush(1000);
    expect(messages(log)).toEqual(['Grip pressed', 'Translation scale: 1.8×']);
  });
});
