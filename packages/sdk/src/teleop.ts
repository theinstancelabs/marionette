import { add, dot, expRotation, identity, matMul, matVec, norm, rotationVector, scale, sub, transpose, type Mat3, type Pose, type Vec3 } from './math.js';
import type { Phone } from './tracker.js';

/**
 * Teleop safety and clutch parts, with the numbers Axol drives with. Marionette decides nothing about motion: these are
 * pieces a robot's own control loop calls, not a loop to live inside.
 */
export const TELEOP_DEFAULTS = {
  /** Fastest the target moves (m/s), speeds up or slows down (m/s²), turns (rad/s), and changes its turn rate (rad/s²). */
  maxSpeed: 0.5, maxAccel: 3, maxTurnRate: 3, maxTurnAccel: 20,
  /** Phone rotation to target rotation at motion scale 1 (1: the same angle); the motion scale multiplies it. */
  rotationScale: 1,
  /** A pose older than this (ms) can't drive. */
  poseTimeoutMs: 250,
  /** A hold counts as released after this long (ms) without a renewal (the phone renews every 200 ms). */
  holdTimeoutMs: 600,
  /** A live stick with no sample for this long (ms) is a dead source (the phone repeats every 50 ms). */
  stickTimeoutMs: 250,
  /** A pose step larger than `jumpM` (m) faster than `jumpSpeed` (m/s), or a turn larger than `jumpRad` faster than 5 × `jumpSpeed` rad/s, is a tracking jump. */
  jumpM: 0.04, jumpRad: 0.5, jumpSpeed: 4,
} as const;

/** What a pose needs for the clutch and the jump detector; the tracker's `PhonePose` has it all. */
export type PoseLike = { position: Vec3; rotation: Mat3; session?: string; calibration?: string; seq?: number; stamp?: number };

export type GateOptions = {
  /** A pose older than this (ms, default 250) can't drive. */
  poseTimeoutMs?: number;
  /** Refuse a pose whose trip from the phone to the gateway took longer (ms). Off by default; the age covers it. */
  maxLatencyMs?: number;
  /** Let simulated motion (`synthetic`) drive, in a simulation only. */
  allowSynthetic?: boolean;
  /** Refuse a phone that hasn't been calibrated (an uncalibrated phone's forward is wherever ARKit started). */
  requireCalibration?: boolean;
};
/**
 * Why this phone's pose can't drive right now, or undefined when it can: offline, calibrating, not calibrated (if
 * required), no fresh pose, a slow link (if limited), simulated motion, no ARKit, or tracking that isn't normal.
 * `now` is the tracker's clock.
 */
export function gate(phone: Phone | undefined, now: number, options: GateOptions = {}): string | undefined {
  if (!phone || !phone.connected) return 'This phone is offline.';
  if (phone.calibration === 'capturing') return 'Finish or cancel calibration first.';
  if (options.requireCalibration && phone.calibration !== 'captured') return 'Calibrate this phone first, facing the way the robot faces.';
  const pose = phone.pose;
  if (!pose || pose.age(now) > (options.poseTimeoutMs ?? TELEOP_DEFAULTS.poseTimeoutMs)) return 'No pose from this phone. Keep the app open.';
  if (options.maxLatencyMs !== undefined && pose.latencyMs !== undefined && pose.latencyMs > options.maxLatencyMs) return `The link to this phone is too slow (${Math.round(pose.latencyMs)} ms).`;
  const synthetic = pose.source === 'synthetic';
  if (synthetic && !options.allowSynthetic) return "Simulated motion can't move the robot.";
  if (pose.source !== 'arkit' && !synthetic) return 'This phone has no ARKit tracking.';
  if (pose.tracking === 'initializing') return 'Tracking is starting. Move the phone gently.';
  if (pose.tracking === 'relocalizing') return 'Tracking is finding its place. Hold still for a moment.';
  if (pose.tracking !== 'normal' && !synthetic) return 'Tracking is limited. Point the camera at something with texture.';
  return undefined;
}

// The phone's axes (+X forward, +Y left, +Z up) in a camera's ROS optical frame (+Z along the view, +X to the image's
// right, +Y down it): forward is along the view, left and up are the image's.
const PHONE_IN_OPTICAL: Mat3 = [[0, -1, 0], [0, 0, -1], [1, 0, 0]];
/**
 * `F` for moving in a camera's frame, from the rotation of its optical frame in the robot's frame: the phone's
 * forward goes along the camera's view, its left and up to the image's.
 */
