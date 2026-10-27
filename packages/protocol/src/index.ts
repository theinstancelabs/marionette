export const PROTOCOL_VERSION = 1 as const;
export const HTML_CONFIG_VERSION = 1 as const;
export const HTML_BRIDGE_VERSION = 1 as const;
export const MAX_HTML_CONFIG_BYTES = 512_000;

export type Vector3 = { x: number; y: number; z: number };
export type Quaternion = { x: number; y: number; z: number; w: number };
export type TrackingState = 'initializing' | 'normal' | 'limited' | 'relocalizing' | 'unavailable';
export function metersToMillimeters(v: Vector3): Vector3 { return { x: v.x * 1000, y: v.y * 1000, z: v.z * 1000 }; }

export type GuidedStep = 'flat' | 'forward' | 'right' | 'up';
/** Guided calibration capture steps, in order. Validation moves are separate (`CheckMove`). */
export type CalibrationStep = GuidedStep;
export type CheckMove = 'forward' | 'right' | 'up';
export type CalibrationSample = { position: Vector3; rotation: Quaternion; seq: number; sessionId: string };
export type AxisLabel = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';
/** One validation move and where it actually went in the operator frame. */
export type CalibrationCheckResult = { move: CheckMove; expected: AxisLabel; dominant: AxisLabel; displacement: Vector3; passed: boolean };
/**
 * A calibrated operator frame captured from one phone session. `frame` maps
 * operator-frame vectors (+X forward, +Y left, +Z up) into ARKit world
 * coordinates; `position`/`rotation` are the raw ARKit reference sample.
 */
export type PoseReference = { mode: 'quick' | 'guided'; sessionId: string; epoch: number; position: Vector3; rotation: Quaternion; frame: Quaternion };

export function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  return normalizeQuaternion({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  });
}

export function conjugateQuaternion(q: Quaternion): Quaternion { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }

export function rotateVector(q: Quaternion, v: Vector3): Vector3 {
  const p = { x: v.x, y: v.y, z: v.z, w: 0 };
  const rotated = multiplyRawQuaternions(multiplyRawQuaternions(q, p), conjugateQuaternion(q));
  return { x: rotated.x, y: rotated.y, z: rotated.z };
}

function multiplyRawQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

// Frame conventions (ROS REP-103). ARKit's camera frame is fixed to the
// sensor's landscape orientation: +X runs along the long edge toward the bottom
// of a portrait iPhone, +Y toward its right edge, and +Z out of the screen.
// Marionette's phone body frame is +X top edge, +Y left edge, +Z out of the
// screen, which is the camera frame turned 180° about Z.
const CAMERA_TO_BODY: Quaternion = { x: 0, y: 0, z: 1, w: 0 };
// ARKit's gravity-aligned world is +Y up with -Z along the initial heading and
// +X to its right. Every pose Marionette publishes uses the operator frame
// +X forward, +Y left, +Z up, so identity is the phone flat, screen up, top
// edge pointing forward. This rotation maps ARKit (x, y, z) to (-z, -x, y).
const ARKIT_TO_OPERATOR: Quaternion = { x: 0.5, y: -0.5, z: -0.5, w: 0.5 };
const UP: Vector3 = { x: 0, y: 1, z: 0 };
/** Minimum deliberate displacement for each guided calibration step, in metres. */
export const MIN_CALIBRATION_STEP_M = 0.03;
/** How far from flat (screen up) the phone may be held for the flat capture. */
export const FLAT_TOLERANCE_DEGREES = 30;

/** Uncalibrated output: the gravity-aligned ARKit world, re-expressed in operator axes. */
export function applyPhoneFrame(pose: PosePacket): PosePacket {
  return { ...pose, position: rotateVector(ARKIT_TO_OPERATOR, pose.position), rotation: multiplyQuaternions(ARKIT_TO_OPERATOR, multiplyQuaternions(pose.rotation, CAMERA_TO_BODY)), calibrationVersion: 'arkit-gravity-v2' };
}

/**
 * Calibrated output. Translation is the displacement since the reference sample
 * in the calibrated frame. Rotation is the world-frame rotation since the
 * reference sample, also in the calibrated frame, so the reference reads as
 * identity and rolling about the operator's forward axis reads as rotation
 * about +X whatever the heading.
 */
export function applyPoseReference(pose: PosePacket, reference: PoseReference): PosePacket {
  const toOperator = conjugateQuaternion(normalizeQuaternion(reference.frame));
  const sinceReference = multiplyQuaternions(pose.rotation, conjugateQuaternion(normalizeQuaternion(reference.rotation)));
  return {
    ...pose,
    position: rotateVector(toOperator, subtract(pose.position, reference.position)),
    rotation: multiplyQuaternions(multiplyQuaternions(toOperator, sinceReference), reference.frame),
    calibrationVersion: `${reference.mode}-v2:${reference.epoch}`,
  };
}

/**
 * Where the phone's top edge, left edge, and screen point. Pass a published
 * rotation with `operator` (result in operator axes) or a raw ARKit camera
 * rotation with `camera` (result in ARKit world axes).
 */
