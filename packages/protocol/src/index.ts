export const PROTOCOL_VERSION = 1 as const;

export type Vector3 = { x: number; y: number; z: number };
export type Quaternion = { x: number; y: number; z: number; w: number };
export type TrackingState = 'initializing' | 'normal' | 'limited' | 'relocalizing' | 'unavailable';
export function metersToMillimeters(v: Vector3): Vector3 { return { x: v.x * 1000, y: v.y * 1000, z: v.z * 1000 }; }

export type PosePacket = {
  type: 'pose'; version: typeof PROTOCOL_VERSION; sessionId: string; seq: number;
  monotonicTs: number; position: Vector3; rotation: Quaternion;
  covariance: number[]; source: 'arkit'; trackingState: TrackingState;
  calibrationVersion: string; heartbeat: boolean;
};

export type UiControl =
  | { id: string; type: 'button'; label: string; action: string; tone?: 'default' | 'danger' | 'accent' }
  | { id: string; type: 'toggle'; label: string; action: string; value: boolean }
  | { id: string; type: 'select'; label: string; action: string; value: string; options: { label: string; value: string }[] }
  | { id: string; type: 'slider'; label: string; action: string; value: number; min: number; max: number; step: number; unit?: string };

export type CameraStream = { id: string; label: string; url: string; status: 'live' | 'offline' };

export type ConfigMessage = {
  type: 'config'; version: typeof PROTOCOL_VERSION; sessionId: string; serverName: string;
  controls: UiControl[]; cameraStreams: CameraStream[]; activeCameraId?: string;
  calibration: { status: 'uncalibrated' | 'captured'; originSeq?: number };
  teleop: { enabled: boolean; translationScale: number; rotationScale: number; includeLift: boolean; activeArm: string };
};

export type ActionMessage = { type: 'action'; version: typeof PROTOCOL_VERSION; sessionId: string; controlId: string; action: string; value?: string | number | boolean; sentAt: number };
export type StatusMessage = { type: 'status'; version: typeof PROTOCOL_VERSION; sessionId: string; controlId?: string; message: string; values?: Record<string, string | number | boolean> };
export type CameraFrameMessage = { type: 'camera_frame'; version: typeof PROTOCOL_VERSION; sessionId: string; cameraId: string; dataUrl: string; capturedAt: number };
export type MarionetteMessage = PosePacket | ConfigMessage | ActionMessage | StatusMessage | CameraFrameMessage;

export function isFiniteVector(v: Vector3): boolean { return [v.x, v.y, v.z].every(Number.isFinite); }
export function isFiniteQuaternion(q: Quaternion): boolean { return [q.x, q.y, q.z, q.w].every(Number.isFinite); }
export function normalizeQuaternion(q: Quaternion): Quaternion {
  const norm = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(norm) || norm < 1e-9) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: q.x / norm, y: q.y / norm, z: q.z / norm, w: q.w / norm };
}
export function validatePose(packet: unknown): packet is PosePacket {
  if (!packet || typeof packet !== 'object') return false;
  const p = packet as Partial<PosePacket>;
  return p.type === 'pose' && p.version === PROTOCOL_VERSION && typeof p.sessionId === 'string' && p.sessionId.length > 0
    && Number.isInteger(p.seq) && Number.isFinite(p.seq) && (p.seq as number) >= 0 && Number.isFinite(p.monotonicTs)
    && !!p.position && isFiniteVector(p.position) && !!p.rotation && isFiniteQuaternion(p.rotation)
    && Array.isArray(p.covariance) && p.covariance.length > 0 && p.covariance.every(Number.isFinite)
    && (p.source === 'arkit') && typeof p.trackingState === 'string' && typeof p.calibrationVersion === 'string' && typeof p.heartbeat === 'boolean';
}

export function poseFromTransform(values: number[], sessionId: string, seq: number, monotonicTs: number, trackingState: TrackingState = 'normal'): PosePacket {
  if (values.length !== 16) throw new Error('ARKit transform must contain 16 values');
  return { type: 'pose', version: PROTOCOL_VERSION, sessionId, seq, monotonicTs,
    position: { x: values[12], y: values[13], z: values[14] },
    rotation: matrixToQuaternion(values), covariance: [0.0025, 0.0025, 0.0025, 0.01, 0.01, 0.01], source: 'arkit', trackingState, calibrationVersion: 'arkit-v1', heartbeat: true };
}

export function matrixToQuaternion(m: number[]): Quaternion {
  const trace = m[0] + m[5] + m[10]; let x: number; let y: number; let z: number; let w: number;
  if (trace > 0) { const s = Math.sqrt(trace + 1) * 2; w = 0.25 * s; x = (m[6] - m[9]) / s; y = (m[8] - m[2]) / s; z = (m[1] - m[4]) / s; }
  else if (m[0] > m[5] && m[0] > m[10]) { const s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2; w = (m[6] - m[9]) / s; x = 0.25 * s; y = (m[4] + m[1]) / s; z = (m[8] + m[2]) / s; }
  else if (m[5] > m[10]) { const s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2; w = (m[8] - m[2]) / s; x = (m[4] + m[1]) / s; y = 0.25 * s; z = (m[9] + m[6]) / s; }
  else { const s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2; w = (m[1] - m[4]) / s; x = (m[8] + m[2]) / s; y = (m[9] + m[6]) / s; z = 0.25 * s; }
  return normalizeQuaternion({ x, y, z, w });
}

export const defaultConfig = (): ConfigMessage => ({ type: 'config', version: PROTOCOL_VERSION, sessionId: '', serverName: 'Marionette local gateway',
  controls: [
    { id: 'deadman', type: 'toggle', label: 'Teleop enable', action: 'teleop.toggle', value: false },
    { id: 'arm', type: 'select', label: 'Active arm', action: 'arm.select', value: 'left', options: [{ label: 'Left arm', value: 'left' }, { label: 'Right arm', value: 'right' }] },
    { id: 'lift', type: 'toggle', label: 'Include lift', action: 'lift.toggle', value: true },
    { id: 'sensitivity', type: 'slider', label: 'Translation scale', action: 'teleop.translationScale', value: 1, min: 0.1, max: 4, step: 0.1, unit: '×' },
    { id: 'capture-origin', type: 'button', label: 'Capture phone origin', action: 'calibration.captureOrigin', tone: 'accent' },
    { id: 'reset-origin', type: 'button', label: 'Reset calibration', action: 'calibration.reset' },
    { id: 'camera-main', type: 'button', label: 'Show camera', action: 'camera.select', tone: 'accent' },
    { id: 'estop', type: 'button', label: 'E-stop', action: 'safety.estop', tone: 'danger' },
  ], cameraStreams: [{ id: 'sim', label: 'Virtual camera', url: 'sim://camera', status: 'live' }], activeCameraId: 'sim', calibration: { status: 'uncalibrated' }, teleop: { enabled: false, translationScale: 1, rotationScale: 1, includeLift: true, activeArm: 'left' } });
