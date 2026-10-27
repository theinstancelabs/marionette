import { describe, expect, it } from 'vitest';
import { Clutch, JumpDetector, PhonePose, PhoneTracker, PressTracker, TELEOP_DEFAULTS, cameraFrame, expRotation, follow, gate, identity, matMul, matVec, matrixFromQuaternion, norm, owners,
  quaternionFromMatrix, rotationVector, sub, transpose, unwrapTurn, type Mat3, type Pose, type Vec3 } from '../src/index.js';
import { messages } from '../src/testing/index.js';

const close = (a: number[], b: number[], digits = 9) => a.forEach((value, i) => expect(value).toBeCloseTo(b[i], digits));
const closeMat = (a: Mat3, b: Mat3, digits = 9) => a.forEach((row, i) => close(row, b[i], digits));
/** The angle between two rotations. */
const between = (a: Mat3, b: Mat3) => norm(rotationVector(matMul(a, transpose(b))));
const yaw = (angle: number): Mat3 => expRotation([0, 0, angle]);
const pose = (position: Vec3, rotation: Mat3 = identity(), extra: { session?: string; calibration?: string; seq?: number; stamp?: number } = {}) => ({ position, rotation, session: 's', calibration: 'guided-v2:1', ...extra });

describe('rotations', () => {
  it('converts between matrices, quaternions and rotation vectors, including half turns', () => {
    for (const v of [[0.3, -0.2, 0.5], [0, 0, Math.PI - 1e-7], [Math.PI / Math.SQRT2, Math.PI / Math.SQRT2, 0], [1e-14, 0, 0], [0, 0, 0]] as Vec3[]) {
      const m = expRotation(v); closeMat(matMul(m, transpose(m)), identity());
      closeMat(matrixFromQuaternion(quaternionFromMatrix(m)), m);
      closeMat(expRotation(rotationVector(m)), m);
      if (norm(v) < Math.PI - 1e-6) close(rotationVector(m), v);
    }
    // A quarter turn left (about +Z) takes forward (+X) to left (+Y).
    close(matVec(yaw(Math.PI / 2), [1, 0, 0]), [0, 1, 0]);
    closeMat(matrixFromQuaternion({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }), yaw(Math.PI / 2));
  });

  it('unwraps a turn past half a turn so it stays continuous', () => {
    let previous: Vec3 = [0, 0, 0];
    for (let degrees = 0; degrees <= 720; degrees += 5) {
      const turn = unwrapTurn(rotationVector(yaw(degrees * Math.PI / 180)), previous);
      close(turn, [0, 0, degrees * Math.PI / 180]);
      previous = turn;
    }
    close(unwrapTurn([0, 0, 0], [0, 0, 2 * Math.PI]), [0, 0, 2 * Math.PI]);
  });
});