export function phoneAxes(rotation: Quaternion, frame: 'operator' | 'camera'): { top: Vector3; left: Vector3; screen: Vector3 } {
  const body = frame === 'camera' ? multiplyQuaternions(rotation, CAMERA_TO_BODY) : rotation;
  return { top: rotateVector(body, { x: 1, y: 0, z: 0 }), left: rotateVector(body, { x: 0, y: 1, z: 0 }), screen: rotateVector(body, { x: 0, y: 0, z: 1 }) };
}

/** The pose every consumer should see: calibrated when a reference from this phone session exists. */
export function operatorPose(pose: PosePacket, reference?: PoseReference): PosePacket {
  return reference && reference.sessionId === pose.sessionId ? applyPoseReference(pose, reference) : applyPhoneFrame(pose);
}

function dot(a: Vector3, b: Vector3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function add(a: Vector3, b: Vector3): Vector3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function subtract(a: Vector3, b: Vector3): Vector3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function scale(v: Vector3, factor: number): Vector3 { return { x: v.x * factor, y: v.y * factor, z: v.z * factor }; }
function cross(a: Vector3, b: Vector3): Vector3 { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
function length(v: Vector3): number { return Math.hypot(v.x, v.y, v.z); }
function unit(v: Vector3): Vector3 | undefined { const magnitude = length(v); return magnitude > 1e-6 ? scale(v, 1 / magnitude) : undefined; }
function horizontal(v: Vector3): Vector3 { return subtract(v, scale(UP, dot(v, UP))); }

function quaternionFromAxes(xAxis: Vector3, yAxis: Vector3, zAxis: Vector3): Quaternion {
  // ARKit transforms and matrixToQuaternion use column-major storage. Each
  // operator axis is a local-frame basis vector expressed in world
  // coordinates, so it occupies one complete column of this rotation matrix.
  const m = [xAxis.x, xAxis.y, xAxis.z, 0, yAxis.x, yAxis.y, yAxis.z, 0, zAxis.x, zAxis.y, zAxis.z, 0, 0, 0, 0, 1];
  return matrixToQuaternion(m);
}
/** Right-handed operator frame (X forward, Y left, Z up) from a horizontal forward direction and gravity. */
function operatorFrame(forward: Vector3): Quaternion { return quaternionFromAxes(forward, cross(UP, forward), UP); }

/**
 * Quick origin: zero at the current sample, up from gravity, forward from the
 * phone's heading (its top edge, or its back camera when held upright).
 */
export function buildQuickReference(sample: CalibrationSample, epoch: number): PoseReference {
  const top = horizontal(rotateVector(sample.rotation, { x: -1, y: 0, z: 0 }));
  const back = horizontal(rotateVector(sample.rotation, { x: 0, y: 0, z: -1 }));
  const forward = unit(length(top) >= 0.5 ? top : back) ?? { x: 0, y: 0, z: -1 };
  return { mode: 'quick', sessionId: sample.sessionId, epoch, position: sample.position, rotation: sample.rotation, frame: operatorFrame(forward) };
}

export type GuidedSamples = Partial<Record<GuidedStep, CalibrationSample>>;
/**
 * Checks one guided capture against the samples taken so far so a bad step can
 * be retaken immediately. Returns a user-facing reason, or undefined when the
 * capture is usable.
 */
export function guidedCaptureError(step: GuidedStep, sample: CalibrationSample, samples: GuidedSamples): string | undefined {
  const minMm = MIN_CALIBRATION_STEP_M * 1000;
  if (step === 'flat') return dot(rotateVector(sample.rotation, { x: 0, y: 0, z: 1 }), UP) >= Math.cos(FLAT_TOLERANCE_DEGREES * Math.PI / 180) ? undefined : `Hold the phone within ${FLAT_TOLERANCE_DEGREES}° of flat, screen up, before capturing the reference`;
  const flat = samples.flat;
  if (!flat || flat.sessionId !== sample.sessionId) return 'Capture the flat reference first';
  const moved = subtract(sample.position, flat.position);
  if (step === 'up') return dot(moved, UP) >= MIN_CALIBRATION_STEP_M ? undefined : `Lift the phone at least ${minMm} mm above the flat reference`;
  if (length(horizontal(moved)) < MIN_CALIBRATION_STEP_M) return `Move the phone at least ${minMm} mm ${step} of the flat reference`;
  if (step === 'right') {
    const forward = samples.forward && unit(horizontal(subtract(samples.forward.position, flat.position)));
    const right = unit(horizontal(moved));
    if (!forward || !right || dot(cross(forward, UP), right) < Math.cos(Math.PI / 6)) return 'That move was not to the right of forward; return to the flat reference and move straight right';
  }
  return undefined;
}

/**
 * Guided frame. Gravity defines up exactly; the forward and right steps only
 * contribute their horizontal directions, which are averaged into one heading.
 * Accidental lift during the forward step therefore cannot tilt the frame.
 */
export function buildGuidedReference(samples: GuidedSamples, epoch = 0): PoseReference | undefined {
  const { flat, forward, right, up } = samples;
  if (!flat || !forward || !right || !up) return undefined;
  if (![forward, right, up].every(sample => sample.sessionId === flat.sessionId)) return undefined;
  if ((['flat', 'forward', 'right', 'up'] as const).some(step => guidedCaptureError(step, samples[step]!, samples))) return undefined;
  const forwardDirection = unit(horizontal(subtract(forward.position, flat.position)))!;
  const rightDirection = unit(horizontal(subtract(right.position, flat.position)))!;
  const heading = unit(add(forwardDirection, cross(UP, rightDirection)));
  if (!heading) return undefined;
  return { mode: 'guided', sessionId: flat.sessionId, epoch, position: flat.position, rotation: flat.rotation, frame: operatorFrame(heading) };
}

/** The operator axis each validation move must dominate (X forward, Y left, Z up). */
export const CHECK_EXPECTED_AXIS: Record<CheckMove, AxisLabel> = { forward: '+X', right: '-Y', up: '+Z' };
export function dominantAxis(v: Vector3): AxisLabel {
  const [axis, value] = ([['X', v.x], ['Y', v.y], ['Z', v.z]] as const).reduce((best, next) => Math.abs(next[1]) > Math.abs(best[1]) ? next : best);
  return `${value < 0 ? '-' : '+'}${axis}`;
}

/**
 * Validation of one move in the calibrated operator frame. The gateway measures
 * every move from the calibrated origin (the flat spot), like the guided
 * captures, so repositioning between moves does not count. It passes when the
 * largest component is on the expected axis with the expected sign. Returns a
 * user-facing reason when the move is too small to judge.
 */
export function checkCalibrationMove(move: CheckMove, to: Vector3, from: Vector3 = { x: 0, y: 0, z: 0 }): CalibrationCheckResult | string {
  const displacement = subtract(to, from);
  if (length(displacement) < MIN_CALIBRATION_STEP_M) return `Move the phone at least ${MIN_CALIBRATION_STEP_M * 1000} mm ${move === 'up' ? 'up' : move === 'right' ? 'to the right' : 'forward'} of the flat spot before checking`;
  const expected = CHECK_EXPECTED_AXIS[move]; const dominant = dominantAxis(displacement);
  return { move, expected, dominant, displacement, passed: dominant === expected };
}

/** Button label and instruction for each step, shared by every client and the gateway. */
export const CALIBRATION_STEP_TEXT: Record<CalibrationStep, { label: string; instruction: string }> = {
  flat: { label: 'Capture flat reference', instruction: 'Hold the phone roughly flat, screen up, top edge pointing forward.' },
  forward: { label: 'Capture forward', instruction: 'Move the phone straight forward at least 30 mm, keeping it flat.' },
  right: { label: 'Capture right', instruction: 'Return to the flat reference, then move the phone straight to your right.' },
  up: { label: 'Capture up', instruction: 'Return to the flat reference, then lift the phone straight upward.' },
};
export const CALIBRATION_STEPS = Object.keys(CALIBRATION_STEP_TEXT) as CalibrationStep[];
/** Validation is optional and never gates teleop; each move starts from the flat spot. */
export const CHECK_MOVE_TEXT: Record<CheckMove, { label: string; instruction: string }> = {
  forward: { label: 'Check forward', instruction: 'Bring the phone back to the flat spot, then move it straight forward about 10 cm.' },
  right: { label: 'Check right', instruction: 'Back at the flat spot, then move the phone straight to your right about 10 cm.' },
  up: { label: 'Check up', instruction: 'Back at the flat spot, then lift the phone straight up about 10 cm.' },
};
export const CHECK_MOVES = Object.keys(CHECK_MOVE_TEXT) as CheckMove[];
export function describeCheckResult(result: CalibrationCheckResult): string {
  const mm = metersToMillimeters(result.displacement); const whole = (n: number) => String(Math.round(n) || 0);
  return `${result.move} → ${result.dominant} ${result.passed ? '✓' : `✗ expected ${result.expected}`} (x ${whole(mm.x)}, y ${whole(mm.y)}, z ${whole(mm.z)} mm)`;
}

/** `synthetic` is generated test motion (the simulator); a consumer should never drive a robot from it. */
export type PoseSource = 'arkit' | 'device-motion' | 'synthetic';
/** `phoneId` is stamped by the gateway on every pose it forwards; phones never send it. */
export type PosePacket = {
  type: 'pose'; version: typeof PROTOCOL_VERSION; sessionId: string; seq: number;
  monotonicTs: number; position: Vector3; rotation: Quaternion;
  covariance: number[]; source: PoseSource; trackingState: TrackingState;
  calibrationVersion: string; heartbeat: boolean; phoneId?: string;
};

export type UiControl =
  /** `held` is the gateway's view of a hold button on one phone (phone configs only). */
  | { id: string; type: 'button'; label: string; action: string; tone?: 'default' | 'danger' | 'accent'; hold?: boolean; held?: boolean }
  | { id: string; type: 'toggle'; label: string; action: string; value: boolean }
  | { id: string; type: 'select'; label: string; action: string; value: string; options: { label: string; value: string }[] }
  | { id: string; type: 'slider'; label: string; action: string; value: number; min: number; max: number; step: number; unit?: string };

export type CameraStream = { id: string; label: string; url: string; status: 'live' | 'offline' };
/** A named set of camera streams shown together, chosen per phone with the `camera.view` control. */
export type CameraView = { id: string; label: string; streams: string[] };
/**
 * One connected (or recently connected) phone. `id` is short and stable for the
 * gateway's lifetime (`phone-1`); a phone that reconnects with the same device id
 * keeps its id, name and color.
 */
export type PhoneInfo = { id: string; name: string; color: string; connected: boolean; sessionId?: string };

/**
 * Optional validation of a finished calibration. `step` is the move the gateway
 * is waiting for while validation runs; `passed` is set once every move is checked.
 */
export type CalibrationCheck = { step?: CheckMove; results: CalibrationCheckResult[]; passed?: boolean };
export type CalibrationState = { status: 'uncalibrated' | 'capturing' | 'captured'; epoch: number; step?: CalibrationStep; originSeq?: number; reference?: PoseReference; anchor?: Vector3; check?: CalibrationCheck };
/**
 * With `phone` set, this is that phone's view: its control values (and which hold
 * buttons it is holding) and its calibration. Phones only ever receive their own.
 * Without `phone`, it is the gateway view: the control layout with default values.
 * Every config carries the roster in `phones`.
 *
 * Calibration `epoch` increments whenever the phone's published frame changes, so
 * consumers can re-anchor. While capturing, `anchor` is where the flat reference was
 * captured, in the frame poses are currently published in, so clients can show how
 * far the phone has moved for a step.
 */
export type ConfigMessage = {
  type: 'config'; version: typeof PROTOCOL_VERSION; sessionId: string; serverName: string;
  controls: UiControl[]; cameraStreams: CameraStream[]; cameraViews: CameraView[];
  calibration: CalibrationState;
  phone?: PhoneInfo; phones: PhoneInfo[];
};

/**
 * `renew` marks the repeat of a held press (every 200 ms while held). It only
 * extends a hold the gateway already has and never starts one, so a renewal
 * that races a release cannot start the hold again.
 */
export type ActionMessage = { type: 'action'; version: typeof PROTOCOL_VERSION; sessionId: string; controlId: string; action: string; value?: string | number | boolean; renew?: true; sentAt: number };
export type HtmlConfigMessage = {
  type: 'html_config'; version: typeof PROTOCOL_VERSION; sessionId: string;
  htmlVersion: typeof HTML_CONFIG_VERSION; bridgeVersion: typeof HTML_BRIDGE_VERSION;
  html: string; title?: string;
};
export type HtmlBridgeAction = {
  type: 'action'; version: typeof HTML_BRIDGE_VERSION; controlId: string; action: string;
  value?: string | number | boolean; sentAt: number;
};
/** A gateway reply. `phoneId` names the phone it concerns; phones only receive their own and gateway-wide ones. */
export type StatusMessage = { type: 'status'; version: typeof PROTOCOL_VERSION; sessionId: string; controlId?: string; message: string; values?: Record<string, string | number | boolean>; phoneId?: string };
export type CameraFrameMessage = { type: 'camera_frame'; version: typeof PROTOCOL_VERSION; sessionId: string; cameraId: string; dataUrl: string; capturedAt: number };
/**
 * First message a client may send. The app sends `{ role: 'phone', deviceId }` so a
 * reconnecting phone keeps its identity. A console may `follow` one phone (an id, or
 * empty for the first connected phone) to mirror its screen and act as it; a console
 * that follows no one sees every phone. A console that sends `cameras: false` gets no
 * camera frames (a ROS bridge, say), and simulated streams are not rendered for it.
 */
export type HelloMessage = { type: 'hello'; version: typeof PROTOCOL_VERSION; role: 'phone' | 'console'; deviceId?: string; follow?: string; cameras?: boolean };
/**
 * The button stream. Every action a phone sends is forwarded to consoles exactly as
 * received, tagged with the phone, including the 200 ms repeats of a held button
 * (`renew`). Marionette never filters, merges or acts on them (apart from running its
 * own calibration); the consumer decides what each one means. `source` is `mirror` for
 * a desktop mirror of the phone's screen, and `gateway` for a release the gateway
 * infers when a held button stops being renewed or its phone disconnects (`reason`).
 */
export type InputMessage = {
  type: 'input'; version: typeof PROTOCOL_VERSION; phoneId: string; sessionId?: string;
  controlId: string; action: string; value?: string | number | boolean; renew?: true;
  source: 'phone' | 'mirror' | 'gateway'; reason?: string; sentAt?: number; receivedAt: number;
};
export type MarionetteMessage = PosePacket | ConfigMessage | HtmlConfigMessage | ActionMessage | StatusMessage | CameraFrameMessage | HelloMessage | InputMessage;

export function isFiniteVector(v: Vector3): boolean { return [v.x, v.y, v.z].every(Number.isFinite); }
export function isFiniteQuaternion(q: Quaternion): boolean { return [q.x, q.y, q.z, q.w].every(Number.isFinite); }
export function isUnitQuaternion(q: Quaternion): boolean {
  if (!isFiniteQuaternion(q)) return false;
  const norm = Math.hypot(q.x, q.y, q.z, q.w);
  return Number.isFinite(norm) && norm > 1e-6 && Math.abs(norm - 1) <= 0.05;
}
export function normalizeQuaternion(q: Quaternion): Quaternion {
  const norm = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(norm) || norm < 1e-9) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: q.x / norm, y: q.y / norm, z: q.z / norm, w: q.w / norm };
}
export function validatePose(packet: unknown): packet is PosePacket {
  if (!packet || typeof packet !== 'object') return false;
  const p = packet as Partial<PosePacket>;
  const trackingStates: TrackingState[] = ['initializing', 'normal', 'limited', 'relocalizing', 'unavailable'];
  return p.type === 'pose' && p.version === PROTOCOL_VERSION && isBoundedString(p.sessionId, 128)
    && Number.isInteger(p.seq) && Number.isFinite(p.seq) && (p.seq as number) >= 0 && Number.isFinite(p.monotonicTs) && (p.monotonicTs as number) >= 0
    && !!p.position && isFiniteVector(p.position) && !!p.rotation && isUnitQuaternion(p.rotation)
    && Array.isArray(p.covariance) && p.covariance.length === 6 && p.covariance.every(value => Number.isFinite(value) && value >= 0 && value <= 1e6)
    && (p.source === 'arkit' || p.source === 'device-motion' || p.source === 'synthetic') && trackingStates.includes(p.trackingState as TrackingState) && isBoundedString(p.calibrationVersion, 128) && typeof p.heartbeat === 'boolean'
    && (p.phoneId === undefined || isBoundedString(p.phoneId, 64));
}