export function cameraFrame(optical: Mat3): Mat3 { return matMul(optical, PHONE_IN_OPTICAL); }

/**
 * The rotation vector for `turn`'s rotation that is closest to `previous`. A rotation vector is unique only up to
 * whole turns about its axis, and past half a turn the axis flips; scaled, that flip would jump the target. Picking
 * the vector nearest the last one follows a turn of any size smoothly.
 */
export function unwrapTurn(turn: Vec3, previous: Vec3): Vec3 {
  let angle = norm(turn); let axis: Vec3;
  if (angle > 1e-9) axis = scale(turn, 1 / angle);
  else { const size = norm(previous); if (size < 1e-9) return [...turn]; axis = scale(previous, 1 / size); angle = 0; }
  const whole = Math.round((dot(previous, axis) - angle) / (2 * Math.PI));
  return scale(axis, angle + 2 * Math.PI * whole);
}

export type ClutchOptions = { rotationScale?: number };
export type EngageOptions = {
  /** The motion scale `s`, for moves and turns alike (default 1). */
  scale?: number;
  /** `F`: the phone's operator frame in the robot's frame (default identity; `cameraFrame()` for a camera's). */
  frame?: Mat3;
};
/**
 * Relative teleop. `engage` records the phone pose `P0` and the end effector pose `E0`; nothing moves. Then, for each
 * phone pose `P`:
 *
 *     p = E0.p + s · F · (P.p − P0.p)
 *     R = exp(r · s · F · θ) · E0.R,   θ = the turn P.R · P0.Rᵀ as a rotation vector, unwrapped continuously
 *
 * `rescale` and `reframe` take up a new scale or frame from where the target is now, so they never move it.
 * `anchorValid` says whether the anchor still describes the phone's world (same ARKit session and calibration).
 */
export class Clutch {
  engaged = false;
  scale = 1;
  rotationScale: number;
  frame: Mat3 = identity();
  private anchor?: { phone: PoseLike; tip: Pose };
  private turn: Vec3 = [0, 0, 0];

  constructor(options: ClutchOptions = {}) { this.rotationScale = options.rotationScale ?? TELEOP_DEFAULTS.rotationScale; }

  engage(phone: PoseLike, tip: Pose, options: EngageOptions = {}): void {
    this.anchor = { phone, tip: copyPose(tip) }; this.turn = [0, 0, 0];
    this.scale = options.scale ?? 1; this.frame = options.frame ?? identity(); this.engaged = true;
  }
  /** The target for this phone pose. With `scale`, a changed scale is taken up first (`rescale`). */
  target(phone: PoseLike, scale?: number): Pose {
    if (!this.anchor) throw new Error('Clutch.target: engage first');
    if (scale !== undefined && scale !== this.scale) this.rescale(phone, scale);
    return this.goal(phone);
  }
  /** A new motion scale from here on, without moving the target. */
  rescale(phone: PoseLike, scale: number): void { this.reanchor(phone); this.scale = scale; }
  /** A new frame `F` from here on (identity when undefined), without moving the target. */
  reframe(phone: PoseLike, frame?: Mat3): void { this.reanchor(phone); this.frame = frame ?? identity(); }
  /** The anchor still describes the same ARKit world and calibration as this pose. */
  anchorValid(phone: PoseLike | null | undefined): boolean {
    const anchor = this.anchor?.phone;
    return !!anchor && !!phone && phone.session === anchor.session && phone.calibration === anchor.calibration;
  }
  /** Stop following; the next engage anchors afresh. */
  release(): void { this.engaged = false; this.anchor = undefined; this.turn = [0, 0, 0]; }

  private goal(phone: PoseLike): Pose {
    const { phone: p0, tip } = this.anchor!;
    this.turn = unwrapTurn(rotationVector(matMul(phone.rotation, transpose(p0.rotation))), this.turn);
    const s = this.scale;
    return { position: add(tip.position, scale(matVec(this.frame, sub(phone.position, p0.position)), s)),
      rotation: matMul(expRotation(scale(matVec(this.frame, this.turn), this.rotationScale * s)), tip.rotation) };
  }
  private reanchor(phone: PoseLike): void {
    if (!this.anchor) return;
    this.anchor = { phone, tip: this.goal(phone) }; this.turn = [0, 0, 0];
  }
}
const copyPose = (pose: Pose): Pose => ({ position: [...pose.position], rotation: pose.rotation.map(row => [...row]) as Mat3 });

