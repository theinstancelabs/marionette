import { describe, expect, it } from 'vitest';
import { PhoneTracker } from '../src/index.js';
import { messages } from '../src/testing/index.js';

const setup = (options: ConstructorParameters<typeof PhoneTracker>[0] = {}) => {
  const clock = { now: 1000 }; const tracker = new PhoneTracker({ clock: () => clock.now, ...options });
  tracker.apply(messages.config({ phone: 'phone-1' }));
  return { tracker, clock, phone: () => tracker.get('phone-1')! };
};

describe('PhoneTracker', () => {
  it('learns holds, drags and buttons from the layout, with no actions built in', () => {
    const { tracker, phone } = setup();
    expect(Object.keys(phone().holds).sort()).toEqual(['base.turnLeft', 'base.turnRight', 'gripper.hold', 'teleop.deadman']);
    expect(Object.keys(phone().drags).sort()).toEqual(['base.drive', 'base.speedLimit', 'teleop.translationScale']);
    expect(phone().values).toMatchObject({ 'safety.estop': false, 'arm.select': 'left', 'teleop.translationScale': 1, 'base.drive': { x: 0, y: 0 } });
    // A screen with its own controls: a hold the default layout doesn't have.
    tracker.apply(messages.config({ phone: 'phone-1', controls: [{ id: 'up', type: 'button', label: 'Lift up', action: 'lift.up', hold: true }, { id: 'pan', type: 'joystick', label: 'Pan', action: 'camera.pan', value: { x: 0, y: 0 } }] }));
    tracker.apply(messages.input('phone-1', 'lift.up', true)); tracker.apply(messages.input('phone-1', 'camera.pan', { x: 0, y: 0.4 }, { live: true }));
    expect(phone().hold('lift.up')).toMatchObject({ down: true, presses: 1 }); expect(phone().drag('camera.pan')).toMatchObject({ live: true, value: { x: 0, y: 0.4 } });
    // An action no control declares counts as a press and keeps its value.
    tracker.apply(messages.input('phone-1', 'custom.thing', 'go')); tracker.apply(messages.input('phone-1', 'custom.thing', 'go', { renew: true }));
    expect(phone().presses('custom.thing')).toBe(1); expect(phone().value('custom.thing')).toBe('go');
  });

  it('times holds and sticks out on the tracker clock', () => {
    const { tracker, clock, phone } = setup();
    tracker.apply(messages.input('phone-1', 'teleop.deadman', true));
    expect(phone().holding('teleop.deadman', clock.now)).toBe(true);
    clock.now += 500; tracker.apply(messages.input('phone-1', 'teleop.deadman', true, { renew: true }));
    expect(phone().holding('teleop.deadman', clock.now + 600)).toBe(true); expect(phone().holding('teleop.deadman', clock.now + 601)).toBe(false);
    expect(phone().holding('teleop.deadman', clock.now + 300, 200)).toBe(false);
    // A stick: rest untouched, its sample while live and fresh, undefined once it goes quiet (a dead source).
    expect(phone().stick('base.drive', clock.now)).toEqual({ x: 0, y: 0 });
    tracker.apply(messages.input('phone-1', 'base.drive', { x: 0.6, y: -0.2 }, { live: true }));
    expect(phone().stick('base.drive', clock.now + 250)).toEqual({ x: 0.6, y: -0.2 });
    expect(phone().stick('base.drive', clock.now + 251)).toBeUndefined();
    tracker.apply(messages.input('phone-1', 'base.drive', { x: 0, y: 0 }));
    expect(phone().stick('base.drive', clock.now + 10_000)).toEqual({ x: 0, y: 0 });
  });

  it('reads values as numbers and choices with fallbacks', () => {
    const { tracker, phone } = setup();
    tracker.apply(messages.input('phone-1', 'teleop.translationScale', 3.5, { live: true }));
    expect(phone().number('teleop.translationScale', 1, 0.05, 2)).toBe(2);
    expect(phone().number('arm.select', 7)).toBe(7);
    expect(phone().choice('arm.select', ['left', 'right'] as const, 'right')).toBe('left');
    expect(phone().choice('camera.view', ['wide'], 'wide')).toBe('wide');
    expect(phone().ordinal).toBe(1); expect(phone().stale).toBe(false);
  });

  it('hands out snapshots that later messages do not change', () => {
    const { tracker, phone } = setup();
    const before = tracker.snapshot().get('phone-1')!;
    tracker.apply(messages.input('phone-1', 'teleop.deadman', true)); tracker.apply(messages.input('phone-1', 'base.drive', { x: 1, y: 0 }, { live: true }));
    expect(before.hold('teleop.deadman').down).toBe(false); expect(before.values['base.drive']).toEqual({ x: 0, y: 0 });
    const copy = phone(); copy.values['safety.estop'] = true; copy.holds['teleop.deadman'].down = false;
    expect(phone().stop).toBe(false); expect(phone().hold('teleop.deadman').down).toBe(true);
  });

  it('ages poses from the gateway stamps and our clock offset', () => {
    let wall = 50_000; let offset: number | undefined;
    const { tracker, clock, phone } = setup({ wallClock: () => wall, offsetMs: () => offset });
    tracker.apply(messages.pose('phone-1', { latencyMs: 12 }));
    expect(phone().pose!.age(clock.now)).toBe(12); expect(phone().poseAge(clock.now + 100)).toBe(112);
    // Our clock is 1000 ms ahead of the gateway's; the gateway got the pose 20 ms before we did.
    offset = 1000; wall = 50_000; tracker.apply(messages.pose('phone-1', { latencyMs: 12, receivedAt: 50_000 - 1000 - 20 }));
    expect(phone().pose!.age(clock.now)).toBe(32);
    tracker.apply(messages.pose('phone-1', { receivedAt: 50_000 - 1000 + 5 })); // a clock that is a little off never gives a negative trip
    expect(phone().pose!.age(clock.now)).toBe(0);
  });

  it('keeps the last good pose when a malformed one arrives, and follows calibration', () => {
    const { tracker, phone } = setup();
    tracker.apply(messages.pose('phone-1', { position: { x: 0.2, y: 0, z: 0 } }));
    tracker.apply({ ...messages.pose('phone-1'), position: { x: Number.NaN, y: 0, z: 0 } });
    tracker.apply({ ...messages.pose('phone-1'), rotation: { x: 0, y: 0, z: 0, w: 0 } });
    expect(phone().pose!.position).toEqual([0.2, 0, 0]);
    tracker.apply(messages.config({ phone: 'phone-1', calibration: { status: 'captured', epoch: 3 } }));
    expect(phone()).toMatchObject({ calibration: 'captured', epoch: 3 });
  });

  it('never lets a config turn Stop off unless mirrors may act, and lets the desktop clear an offline phone for good', () => {
    const { tracker, phone } = setup();
    tracker.apply(messages.input('phone-1', 'safety.estop', true)); tracker.apply(messages.config({ phone: 'phone-1', values: { estop: true } }));
    // A mirror's Stop off is ignored, but the gateway applies it and republishes the phone's config.
    tracker.apply(messages.input('phone-1', 'safety.estop', false, { source: 'mirror' })); tracker.apply(messages.config({ phone: 'phone-1', values: { estop: false } }));
    expect(phone().stop).toBe(true);
    tracker.apply(messages.input('phone-1', 'safety.estop', false)); expect(phone().stop).toBe(false);
    // After a lost gateway the next config says what is true again.
    tracker.apply(messages.input('phone-1', 'safety.estop', true)); tracker.lostGateway(); tracker.apply(messages.config({ phone: 'phone-1', values: { estop: false } }));
    expect(phone().stop).toBe(false);
    const allow = new PhoneTracker({ mirror: 'allow' }); allow.apply(messages.config({ phone: 'phone-1', values: { estop: true } })); allow.apply(messages.config({ phone: 'phone-1', values: { estop: false } }));
    expect(allow.get('phone-1')!.stop).toBe(false);
    // Offline with Stop on: the desktop clears it, and the gateway's republished configs don't bring it back until the phone reconnects.
    tracker.apply(messages.input('phone-1', 'safety.estop', true)); const offline = messages.phone('phone-1', { connected: false });
    tracker.apply(messages.config({ phone: offline, values: { estop: true } })); tracker.clearStaleStops(); expect(phone().stop).toBe(false);
    tracker.apply(messages.config({ phone: offline, values: { estop: true } })); expect(tracker.anyStop()).toBe(false);
    tracker.apply(messages.config({ phone: 'phone-1', values: { estop: true } })); expect(phone().stop).toBe(true);
  });

  it('clears Stop only on offline phones that have it on, so a Stop that comes later still counts', () => {
    const tracker = new PhoneTracker(); const offline = messages.phone('phone-2', { connected: false });
    tracker.apply(messages.config({ phones: [messages.phone('phone-1'), offline], phone: offline }));
    tracker.clearStaleStops();
    // The robot's link blips, and meanwhile phone-2's Stop goes on (from a mirror): the gateway's config says so.
    tracker.lostGateway(); tracker.apply(messages.config({ phones: [messages.phone('phone-1'), offline], phone: offline, values: { estop: true } }));
    expect(tracker.get('phone-2')!.stop).toBe(true); expect(tracker.anyStop()).toBe(true);
  });

  it('takes values the gateway would keep: on a slider’s step grid, and one of a select’s options', () => {
    const { tracker, phone } = setup();
    tracker.apply(messages.config({ phone: 'phone-1', controls: [
      { id: 'gain', type: 'slider', label: 'Gain', action: 'arm.gain', value: 0.5, min: 0, max: 1, step: 0.25 },
      { id: 'mode', type: 'select', label: 'Mode', action: 'arm.mode', value: 'a', options: [] },
      { id: 'pick', type: 'select', label: 'Pick', action: 'arm.pick', value: 'x', options: [{ label: 'X', value: 'x' }, { label: 'Y', value: 'y' }] }] }));
    expect(phone().value('arm.gain')).toBe(0.5);
    tracker.apply(messages.input('phone-1', 'arm.gain', 0.3)); expect(phone().value('arm.gain')).toBe(0.5);
    tracker.apply(messages.input('phone-1', 'arm.gain', 1.0000001)); expect(phone().value('arm.gain')).toBe(0.5);
    tracker.apply(messages.input('phone-1', 'arm.gain', 0.75, { live: true })); expect(phone().value('arm.gain')).toBe(0.75);
    tracker.apply(messages.input('phone-1', 'arm.gain', 0.25 + 1e-9)); expect(phone().value('arm.gain')).toBe(0.25 + 1e-9); // on the grid within 1e-6 steps
    // A select with no options takes nothing; one with options only those.
    expect(phone().value('arm.mode')).toBeUndefined();
    tracker.apply(messages.input('phone-1', 'arm.mode', 'anything')); expect(phone().value('arm.mode')).toBeUndefined();
    tracker.apply(messages.input('phone-1', 'arm.pick', 'z')); expect(phone().value('arm.pick')).toBe('x');
    tracker.apply(messages.input('phone-1', 'arm.pick', 'y')); expect(phone().value('arm.pick')).toBe('y');
  });

  it('forgets phones that leave a complete roster, keeping one with Stop on', () => {
    const tracker = new PhoneTracker(); const roster = ['phone-1', 'phone-2', 'phone-3'].map(id => messages.phone(id));
    for (const phone of roster) tracker.apply(messages.config({ sessionId: 'gw', phones: roster, phone }));
    tracker.apply(messages.input('phone-3', 'safety.estop', true));
    tracker.apply(messages.config({ sessionId: 'gw', phones: [roster[0]] }));
    expect([...tracker.snapshot().keys()].sort()).toEqual(['phone-1', 'phone-3@gw']); expect(tracker.get('phone-3@gw')).toMatchObject({ connected: false, stop: true });
    // An unreadable roster removes nobody; a config's own phone counts as listed.
    tracker.apply(messages.config({ sessionId: 'gw', phones: [roster[0], { id: 7 } as never] })); tracker.apply(messages.config({ sessionId: 'gw', phones: [], phone: roster[0] }));
    expect([...tracker.snapshot().keys()].sort()).toEqual(['phone-1', 'phone-3@gw']);
  });

  it('keeps a stopped phone across more than one gateway restart, under its first old id', () => {
    const tracker = new PhoneTracker();
    tracker.apply(messages.config({ sessionId: 'gw-a', phone: 'phone-1' })); tracker.apply(messages.input('phone-1', 'safety.estop', true));
    // Not told the gateway was lost first: a restart still lets go of it.
    tracker.apply(messages.config({ sessionId: 'gw-b', phones: [] }));
    expect(tracker.get('phone-1@gw-a')).toMatchObject({ connected: false, stop: true, stale: true });
    // Nothing a gateway sends reaches a kept phone.
    tracker.apply(messages.input('phone-1@gw-a', 'safety.estop', false)); tracker.apply(messages.config({ sessionId: 'gw-b', phones: [messages.phone('phone-1@gw-a', { connected: true })] }));
    expect(tracker.get('phone-1@gw-a')).toMatchObject({ connected: false, stop: true });
    tracker.apply(messages.config({ sessionId: 'gw-c', phone: 'phone-1' }));
    expect([...tracker.snapshot().keys()].sort()).toEqual(['phone-1', 'phone-1@gw-a']);
    expect(tracker.anyStop()).toBe(true); expect(tracker.gateway).toBe('gw-c');
    tracker.apply(messages.input('phone-1', 'safety.estop', true));
    // Clearing forgets the old phone and Stop on phones that are offline, never on a connected one.
    tracker.clearStaleStops(); expect([...tracker.snapshot().keys()]).toEqual(['phone-1']); expect(tracker.anyStop()).toBe(true);
  });
});