/** Rebuilds a validated pose from its known fields so extra client data is never rebroadcast. */
export function sanitizePose(p: PosePacket): PosePacket {
  return { type: 'pose', version: PROTOCOL_VERSION, sessionId: p.sessionId, seq: p.seq, monotonicTs: p.monotonicTs,
    position: { x: p.position.x, y: p.position.y, z: p.position.z }, rotation: normalizeQuaternion(p.rotation),
    covariance: p.covariance.slice(0, 6), source: p.source, trackingState: p.trackingState, calibrationVersion: p.calibrationVersion, heartbeat: p.heartbeat };
}

function isControl(value: unknown): value is UiControl {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (!isBoundedString(c.id, 128) || !isBoundedString(c.label, 256) || !isBoundedString(c.action, 256)) return false;
  if (c.type === 'button') return (c.tone === undefined || c.tone === 'default' || c.tone === 'danger' || c.tone === 'accent') && (c.hold === undefined || typeof c.hold === 'boolean') && (c.held === undefined || typeof c.held === 'boolean');
  if (c.type === 'toggle') return typeof c.value === 'boolean';
  if (c.type === 'select') return typeof c.value === 'string' && Array.isArray(c.options) && c.options.length > 0
    && c.options.every(option => !!option && typeof option === 'object' && isBoundedString((option as { label?: unknown }).label, 256) && typeof (option as { value?: unknown }).value === 'string');
  if (c.type === 'slider') return [c.value, c.min, c.max, c.step].every(n => typeof n === 'number' && Number.isFinite(n))
    && (c.max as number) > (c.min as number) && (c.step as number) > 0 && (c.unit === undefined || typeof c.unit === 'string');
  return false;
}