describe('clutch', () => {
  const tip: Pose = { position: [0.4, 0.2, 0.9], rotation: expRotation([0.1, 0.2, 0.3]) };

  it('does nothing on engage, then follows scaled moves in the frame F', () => {
    const clutch = new Clutch(); const p0 = pose([1, 2, 3], yaw(0.4));
    clutch.engage(p0, tip, { scale: 0.5 });
    const same = clutch.target(p0); close(same.position, tip.position); closeMat(same.rotation, tip.rotation);
    close(clutch.target(pose([1.2, 2, 3], yaw(0.4))).position, [0.5, 0.2, 0.9]);
    // In a frame turned a quarter left, the phone's forward is the robot's left.
    clutch.engage(p0, tip, { scale: 2, frame: yaw(Math.PI / 2) });
    close(clutch.target(pose([1.1, 2, 3], yaw(0.4))).position, [0.4, 0.4, 0.9]);
  });

  it('follows scaled turns from 0 to 720° continuously, at any scale and rotation scale', () => {
    for (const [s, r] of [[1, 1], [0.5, 1], [2, 1], [0.3, 2]]) {
      const clutch = new Clutch({ rotationScale: r }); clutch.engage(pose([0, 0, 0]), tip, { scale: s });
      let last = tip.rotation;
      for (let degrees = 5; degrees <= 720; degrees += 5) {
        const target = clutch.target(pose([0, 0, 0], yaw(degrees * Math.PI / 180))).rotation;
        // Each 5° step of the phone turns the target by r·s·5° (mod a whole turn), never by a jump.
        expect(between(target, last)).toBeCloseTo(Math.min(r * s * 5, 360 - ((r * s * 5) % 360)) * Math.PI / 180, 6);
        closeMat(target, matMul(yaw(r * s * degrees * Math.PI / 180), tip.rotation), 6);
        last = target;
      }
    }
  });

  it('never jumps when the scale or frame changes, and checks the anchor', () => {
    const clutch = new Clutch(); clutch.engage(pose([0, 0, 0]), tip, { scale: 1 });
    const moved = pose([0.1, 0.05, 0], yaw(1.2));
    const before = clutch.target(moved);
    const rescaled = clutch.target(moved, 3); close(rescaled.position, before.position); closeMat(rescaled.rotation, before.rotation);
    expect(clutch.scale).toBe(3);
    // From here on the new scale applies: another 1 cm forward is 3 cm.
    close(clutch.target(pose([0.11, 0.05, 0], yaw(1.2))).position, [before.position[0] + 0.03, before.position[1], before.position[2]], 9);
    const here = clutch.target(pose([0.11, 0.05, 0], yaw(1.2)));
    clutch.reframe(pose([0.11, 0.05, 0], yaw(1.2)), yaw(Math.PI / 2));
    const reframed = clutch.target(pose([0.11, 0.05, 0], yaw(1.2))); close(reframed.position, here.position); closeMat(reframed.rotation, here.rotation);
    close(clutch.target(pose([0.12, 0.05, 0], yaw(1.2))).position, [here.position[0], here.position[1] + 0.03, here.position[2]], 9);
    // A turn past half a turn after a rescale is still continuous.
    let last = clutch.target(pose([0.12, 0.05, 0], yaw(1.2)));
    for (let degrees = 70; degrees <= 400; degrees += 10) {
      const next = clutch.target(pose([0.12, 0.05, 0], yaw(degrees * Math.PI / 180)), 0.5);
      expect(between(next.rotation, last.rotation)).toBeLessThan(0.5 * 10 * Math.PI / 180 + 1e-6); last = next;
    }
    expect(clutch.anchorValid(pose([0, 0, 0]))).toBe(true);
    expect(clutch.anchorValid(pose([0, 0, 0], identity(), { session: 'other' }))).toBe(false);
    expect(clutch.anchorValid(pose([0, 0, 0], identity(), { calibration: 'guided-v2:2' }))).toBe(false);
    expect(clutch.anchorValid(null)).toBe(false);
    clutch.release(); expect(clutch.engaged).toBe(false); expect(clutch.anchorValid(pose([0, 0, 0]))).toBe(false);
    expect(() => clutch.target(pose([0, 0, 0]))).toThrow(/engage/);
  });

  it('maps forward to the camera view direction in a camera frame', () => {
    // A head camera looking down 30° and turned 20° left: its optical +Z (the view) in the robot frame.
    const look = matMul(yaw(20 * Math.PI / 180), expRotation([0, 30 * Math.PI / 180, 0]));
    const optical = matMul(look, [[0, 0, 1], [-1, 0, 0], [0, -1, 0]]);
    const view = matVec(optical, [0, 0, 1]); const imageRight = matVec(optical, [1, 0, 0]); const imageDown = matVec(optical, [0, 1, 0]);
    const F = cameraFrame(optical);
    close(matVec(F, [1, 0, 0]), view); close(matVec(F, [0, 1, 0]), sub([0, 0, 0], imageRight)); close(matVec(F, [0, 0, 1]), sub([0, 0, 0], imageDown));
    // A camera looking straight ahead (optical z = forward, x = right, y = down) gives the identity.
    closeMat(cameraFrame([[0, 0, 1], [-1, 0, 0], [0, -1, 0]]), identity());
  });
});

