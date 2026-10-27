import { PROTOCOL_VERSION, defaultConfig, nominalCovariance, type CalibrationState, type ConfigMessage, type ControlValue, type InputMessage, type JsonValue, type PhoneInfo, type PosePacket,
  type Quaternion, type RobotStateMessage, type UiControl, type Vector3 } from '@marionette/protocol';

/** The gateway session the builders use unless told otherwise. */
export const TEST_GATEWAY = 'marionette-test';
let clock = 1_000_000;
const stamp = () => ++clock;

/**
 * Builders for the messages a gateway sends to consoles and robots, so tests don't write them by hand. Each takes the
 * fields that matter and fills in the rest as the gateway would; `extra` overrides anything.
 */
export const messages = {
  /** A roster entry: `phone('phone-2', { connected: false })`. */
  phone(id = 'phone-1', extra: Partial<PhoneInfo> = {}): PhoneInfo {
    const n = Number(/-(\d+)$/.exec(id)?.[1] ?? 1);
    return { id, name: `Phone ${n}`, color: n === 1 ? '#c98200' : n === 2 ? '#b04fc4' : '#6b6f73', connected: true, sessionId: `iphone-${id}`, ...extra };
  },
  /**
   * A config: the gateway's view, or one phone's with `phone` (its values with `values`, by control id, and its holds and
   * drags with `held` and `live`). The layout is the default one unless `controls` is given.
   */
  config(options: { sessionId?: string; phones?: PhoneInfo[]; phone?: PhoneInfo | string; controls?: UiControl[]; values?: Record<string, ControlValue>; held?: string[]; live?: string[];
    calibration?: Partial<CalibrationState> } = {}): ConfigMessage {
    const base = defaultConfig(); const phone = typeof options.phone === 'string' ? messages.phone(options.phone) : options.phone;
    const phones = options.phones ?? (phone ? [phone] : []);
    let controls = structuredClone(options.controls ?? base.controls);
    if (phone) controls = controls.map(control => {
      const value = options.values?.[control.id];
      const own = (value !== undefined && 'value' in control ? { ...control, value } : control) as UiControl;
      if (own.type === 'button') return own.hold ? { ...own, held: !!options.held?.includes(own.id) } : own;
      return own.type === 'slider' || own.type === 'joystick' ? { ...own, live: !!options.live?.includes(own.id) } : own;
    });
    return { ...base, sessionId: options.sessionId ?? TEST_GATEWAY, serverName: 'test', controls, phones, ...(phone ? { phone } : {}),
      calibration: { status: 'uncalibrated', epoch: 0, ...options.calibration } };
  },
  /** A forwarded pose in the phone's operator frame. */
  pose(phoneId = 'phone-1', extra: Partial<PosePacket> & { position?: Vector3; rotation?: Quaternion } = {}): PosePacket {
    const trackingState = extra.trackingState ?? 'normal';
    return { type: 'pose', version: PROTOCOL_VERSION, phoneId, sessionId: `iphone-${phoneId}`, seq: stamp(), monotonicTs: clock / 1000, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
      covariance: nominalCovariance(trackingState), source: 'arkit', trackingState, calibrationVersion: 'arkit-gravity-v2', heartbeat: true, receivedAt: Date.now(), ...extra };
  },
  /** An input as the gateway relays it: `input('phone-1', 'teleop.deadman', true, { renew: true })`. */
  input(phoneId: string, action: string, value?: ControlValue, extra: Partial<InputMessage> = {}): InputMessage {
    const controlId = defaultConfig().controls.find(control => control.action === action)?.id ?? action;
    return { type: 'input', version: PROTOCOL_VERSION, phoneId, sessionId: `iphone-${phoneId}`, controlId, action, ...(value !== undefined ? { value } : {}), source: 'phone', receivedAt: Date.now(), ...extra };
  },
  /** A relayed robot state. */
  robotState(state: Record<string, JsonValue>, extra: Partial<RobotStateMessage> = {}): RobotStateMessage {
    return { type: 'robot_state', version: PROTOCOL_VERSION, robotId: 'robot', state, receivedAt: Date.now(), ...extra };
  },
};
