import { defaultConfig, normalizeQuaternion, phoneColor, type ConfigMessage, type PhoneInfo, type PosePacket } from '@marionette/protocol';

/**
 * Two simulated phones for the connect page's "simulate" link: Phone 1 on the
 * left arm and Phone 2 on the right, each with its own motion and a hold it
 * presses now and then. Nothing here reaches a gateway or a robot.
 */
export const SIM_PHONES = [
  { id: 'phone-1', name: 'Phone 1', arm: 'left', hold: { control: 'deadman', start: 2, period: 9, length: 3.5 } },
  { id: 'phone-2', name: 'Phone 2', arm: 'right', hold: { control: 'grip', start: 4.5, period: 7, length: 1.2 } },
] as const;

export function simulatedRoster(): PhoneInfo[] {
  return SIM_PHONES.map((phone, index) => ({ id: phone.id, name: phone.name, color: phoneColor(index), connected: true, sessionId: `sim-${phone.id}` }));
}

export function simulatedGatewayConfig(roster: PhoneInfo[]): ConfigMessage {
  return { ...defaultConfig(), sessionId: 'sim', serverName: 'Simulated phones', cameraStreams: [], cameraViews: [], phones: roster };
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

const clock = () => typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() / 1000 : Date.now() / 1000;

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
    covariance: [0.0025, 0.0025, 0.0025, 0.01, 0.01, 0.01], source: 'synthetic', trackingState: 'normal', calibrationVersion: 'simulation', heartbeat: true, phoneId: sim.id };
}