describe('safety parts', () => {
  const tracked = (extra: Partial<Parameters<typeof messages.pose>[1]> = {}, calibration: 'uncalibrated' | 'capturing' | 'captured' = 'captured') => {
    let now = 1000; const tracker = new PhoneTracker({ clock: () => now });
    tracker.apply(messages.config({ phone: 'phone-1', calibration: { status: calibration, epoch: 1 } }));
    tracker.apply(messages.pose('phone-1', extra));
    return { phone: tracker.get('phone-1')!, at: (t: number) => (now = t, tracker.get('phone-1')!) };
  };

  it('gates on connection, calibration, pose age, latency, source and tracking', () => {
    const { phone } = tracked();
    expect(gate(phone, 1000)).toBeUndefined();
    expect(gate(phone, 1000 + TELEOP_DEFAULTS.poseTimeoutMs + 1)).toMatch(/No pose/);
    expect(gate(undefined, 1000)).toMatch(/offline/);
    expect(gate(Object.assign(phone.copy(), { connected: false }), 1000)).toMatch(/offline/);
    expect(gate(tracked({}, 'capturing').phone, 1000)).toMatch(/calibration/);
    expect(gate(tracked({}, 'uncalibrated').phone, 1000)).toBeUndefined();
    expect(gate(tracked({}, 'uncalibrated').phone, 1000, { requireCalibration: true })).toMatch(/Calibrate/);
    expect(gate(tracked({ source: 'synthetic', trackingState: 'limited' }).phone, 1000)).toMatch(/Simulated/);
    expect(gate(tracked({ source: 'synthetic', trackingState: 'limited' }).phone, 1000, { allowSynthetic: true })).toBeUndefined();
    expect(gate(tracked({ source: 'device-motion' }).phone, 1000)).toMatch(/no ARKit/);
    expect(gate(tracked({ trackingState: 'limited' }).phone, 1000)).toMatch(/limited/);
    expect(gate(tracked({ trackingState: 'initializing' }).phone, 1000)).toMatch(/starting/);
    expect(gate(tracked({ trackingState: 'relocalizing' }).phone, 1000)).toMatch(/finding its place/);
    // Ages count the trip to the gateway; a slow link can be refused outright.
    expect(gate(tracked({ latencyMs: 300 }).phone, 1000)).toMatch(/No pose/);
    expect(gate(tracked({ latencyMs: 80 }).phone, 1000, { maxLatencyMs: 50 })).toMatch(/too slow/);
  });

  it('detects tracking jumps but not hand speed', () => {
    const jumps = new JumpDetector();
    const at = (x: number, stamp: number, seq: number, rotation: Mat3 = identity()) => ({ position: [x, 0, 0] as Vec3, rotation, session: 's', seq, stamp });
    expect(jumps.check(at(0, 1, 1))).toBe(false);
    expect(jumps.check(at(0.03, 1.016, 2))).toBe(false); // 3 cm in a frame: under jumpM
    expect(jumps.check(at(0.03, 1.016, 2))).toBe(false); // the same pose again
    expect(jumps.check(at(0.08, 1.032, 3))).toBe(false); // 5 cm in 16 ms is 3 m/s: a fast hand
    expect(jumps.check(at(0.14, 1.042, 4))).toBe(true); // 6 cm in 10 ms
    expect(jumps.check(at(0.19, 1.5, 5))).toBe(false); // 5 cm in half a second
    expect(jumps.check(at(0.19, 1.516, 6, yaw(0.6)))).toBe(true); // a 0.6 rad turn in a frame
    expect(jumps.check({ ...at(2, 1.53, 1), session: 'new' })).toBe(false); // a new session starts over
  });

  it('consumes each press once, and ignores presses from before a phone was seen', () => {
    let now = 0; const tracker = new PhoneTracker({ clock: () => now });
    tracker.apply(messages.config({ phone: 'phone-1' }));
    const press = () => { tracker.apply(messages.input('phone-1', 'teleop.deadman', true)); tracker.apply(messages.input('phone-1', 'teleop.deadman', false)); now += 100; };
    press();
    const presses = new PressTracker('teleop.deadman');
    expect(presses.pressed(tracker.get('phone-1')!)).toBe(false);
    press(); expect(presses.pressed(tracker.get('phone-1')!)).toBe(true); expect(presses.pressed(tracker.get('phone-1')!)).toBe(false);
    press(); presses.forget(tracker.get('phone-1')!); expect(presses.pressed(tracker.get('phone-1')!)).toBe(false);
  });

  it('follows a target within speed and acceleration, and lands on it', () => {
    let position: Vec3 = [0, 0, 0]; let velocity: Vec3 = [0, 0, 0]; const target: Vec3 = [0.3, 0, 0]; const dt = 0.008;
    let peak = 0; let ticks = 0;
    while (norm(sub(target, position)) > 1e-9 && ticks < 2000) {
      const next = follow(sub(target, position), velocity, TELEOP_DEFAULTS.maxSpeed, TELEOP_DEFAULTS.maxAccel, dt);
      // Within a tick of the target it lands there; until then the velocity changes by accel · dt at most.
      if (norm(sub(target, position)) > norm(next) * dt + 1e-12) expect(norm(sub(next, velocity))).toBeLessThanOrEqual(TELEOP_DEFAULTS.maxAccel * dt + 1e-9);
      velocity = next; peak = Math.max(peak, norm(velocity)); position = [position[0] + velocity[0] * dt, position[1] + velocity[1] * dt, position[2] + velocity[2] * dt];
      expect(position[0]).toBeLessThanOrEqual(target[0] + 1e-9); ticks++;
    }
    expect(position[0]).toBeCloseTo(0.3, 9); expect(peak).toBeLessThanOrEqual(TELEOP_DEFAULTS.maxSpeed + 1e-9); expect(ticks).toBeLessThan(2000);
    expect(follow([0, 0, 0], [1, 0, 0], 1, 1, 0.01)).toEqual([0, 0, 0]);
  });

  it('gives each arm to the phone that has it, else the lowest-numbered phone choosing it', () => {
    const tracker = new PhoneTracker();
    const roster = [messages.phone('phone-1'), messages.phone('phone-2'), messages.phone('phone-3', { connected: false })];
    for (const [id, arm] of [['phone-1', 'left'], ['phone-2', 'left'], ['phone-3', 'right']]) tracker.apply(messages.config({ phones: roster, phone: roster.find(p => p.id === id)!, values: { arm } }));
    const phones = [...tracker.snapshot().values()];
    expect(owners(phones, {})).toMatchObject({ left: { id: 'phone-1' }, right: undefined });
    expect(owners(phones, { left: 'phone-2' }).left?.id).toBe('phone-2');
    expect(owners(phones, {}, { choices: ['base'], choose: phone => phone.id === 'phone-2' ? 'base' : undefined }).base?.id).toBe('phone-2');
  });

  it('keeps pose rotations as matrices and ages poses from the stamps', () => {
    const half = Math.SQRT1_2; const now = 5000;
    const p = new PhonePose([0, 0, 0], { x: 0, y: 0, z: half, w: half }, 'normal', 'arkit', 'guided-v2:1', 's', 1, 1, now, 12);
    closeMat(p.rotation, yaw(Math.PI / 2)); expect(p.age(now + 30)).toBe(42); expect(Object.isFrozen(p)).toBe(true);
  });
});
