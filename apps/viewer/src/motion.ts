import { dominantAxis, phoneAxes, type AxisLabel, type CalibrationStep, type PosePacket, type PoseSource, type Quaternion, type TrackingState, type Vector3 } from '@marionette/protocol';

/** One published position, stamped with the viewer's clock (ms) and the frame it is expressed in. */
export type Sample = { t: number; p: Vector3; key: string };

export const AXIS_WORD: Record<AxisLabel, string> = { '+X': 'forward', '-X': 'back', '+Y': 'left', '-Y': 'right', '+Z': 'up', '-Z': 'down' };
export const TRACKING_WORDS: Record<TrackingState, string> = { normal: 'Tracking good', limited: 'Tracking limited', initializing: 'Tracking starting', relocalizing: 'Relocalizing', unavailable: 'No tracking' };
const TRACKING_VALUE: Record<TrackingState, string> = { normal: 'Good', limited: 'Limited', initializing: 'Starting', relocalizing: 'Relocalizing', unavailable: 'None' };
const SOURCE_WORDS: Record<PoseSource, string> = { arkit: 'ARKit', 'device-motion': 'device motion', synthetic: 'synthetic' };
/** The value of a "Tracking" row: "Good, ARKit", "Limited, synthetic". */
export function trackingValue(state: TrackingState, source: PoseSource): string {
  return state === 'unavailable' ? 'None' : `${TRACKING_VALUE[state]}, ${SOURCE_WORDS[source] ?? source}`;
}

const MINUS = '−';
/** "+12.4", "−3.1", "0.0": a real minus sign, and never a negative zero. */
export function signed(n: number, digits = 0): string {
  const fixed = Math.abs(n).toFixed(digits);
  if (Number(fixed) === 0) return (0).toFixed(digits);
  return `${n < 0 ? MINUS : '+'}${fixed}`;
}
export function axisText(label: AxisLabel): string { return label.replace('-', MINUS); }

/**
 * Poses from different phone sessions or calibration epochs are in different
 * frames, so a trail or plot line must never join them.
 */
export function frameKey(pose: PosePacket): string { return `${pose.sessionId}|${pose.calibrationVersion.replace(/-stale$/, '')}`; }

/** Drops samples older than `cutoff`. Samples are kept in time order. */
export function trimBefore(samples: { t: number }[], cutoff: number): void {
  let drop = 0;
  while (drop < samples.length && samples[drop].t < cutoff) drop++;
  if (drop) samples.splice(0, drop);
}

export type Motion = { state: 'unknown' } | { state: 'still' } | { state: 'moving'; axis: AxisLabel; words: string; mm: number };
/**
 * Dominant direction of the last `windowMs` of motion, so a move can be read
 * off without trusting a perspective view. Below `stillMm` the phone is still.
 */
export function recentMotion(samples: Sample[], now: number, windowMs = 500, stillMm = 15): Motion {
  const last = samples.at(-1);
  if (!last || now - last.t > 1000) return { state: 'unknown' };
  let first: Sample | undefined;
  for (let i = samples.length - 1; i >= 0; i--) {
    const sample = samples[i];
    if (sample.key !== last.key || last.t - sample.t > windowMs) break;
    first = sample;
  }
  if (!first || last.t - first.t < windowMs * 0.6) return { state: 'unknown' };
  const d = { x: last.p.x - first.p.x, y: last.p.y - first.p.y, z: last.p.z - first.p.z };
  const mm = Math.hypot(d.x, d.y, d.z) * 1000;
  if (mm < stillMm) return { state: 'still' };
  const axis = dominantAxis(d);
  return { state: 'moving', axis, words: AXIS_WORD[axis], mm };
}

/**
 * How far the phone has moved for a guided calibration step, in mm, measured
 * from the flat reference (`anchor`, in the frame poses are published in):
 * horizontal distance for forward and right, rise for up.
 */
export function stepProgressMm(step: CalibrationStep, position: Vector3, anchor?: Vector3): number | undefined {
  if (step === 'flat' || !anchor) return undefined;
  if (step === 'up') return (position.z - anchor.z) * 1000;
  return Math.hypot(position.x - anchor.x, position.y - anchor.y) * 1000;
}

/** Angle between the screen and straight up, in degrees: 0 is flat, screen up. */
export function tiltDegrees(rotation: Quaternion): number {
  const screen = phoneAxes(rotation, 'operator').screen;
  return Math.acos(Math.max(-1, Math.min(1, screen.z))) * 180 / Math.PI;
}

/** A tick step of 1, 2, 2.5 or 5 × 10ⁿ that splits `span` into about `ticks` parts. */
export function niceStep(span: number, ticks = 4): number {
  const raw = Math.max(span, 1e-9) / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const n = raw / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * power;
}

/** A y range that includes zero and the data, at least `minSpan` tall, snapped to about `ticks` clean steps. */
export function niceRange(min: number, max: number, minSpan = 20, ticks = 4): { lo: number; hi: number; step: number } {
  let lo = Math.min(0, min), hi = Math.max(0, max);
  if (hi - lo < minSpan) { lo = Math.min(lo, -minSpan / 2); hi = Math.max(hi, minSpan / 2); }
  const step = niceStep(hi - lo, ticks);
  return { lo: Math.floor(lo / step + 1e-9) * step, hi: Math.ceil(hi / step - 1e-9) * step, step };
}
