import fs from 'node:fs';
import path from 'node:path';
import { phoneAxes, rotateVector, type PosePacket, type PoseReference, type Quaternion, type Vector3 } from '@marionette/protocol';

export type DiagnosticRecord = { kind: string; msg?: string; [key: string]: unknown };
export type DiagnosticsLog = { file?: string; write: (record: DiagnosticRecord) => void; pose: (raw: PosePacket, output: PosePacket, phone?: string) => void; close: () => void };

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
/** Metres → millimetres, 0.1 mm resolution. */
export const mm = (v: Vector3) => [round(v.x * 1000, 1), round(v.y * 1000, 1), round(v.z * 1000, 1)];
const direction = (v: Vector3) => [round(v.x, 3), round(v.y, 3), round(v.z, 3)];
const quaternion = (q: Quaternion) => [round(q.x, 4), round(q.y, 4), round(q.z, 4), round(q.w, 4)];
const axes = (a: ReturnType<typeof phoneAxes>) => ({ top: direction(a.top), left: direction(a.left), screen: direction(a.screen) });

/** Where the phone's edges point: raw rotations in ARKit world axes, published rotations in operator axes. */
export const rawAxes = (pose: PosePacket) => axes(phoneAxes(pose.rotation, 'camera'));

/**
 * A reference frame's operator axes in ARKit world, plus its heading: the yaw of
 * calibrated forward from ARKit -Z (the uncalibrated forward), positive turning left.
 */
export function frameSummary(reference: PoseReference) {
  const forward = rotateVector(reference.frame, { x: 1, y: 0, z: 0 });
  return { mode: reference.mode, epoch: reference.epoch, forward: direction(forward), left: direction(rotateVector(reference.frame, { x: 0, y: 1, z: 0 })), up: direction(rotateVector(reference.frame, { x: 0, y: 0, z: 1 })),
    headingDeg: round(Math.atan2(-forward.x, -forward.z) * 180 / Math.PI, 1), originMm: mm(reference.position), originAxes: axes(phoneAxes(reference.rotation, 'camera')) };
}

/**
 * JSONL diagnostics for debugging frames on a real phone. Poses are sampled at
 * `poseHz` and carry both the raw ARKit pose and the published operator pose,
 * each with where the phone's top edge, left edge, and screen point. Every other
 * record (phone, calibration, session, tracking, hold) is written as it happens
 * and its `msg` is echoed to the console.
 */
export function createDiagnosticsLog(options: { dir: string; poseHz?: number }): DiagnosticsLog {
  fs.mkdirSync(options.dir, { recursive: true });
  const file = path.join(options.dir, `gateway-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const stream = fs.createWriteStream(file, { flags: 'a' });
  const poseIntervalMs = (options.poseHz ?? 10) > 0 ? 1000 / (options.poseHz ?? 10) : Infinity;
  // Sampled per phone, so two phones each get the full rate.
  const lastPoseAt = new Map<string, number>();
  const write = (record: DiagnosticRecord) => {
    stream.write(`${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`);
    if (record.kind !== 'pose' && record.msg) console.log(`[${record.kind}] ${record.msg}`);
  };
  const pose = (raw: PosePacket, output: PosePacket, phone = '') => {
    const now = performance.now(); if (now - (lastPoseAt.get(phone) ?? -Infinity) < poseIntervalMs) return; lastPoseAt.set(phone, now);
    write({ kind: 'pose', phone: phone || undefined, session: raw.sessionId, seq: raw.seq, tracking: raw.trackingState, source: raw.source, frame: output.calibrationVersion,
      raw: { mm: mm(raw.position), q: quaternion(raw.rotation), axes: rawAxes(raw) },
      out: { mm: mm(output.position), q: quaternion(output.rotation), axes: axes(phoneAxes(output.rotation, 'operator')) } });
  };
  return { file, write, pose, close: () => stream.end() };
}

export const noDiagnostics: DiagnosticsLog = { write: () => {}, pose: () => {}, close: () => {} };
export const deltaMm = (to: Vector3, from: Vector3) => mm({ x: to.x - from.x, y: to.y - from.y, z: to.z - from.z });