/**
 * Accepts a config whose envelope is valid and drops individual controls the
 * app cannot render, so a newer backend layout degrades instead of crashing.
 */
export function sanitizeConfig(message: unknown): ConfigMessage | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const c = message as Partial<ConfigMessage>;
  if (c.type !== 'config' || c.version !== PROTOCOL_VERSION || !isBoundedString(c.sessionId, 128) || typeof c.serverName !== 'string'
    || !Array.isArray(c.controls) || !Array.isArray(c.cameraStreams) || !c.calibration || typeof c.calibration !== 'object'
    || !['uncalibrated', 'capturing', 'captured'].includes(c.calibration.status) || (c.phone !== undefined && !isPhoneInfo(c.phone))) return undefined;
  return { ...c, controls: c.controls.filter(isControl),
    cameraStreams: c.cameraStreams.filter((stream): stream is CameraStream => !!stream && isBoundedString(stream.id, 128) && typeof stream.label === 'string'),
    cameraViews: Array.isArray(c.cameraViews) ? c.cameraViews.filter(isCameraView) : [],
    calibration: { ...c.calibration, epoch: Number.isFinite(c.calibration.epoch) ? c.calibration.epoch : 0, step: CALIBRATION_STEPS.includes(c.calibration.step as CalibrationStep) ? c.calibration.step : undefined, check: isCalibrationCheck(c.calibration.check) ? c.calibration.check : undefined,
      anchor: isVector(c.calibration.anchor) ? c.calibration.anchor : undefined },
    phones: Array.isArray(c.phones) ? c.phones.filter(isPhoneInfo) : [] } as ConfigMessage;
}

