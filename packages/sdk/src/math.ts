import type { Quaternion } from '@marionette/protocol';

/**
 * Plain-array 3D math for teleop, with no dependencies. Vectors are `[x, y, z]`; rotations are 3×3 matrices as
 * rows (`R[row][column]`, like numpy), so `matVec(R, v)` turns `v`. Quaternions are the protocol's `{ x, y, z, w }`.
 */
export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];
/** A position and an orientation, for an end effector or a phone. */
export type Pose = { position: Vec3; rotation: Mat3 };

export const identity = (): Mat3 => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
export const matVec = (m: Mat3, v: Vec3): Vec3 => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
export const transpose = (m: Mat3): Mat3 => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
export function matMul(a: Mat3, b: Mat3): Mat3 {
  const t = transpose(b);
  return [[dot(a[0], t[0]), dot(a[0], t[1]), dot(a[0], t[2])], [dot(a[1], t[0]), dot(a[1], t[1]), dot(a[1], t[2])], [dot(a[2], t[0]), dot(a[2], t[1]), dot(a[2], t[2])]];
}

/** The rotation matrix of a quaternion (normalized first). */
export function matrixFromQuaternion(q: Quaternion): Mat3 {
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1; const x = q.x / n, y = q.y / n, z = q.z / n, w = q.w / n;
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
}
/** A unit quaternion for a rotation matrix (either sign may come back). */
export function quaternionFromMatrix(m: Mat3): Quaternion {
  const trace = m[0][0] + m[1][1] + m[2][2]; let x: number, y: number, z: number, w: number;
  if (trace > 0) { const s = Math.sqrt(trace + 1) * 2; w = s / 4; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; w = (m[2][1] - m[1][2]) / s; x = s / 4; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s; }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = s / 4; z = (m[1][2] + m[2][1]) / s; }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = s / 4; }
  const n = Math.hypot(x, y, z, w) || 1;
  return { x: x / n, y: y / n, z: z / n, w: w / n };
}

/** The rotation vector (axis × angle, angle in 0..π) of a rotation matrix: the log map. */
export function rotationVector(m: Mat3): Vec3 {
  let { x, y, z, w } = quaternionFromMatrix(m);
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return [2 * x, 2 * y, 2 * z];
  const angle = 2 * Math.atan2(s, w);
  return [x / s * angle, y / s * angle, z / s * angle];
}
/** The rotation matrix of a rotation vector: the exponential map. */
export function expRotation(v: Vec3): Mat3 {
  const angle = norm(v);
  if (angle < 1e-12) return matrixFromQuaternion({ x: v[0] / 2, y: v[1] / 2, z: v[2] / 2, w: 1 });
  const s = Math.sin(angle / 2) / angle;
  return matrixFromQuaternion({ x: v[0] * s, y: v[1] * s, z: v[2] * s, w: Math.cos(angle / 2) });
}
