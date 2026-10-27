import { defaultConfig, normalizeQuaternion, phoneColor, type ConfigMessage, type JsonValue, type PhoneInfo, type PosePacket, type RobotInfo, type RobotStateMessage, type StickValue } from '@marionette/protocol';

/**
 * Two simulated phones for the connect page's "simulate" link: Phone 1 on the
 * left arm and Phone 2 on the right, each with its own motion and a hold it
 * presses now and then. Phone 1 also drives the base with its stick now and
 * then. A simulated robot reports its state five times a second. Nothing here
 * reaches a gateway or a robot.
 */
export const SIM_PHONES = [
  { id: 'phone-1', name: 'Phone 1', arm: 'left', hold: { control: 'deadman', start: 2, period: 9, length: 3.5 } },
  { id: 'phone-2', name: 'Phone 2', arm: 'right', hold: { control: 'grip', start: 4.5, period: 7, length: 1.2 } },
] as const;
export const SIM_ROBOT: RobotInfo = { id: 'sim-robot', name: 'Sim robot', connected: true, screen: true, streams: [] };
export const SIM_ROBOT_EVERY_MS = 200;

export function simulatedRoster(): PhoneInfo[] {
  return SIM_PHONES.map((phone, index) => ({ id: phone.id, name: phone.name, color: phoneColor(index), connected: true, sessionId: `sim-${phone.id}` }));
}

export function simulatedGatewayConfig(roster: PhoneInfo[]): ConfigMessage {
  return { ...defaultConfig(), sessionId: 'sim', serverName: 'Simulated phones', cameraStreams: [], cameraViews: [], phones: roster, robots: [{ ...SIM_ROBOT }] };
}

const round = (n: number, digits = 3) => Number(n.toFixed(digits)) || 0;
/**
 * The simulated robot's state `t` seconds in: with `phoneIndex`, what it tells that phone (its arm, whether the arm
 * follows, how far behind it is); without, its global state, with nested objects, lists and an unknown (`null`) lift.
 */
export function simulatedRobotState(t: number, phoneIndex?: number): RobotStateMessage {
  let state: { [key: string]: JsonValue };
  if (phoneIndex !== undefined) {
    const sim = SIM_PHONES[phoneIndex]; const following = simulatedHolds(phoneIndex, t).length > 0;
    state = { arm: sim.arm, following, trackingError: { mm: round(following ? 4 + 3 * Math.sin(t * 2.1 + phoneIndex) : 0, 1) }, reach: 'ok' };
  } else {
    const arm = (phase: number) => ({ joints: Array.from({ length: 6 }, (_, j) => round(Math.sin(t * 0.4 + phase + j) * 0.8, 3)), gripper: round(0.5 + 0.5 * Math.sin(t * 0.7 + phase), 2) });
    state = { mode: 'teleop', battery: { percent: Math.max(5, Math.round(86 - t / 60)), charging: false }, arms: { left: arm(0), right: arm(1.5) },
      base: { velocity: { x: round(simulatedStick(0, t)?.x ?? 0, 2), yaw: 0 } }, lift: null, faults: [] };
  }
  return { type: 'robot_state', version: 1, robotId: SIM_ROBOT.id, ...(phoneIndex !== undefined ? { phoneId: SIM_PHONES[phoneIndex].id } : {}), state, everyMs: SIM_ROBOT_EVERY_MS };
}

/** A simulated phone's own config: the default layout with its arm selected. */
export function simulatedConfig(index: number, roster: PhoneInfo[]): ConfigMessage {
  const base = defaultConfig(); const sim = SIM_PHONES[index];
  return { ...base, sessionId: `sim-${sim.id}`, serverName: 'Simulated phones', cameraStreams: [], cameraViews: [], phone: roster[index], phones: roster,
    controls: base.controls.map(control => control.action === 'arm.select' && control.type === 'select' ? { ...control, value: sim.arm } : control) };
}

/** The hold buttons simulated phone `index` is holding `t` seconds in. */
export function simulatedHolds(index: number, t: number): string[] {
  const { hold } = SIM_PHONES[index]; if (t < hold.start) return [];
  return (t - hold.start) % hold.period < hold.length ? [hold.control] : [];
}

/** Where simulated phone `index` is pushing its drive stick `t` seconds in, or undefined while it is let go. */
export function simulatedStick(index: number, t: number): StickValue | undefined {
  const start = 6, period = 12, length = 4;
  if (index !== 0 || t < start || (t - start) % period >= length) return undefined;
  // Ease forward, sweep left and right, then ease off; never longer than 1.
  const k = (t - start) % period / length; const push = Math.sin(Math.PI * k) * 0.85;
  const round = (n: number) => Math.trunc(n * 100) / 100 || 0;
  return { x: round(push * Math.cos(Math.sin(k * 2 * Math.PI) * 0.9)), y: round(push * Math.sin(Math.sin(k * 2 * Math.PI) * 0.9)) };
}

const clock = () => typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() / 1000 : Date.now() / 1000;

/** A simulated link latency, ms: a few ms over Wi-Fi with some jitter, Phone 2 a little further away. */
export const simulatedLatency = (index: number, t: number, seq: number) => round(6 + index * 9 + 2.5 * Math.sin(t * 1.3 + index) + (seq % 11 === 0 ? 9 : 0), 1);

/** Simulated poses are already in the operator frame (ROS REP-103): +X forward, +Y left, +Z up. */
export function simulationPose(index: number, t: number, seq: number): PosePacket {
  const sim = SIM_PHONES[index] ?? SIM_PHONES[0];
  const first = index % 2 === 0;
  const position = first
    ? { x: Math.sin(t * 0.9) * 0.12, y: Math.cos(t * 0.9) * 0.07, z: 0.1 + Math.sin(t * 0.63) * 0.06 }
    : { x: Math.sin(t * 0.55 + 2) * 0.08 + Math.sin(t * 1.7) * 0.025, y: Math.sin(t * 1.1 + 1) * 0.05, z: 0.07 + Math.sin(t * 0.8 + 0.5) * 0.04 };
  const rotation = first
    ? normalizeQuaternion({ x: Math.sin(t * 0.55) * 0.2, y: Math.sin(t * 0.45) * 0.12, z: Math.sin(t * 0.35) * 0.25, w: 0.97 })
    : normalizeQuaternion({ x: Math.sin(t * 0.8 + 1) * 0.12, y: Math.sin(t * 0.3) * 0.18, z: -0.18 + Math.sin(t * 0.5) * 0.1, w: 0.97 });
  return { type: 'pose', version: 1, sessionId: `sim-${sim.id}`, seq, monotonicTs: clock(), position, rotation,
    covariance: [0.0025, 0.0025, 0.0025, 0.01, 0.01, 0.01], source: 'synthetic', trackingState: 'normal', calibrationVersion: 'simulation', heartbeat: true, phoneId: sim.id, latencyMs: simulatedLatency(index, t, seq) };
}