export type JumpOptions = { jumpM?: number; jumpRad?: number; jumpSpeed?: number };
/**
 * ARKit corrects itself in steps now and then while still reporting normal tracking. A step faster than a hand moves
 * is treated as one, so the robot can stop instead of following it. Feed it every pose while engaged.
 */
export class JumpDetector {
  private last?: PoseLike;
  private readonly jumpM: number; private readonly jumpRad: number; private readonly jumpSpeed: number;
  constructor(options: JumpOptions = {}) {
    this.jumpM = options.jumpM ?? TELEOP_DEFAULTS.jumpM; this.jumpRad = options.jumpRad ?? TELEOP_DEFAULTS.jumpRad; this.jumpSpeed = options.jumpSpeed ?? TELEOP_DEFAULTS.jumpSpeed;
  }
  /** Whether the pose jumped since the last one seen (the same pose again, or one from another session, never does). */
  check(pose: PoseLike | null | undefined): boolean {
    if (!pose) return false;
    const last = this.last;
    if (last === pose || (last && last.seq !== undefined && last.seq === pose.seq && last.session === pose.session)) return false;
    this.last = pose;
    if (!last || last.session !== pose.session) return false;
    const dt = Math.max((pose.stamp ?? 0) - (last.stamp ?? 0), 1e-3);
    const distance = norm(sub(pose.position, last.position));
    const angle = norm(rotationVector(matMul(pose.rotation, transpose(last.rotation))));
    return (distance > this.jumpM && distance / dt > this.jumpSpeed) || (angle > this.jumpRad && angle / dt > 5 * this.jumpSpeed);
  }
  /** Starts again from `pose` (on engage) or from nothing (on release). */
  reset(pose?: PoseLike | null): void { this.last = pose ?? undefined; }
}

/**
 * New presses of one button, each consumed once: `pressed(phone)` is true once per press made since the last look, so
 * a press refused (Stop on, bad tracking) never acts later on its own. Presses made before a phone was first seen
 * don't count.
 */
export class PressTracker {
  private readonly seen = new Map<string, number>();
  constructor(readonly action: string) {}
  pressed(phone: Phone): boolean {
    const count = phone.presses(this.action); const seen = this.seen.get(phone.id);
    this.seen.set(phone.id, count);
    return seen !== undefined && count > seen;
  }
  /** Marks this phone's presses as seen without acting on them. */
  forget(phone: Phone): void { this.seen.set(phone.id, phone.presses(this.action)); }
}

/**
 * The next velocity toward a target `error` away: speeds up and slows down at `accel` at most, never faster than
 * `top`, and slow enough to stop at the target instead of overshooting it; within one tick of it, it lands there.
 * Call it per tick for position (m/s) or for turns (rotation vectors, rad/s).
 */
export function follow(error: Vec3, velocity: Vec3, top: number, accel: number, dt: number): Vec3 {
  const distance = norm(error);
  if (distance < 1e-9) return [0, 0, 0];
  const direction = scale(error, 1 / distance);
  const speed = Math.min(top, Math.sqrt(2 * accel * distance), distance / dt);
  let change = sub(scale(direction, speed), velocity);
  const size = norm(change); const step = accel * dt;
  if (size > step) change = scale(change, step / size);
  let next = add(velocity, change);
  // Never step past the target.
  if (dot(next, direction) * dt > distance) next = scale(direction, distance / dt);
  return next;
}

export type OwnersOptions = {
  /** What can be owned (default `['left', 'right']`). */
  choices?: readonly string[];
  /** What a phone selects (default its `arm.select`, `left` unless `right`). */
  choose?: (phone: Phone) => string | undefined;
};
/**
 * An opt-in policy: which connected phone has each choice (an arm, say). `current` maps each choice to the phone that
 * engaged it most recently, which keeps it while it still selects it; otherwise the lowest-numbered phone selecting it
 * has it.
 */
export function owners(phones: Iterable<Phone>, current: Record<string, string | null | undefined>, options: OwnersOptions = {}): Record<string, Phone | undefined> {
  const choose = options.choose ?? ((phone: Phone) => phone.choice('arm.select', ['left', 'right'], 'left'));
  const connected = [...phones].filter(phone => phone.connected);
  const result: Record<string, Phone | undefined> = {};
  for (const choice of options.choices ?? ['left', 'right']) {
    const candidates = connected.filter(phone => choose(phone) === choice);
    result[choice] = candidates.find(phone => phone.id === current[choice]) ?? candidates.sort((a, b) => a.ordinal - b.ordinal)[0];
  }
  return result;
}