export function isPhoneInfo(value: unknown): value is PhoneInfo {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<PhoneInfo>;
  return isBoundedString(p.id, 64) && isBoundedString(p.name, 64) && isBoundedString(p.color, 32) && typeof p.connected === 'boolean' && (p.sessionId === undefined || isBoundedString(p.sessionId, 128));
}
function isCameraView(value: unknown): value is CameraView {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<CameraView>;
  return isBoundedString(v.id, 128) && isBoundedString(v.label, 256) && Array.isArray(v.streams) && v.streams.length > 0 && v.streams.every(id => isBoundedString(id, 128));
}
/** The camera view a config's `camera.view` control has selected, or the first view. */
export function selectedCameraView(config: Pick<ConfigMessage, 'controls' | 'cameraViews'>): CameraView | undefined {
  const control = config.controls.find(candidate => candidate.action === 'camera.view');
  const id = control?.type === 'select' ? control.value : undefined;
  return config.cameraViews.find(view => view.id === id) ?? config.cameraViews[0];
}

const AXIS_LABELS: AxisLabel[] = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
function isVector(value: unknown): value is Vector3 { return !!value && typeof value === 'object' && isFiniteVector(value as Vector3); }
function isCalibrationCheck(value: unknown): value is CalibrationCheck {
  if (!value || typeof value !== 'object') return false;
  const check = value as Partial<CalibrationCheck>;
  return (check.passed === undefined || typeof check.passed === 'boolean') && (check.step === undefined || CHECK_MOVES.includes(check.step)) && Array.isArray(check.results) && check.results.length <= 3
    && check.results.every(result => !!result && typeof result === 'object' && ['forward', 'right', 'up'].includes(result.move)
      && AXIS_LABELS.includes(result.expected) && AXIS_LABELS.includes(result.dominant) && typeof result.passed === 'boolean'
      && !!result.displacement && isFiniteVector(result.displacement));
}

export function validateStatus(message: unknown): message is StatusMessage {
  if (!message || typeof message !== 'object') return false;
  const status = message as Partial<StatusMessage>;
  return status.type === 'status' && status.version === PROTOCOL_VERSION && typeof status.message === 'string'
    && (status.controlId === undefined || isBoundedString(status.controlId, 128)) && (status.phoneId === undefined || isBoundedString(status.phoneId, 64))
    && (status.values === undefined || (!!status.values && typeof status.values === 'object' && Object.values(status.values).every(isPrimitive)));
}

function isPrimitive(value: unknown): value is string | number | boolean { return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean'; }
function isBoundedString(value: unknown, maxLength: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maxLength; }

export function validateAction(message: unknown): message is ActionMessage {
  if (!message || typeof message !== 'object') return false;
  const action = message as Partial<ActionMessage>;
  return action.type === 'action' && action.version === PROTOCOL_VERSION
    && isBoundedString(action.sessionId, 128) && isBoundedString(action.controlId, 128)
    && isBoundedString(action.action, 256) && (action.value === undefined || isPrimitive(action.value))
    && (action.renew === undefined || action.renew === true)
    && typeof action.sentAt === 'number' && Number.isFinite(action.sentAt);
}

export function validateHello(message: unknown): message is HelloMessage {
  if (!message || typeof message !== 'object') return false;
  const hello = message as Partial<HelloMessage>;
  return hello.type === 'hello' && hello.version === PROTOCOL_VERSION && (hello.role === 'phone' || hello.role === 'console')
    && (hello.deviceId === undefined || isBoundedString(hello.deviceId, 128)) && (hello.follow === undefined || (typeof hello.follow === 'string' && hello.follow.length <= 64))
    && (hello.cameras === undefined || typeof hello.cameras === 'boolean');
}

export function validateInput(message: unknown): message is InputMessage {
  if (!message || typeof message !== 'object') return false;
  const input = message as Partial<InputMessage>;
  return input.type === 'input' && input.version === PROTOCOL_VERSION && isBoundedString(input.phoneId, 64)
    && isBoundedString(input.controlId, 128) && isBoundedString(input.action, 256) && (input.value === undefined || isPrimitive(input.value))
    && (input.source === 'phone' || input.source === 'mirror' || input.source === 'gateway') && typeof input.receivedAt === 'number' && Number.isFinite(input.receivedAt)
    && (input.renew === undefined || input.renew === true) && (input.sessionId === undefined || isBoundedString(input.sessionId, 128))
    && (input.reason === undefined || isBoundedString(input.reason, 256)) && (input.sentAt === undefined || (typeof input.sentAt === 'number' && Number.isFinite(input.sentAt)));
}

export function validateHtmlConfig(message: unknown): message is HtmlConfigMessage {
  if (!message || typeof message !== 'object') return false;
  const config = message as Partial<HtmlConfigMessage>;
  let withinLimit = false;
  try { withinLimit = typeof config.html === 'string' && encodeURIComponent(config.html).replace(/%[0-9A-F]{2}/g, 'x').length <= MAX_HTML_CONFIG_BYTES; } catch { withinLimit = false; }
  return config.type === 'html_config' && config.version === PROTOCOL_VERSION
    && isBoundedString(config.sessionId, 128)
    && config.htmlVersion === HTML_CONFIG_VERSION && config.bridgeVersion === HTML_BRIDGE_VERSION
    && typeof config.html === 'string' && config.html.trim().length > 0 && config.html.includes('<') && config.html.includes('>') && withinLimit
    && (config.title === undefined || isBoundedString(config.title, 128));
}

export function validateHtmlBridgeAction(message: unknown): message is HtmlBridgeAction {
  if (!message || typeof message !== 'object') return false;
  const action = message as Partial<HtmlBridgeAction>;
  return action.type === 'action' && action.version === HTML_BRIDGE_VERSION
    && isBoundedString(action.controlId, 128) && isBoundedString(action.action, 256)
    && (action.value === undefined || isPrimitive(action.value))
    && typeof action.sentAt === 'number' && Number.isFinite(action.sentAt);
}

/** Message types the HTML bridge delivers to `Marionette.on`; the last of each is replayed to late subscribers. */
export const HTML_BRIDGE_EVENTS = ['pose', 'status', 'config', 'camera_frame', 'tracking', 'connection'] as const;
export type HtmlBridgeEvent = typeof HTML_BRIDGE_EVENTS[number];
/** Payload of the `tracking` bridge event: the phone's own view of ARKit, including why it is degraded. */
export type TrackingEvent = { state: TrackingState; source: PoseSource; reason?: string; message?: string };
/** Payload of the `connection` bridge event. `gateway` is the address shown to the operator. */
export type ConnectionEvent = { state: 'connected' | 'disconnected'; gateway: string; reason?: string };
/** Sent by `Marionette.disconnect()`: the host closes the gateway connection. */
export type HtmlBridgeDisconnect = { type: 'disconnect'; version: typeof HTML_BRIDGE_VERSION };
export function isHtmlBridgeDisconnect(message: unknown): message is HtmlBridgeDisconnect {
  return !!message && typeof message === 'object' && (message as HtmlBridgeDisconnect).type === 'disconnect' && (message as HtmlBridgeDisconnect).version === HTML_BRIDGE_VERSION;
}

/**
 * The `window.Marionette` page bridge (version 1) as a script. `post` is a
 * JavaScript expression for a function that hands one outgoing message (a
 * bridge action, or a disconnect) to the host. The iPhone app and the
 * gateway's desktop preview install this same script, then call
 * `Marionette._receive({ type, payload })` for every incoming event.
 */
export function htmlBridgeScript(post: string): string {
  return `(function(){if(window.Marionette){window.dispatchEvent(new Event('marionette-ready'));return;}
var deliver=(${post});var types=${JSON.stringify(HTML_BRIDGE_EVENTS)};var listeners={};var last={};
var primitive=function(v){var t=typeof v;return t==='string'||t==='boolean'||(t==='number'&&isFinite(v));};
var M={version:${HTML_BRIDGE_VERSION},
sendAction:function(controlId,action,value){if(typeof controlId!=='string'||typeof action!=='string')return;var m={type:'action',version:${HTML_BRIDGE_VERSION},controlId:controlId,action:action,sentAt:Date.now()};if(value!==undefined&&primitive(value))m.value=value;deliver(m);},
on:function(type,callback){if(types.indexOf(type)<0||typeof callback!=='function')return function(){};(listeners[type]||(listeners[type]=[])).push(callback);if(Object.prototype.hasOwnProperty.call(last,type)){try{callback(last[type]);}catch(e){}}return function(){listeners[type]=(listeners[type]||[]).filter(function(item){return item!==callback;});};},
latest:function(type){return last[type];},
disconnect:function(){deliver({type:'disconnect',version:${HTML_BRIDGE_VERSION}});},
_receive:function(message){if(!message||types.indexOf(message.type)<0)return;last[message.type]=message.payload;(listeners[message.type]||[]).slice().forEach(function(callback){try{callback(message.payload);}catch(e){}});}};
window.Marionette=M;window.dispatchEvent(new Event('marionette-ready'));})();true;`;
}

export const DEFAULT_GATEWAY_PORT = 8787;
/**
 * The gateway WebSocket URL for what an operator types: an IP or host name,
 * host:port, or a ws://, wss://, http:// or https:// URL. The port defaults to
 * 8787 and the path to /ws. Returns undefined when it is not an address.
 */
export function gatewayUrl(input: string): string | undefined {
  const match = /^(?:(wss?|https?):\/\/)?(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?(\/\S*)?$/i.exec(input.trim());
  if (!match) return undefined;
  const [, scheme = 'ws', host, port = String(DEFAULT_GATEWAY_PORT), path] = match;
  if (Number(port) < 1 || Number(port) > 65535) return undefined;
  return `${/^(wss|https)$/i.test(scheme) ? 'wss' : 'ws'}://${host.toLowerCase()}:${Number(port)}${!path || path === '/' ? '/ws' : path}`;
}
/**
 * A gateway URL the way an operator would type it: no ws://, no /ws, no
 * default port. `wss://` is kept so the label still connects over TLS.
 */
export function gatewayLabel(url: string): string {
  return url.replace(/^ws:\/\//i, '').replace(/\/ws$/, '').replace(new RegExp(`:${DEFAULT_GATEWAY_PORT}$`), '');
}

export function validateCameraFrame(message: unknown): message is CameraFrameMessage {
  if (!message || typeof message !== 'object') return false;
  const frame = message as Partial<CameraFrameMessage>;
  return frame.type === 'camera_frame' && frame.version === PROTOCOL_VERSION
    && isBoundedString(frame.sessionId, 128) && isBoundedString(frame.cameraId, 128)
    && typeof frame.dataUrl === 'string' && frame.dataUrl.startsWith('data:') && frame.dataUrl.length <= 2_000_000
    && typeof frame.capturedAt === 'number' && Number.isFinite(frame.capturedAt);
}

/**
 * ARKit reports no covariance, so publish a nominal diagonal (m², rad²) per
 * tracking state: tight for `normal`, loose for degraded tracking, huge when unavailable.
 */
export function nominalCovariance(trackingState: TrackingState): number[] {
  if (trackingState === 'normal') return [0.0025, 0.0025, 0.0025, 0.01, 0.01, 0.01];
  if (trackingState === 'unavailable') return [1e6, 1e6, 1e6, 1e6, 1e6, 1e6];
  return [0.25, 0.25, 0.25, 1, 1, 1];
}

/** Converts ARKit's column-major camera transform into a raw (ARKit world) pose packet. */
export function poseFromTransform(values: number[], sessionId: string, seq: number, monotonicTs: number, trackingState: TrackingState = 'unavailable'): PosePacket {
  if (values.length !== 16 || !values.every(Number.isFinite)) throw new Error('ARKit transform must contain 16 finite values');
  return { type: 'pose', version: PROTOCOL_VERSION, sessionId, seq, monotonicTs,
    position: { x: values[12], y: values[13], z: values[14] },
    rotation: matrixToQuaternion(values), covariance: nominalCovariance(trackingState), source: 'arkit', trackingState, calibrationVersion: 'arkit-v1', heartbeat: true };
}

export function matrixToQuaternion(m: number[]): Quaternion {
  const trace = m[0] + m[5] + m[10]; let x: number; let y: number; let z: number; let w: number;
  if (trace > 0) { const s = Math.sqrt(trace + 1) * 2; w = 0.25 * s; x = (m[6] - m[9]) / s; y = (m[8] - m[2]) / s; z = (m[1] - m[4]) / s; }
  else if (m[0] > m[5] && m[0] > m[10]) { const s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2; w = (m[6] - m[9]) / s; x = 0.25 * s; y = (m[4] + m[1]) / s; z = (m[8] + m[2]) / s; }
  else if (m[5] > m[10]) { const s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2; w = (m[8] - m[2]) / s; x = (m[4] + m[1]) / s; y = 0.25 * s; z = (m[9] + m[6]) / s; }
  else { const s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2; w = (m[1] - m[4]) / s; x = (m[8] + m[2]) / s; y = (m[9] + m[6]) / s; z = 0.25 * s; }
  return normalizeQuaternion({ x, y, z, w });
}

/**
 * Phone colors in connection order. They were checked for color-blind separation from
 * each other and from the forward/left/up axis colors on the paper background; no third
 * hue passed, so later phones are graphite and told apart by name.
 */
export const PHONE_COLORS = ['#c98200', '#b04fc4'] as const;
export const EXTRA_PHONE_COLOR = '#6b6f73';
export const phoneColor = (index: number): string => PHONE_COLORS[index] ?? EXTRA_PHONE_COLOR;

/**
 * The default layout. Apart from the calibration buttons, which drive Marionette's own
 * calibration, every control is only a signal: the gateway keeps each phone's values
 * and forwards every press, and the consumer decides what Stop, the scale or a hold
 * mean. A custom screen can declare its own controls (see the README).
 */
export const defaultConfig = (): ConfigMessage => ({ type: 'config', version: PROTOCOL_VERSION, sessionId: '', serverName: 'Marionette local gateway',
  controls: [
    { id: 'deadman', type: 'button', label: 'Hold to move', action: 'teleop.deadman', tone: 'accent', hold: true },
    { id: 'grip', type: 'button', label: 'Grip', action: 'gripper.hold', tone: 'accent', hold: true },
    { id: 'estop', type: 'toggle', label: 'Stop', action: 'safety.estop', value: false },
    { id: 'arm', type: 'select', label: 'Active arm', action: 'arm.select', value: 'left', options: [{ label: 'Left arm', value: 'left' }, { label: 'Right arm', value: 'right' }] },
    { id: 'cameras', type: 'select', label: 'Cameras', action: 'camera.view', value: 'head', options: [{ label: 'Head cam', value: 'head' }, { label: 'Arm cams', value: 'arms' }] },
    { id: 'lift', type: 'toggle', label: 'Include lift', action: 'lift.toggle', value: true },
    { id: 'sensitivity', type: 'slider', label: 'Translation scale', action: 'teleop.translationScale', value: 1, min: 0.1, max: 4, step: 0.1, unit: '×' },
    { id: 'calibration-start', type: 'button', label: 'Start guided calibration', action: 'calibration.start', tone: 'accent' },
    { id: 'calibration', type: 'button', label: 'Capture current calibration step', action: 'calibration.capture', tone: 'accent' },
    { id: 'capture-origin', type: 'button', label: 'Quick capture origin', action: 'calibration.captureOrigin', tone: 'accent' },
    { id: 'calibration-cancel', type: 'button', label: 'Cancel calibration', action: 'calibration.cancel' },
    { id: 'reset-origin', type: 'button', label: 'Reset calibration', action: 'calibration.reset' },
    { id: 'calibration-check', type: 'button', label: 'Validate calibration', action: 'calibration.check' },
  ],
  cameraStreams: [
    { id: 'head', label: 'Head', url: 'sim://head', status: 'live' },
    { id: 'arm-left', label: 'Left arm', url: 'sim://arm-left', status: 'live' },
    { id: 'arm-right', label: 'Right arm', url: 'sim://arm-right', status: 'live' },
  ],
  cameraViews: [{ id: 'head', label: 'Head cam', streams: ['head'] }, { id: 'arms', label: 'Arm cams', streams: ['arm-left', 'arm-right'] }],
  calibration: { status: 'uncalibrated', epoch: 0 }, phones: [] });
