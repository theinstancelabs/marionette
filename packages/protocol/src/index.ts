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
/**
 * `phoneId` is stamped by the gateway on every pose it forwards; phones never send it.
 * `sentAt` is the phone's wall clock (ms) when it sent the pose. On forwarded poses the gateway adds
 * `receivedAt` (its own wall clock, ms) and `latencyMs`, its estimate of the time from the phone sending
 * the pose to the gateway receiving it, from the clock offset its pings measure (absent until known).
 */
export type PosePacket = {
  type: 'pose'; version: typeof PROTOCOL_VERSION; sessionId: string; seq: number;
  monotonicTs: number; position: Vector3; rotation: Quaternion;
  covariance: number[]; source: PoseSource; trackingState: TrackingState;
  calibrationVersion: string; heartbeat: boolean; phoneId?: string;
  sentAt?: number; receivedAt?: number; latencyMs?: number;
};

/**
 * Where a stick is pushed, in operator axes (ROS REP-103): `x` is up the pad (forward), `y` is
 * to the left, each from -1 to 1 and never more than 1 together. It is `{ x: 0, y: 0 }` at rest.
 */
export type StickValue = { x: number; y: number };
export type ControlValue = string | number | boolean | StickValue;
export const STICK_REST: StickValue = { x: 0, y: 0 };

export type UiControl =
  /** `held` is the gateway's view of a hold button on one phone (phone configs only). */
  | { id: string; type: 'button'; label: string; action: string; tone?: 'default' | 'danger' | 'accent'; hold?: boolean; held?: boolean }
  | { id: string; type: 'toggle'; label: string; action: string; value: boolean }
  | { id: string; type: 'select'; label: string; action: string; value: string; options: { label: string; value: string }[] }
  /** `live` is the gateway's view of a slider or stick being dragged on one phone (phone configs only). */
  | { id: string; type: 'slider'; label: string; action: string; value: number; min: number; max: number; step: number; unit?: string; live?: boolean }
  /** A spring-return stick: it streams while touched and goes back to rest when let go. */
  | { id: string; type: 'joystick'; label: string; action: string; value: StickValue; live?: boolean };
/** Controls whose value streams live while the operator drags them. */
export type LiveControl = Extract<UiControl, { type: 'slider' | 'joystick' }>;
export const isLiveControl = (control: UiControl | undefined): control is LiveControl => control?.type === 'slider' || control?.type === 'joystick';
/**
 * While a value is being dragged, the host repeats the latest sample this often (marked
 * `renew`) so a resting finger still reads as live. The gateway ends a stream whose samples stop.
 */
export const STREAM_RENEW_MS = 50;
/** The value a stream settles on when it ends without a final sample: a stick returns to rest, anything else keeps its last value. */
export function streamEndValue(control: UiControl | undefined, last: ControlValue | undefined): ControlValue | undefined {
  return control?.type === 'joystick' ? { ...STICK_REST } : last;
}
/** Whether two control values are the same (sticks compare by axis). */
export function sameValue(a: ControlValue | undefined, b: ControlValue | undefined): boolean {
  if (isStickValue(a) || isStickValue(b)) return isStickValue(a) && isStickValue(b) && a.x === b.x && a.y === b.y;
  return a === b;
}
export function isStickValue(value: unknown): value is StickValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { x, y } = value as Partial<StickValue>;
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && Object.keys(value).length === 2;
}
/** A stick value a control can hold: both axes within -1..1 and the push no longer than 1. */
export const isStickInRange = (value: unknown): value is StickValue => isStickValue(value) && Math.abs(value.x) <= 1 && Math.abs(value.y) <= 1 && Math.hypot(value.x, value.y) <= 1 + 1e-6;

/**
 * `transport` and `publisher` are set by the gateway: `webrtc` while a robot (`publisher`, its id) publishes
 * the stream over WebRTC, so a viewer asks that robot for video; otherwise frames arrive as `camera_frame`.
 */
export type CameraStream = { id: string; label: string; url: string; status: 'live' | 'offline'; transport?: 'jpeg' | 'webrtc'; publisher?: string };
/** A named set of camera streams shown together, chosen per phone with the `camera.view` control. */
export type CameraView = { id: string; label: string; streams: string[] };
/**
 * One connected (or recently connected) phone. `id` is short and stable for the
 * gateway's lifetime (`phone-1`); a phone that reconnects with the same device id
 * keeps its id, name and color.
 */
export type PhoneInfo = { id: string; name: string; color: string; connected: boolean; sessionId?: string };
/**
 * A robot that has connected to the gateway (`role: 'robot'`). `id` is the robot's own stable id; it stays in
 * the roster, offline, after it disconnects. `screen` marks the robot whose screen the phones are showing, and
 * `streams` the camera streams it publishes over WebRTC.
 */
export type RobotInfo = { id: string; name: string; connected: boolean; screen?: boolean; streams?: string[] };
/** A robot id: lower-case letters, digits and dashes, starting with a letter or digit. */
export const ROBOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** WebSocket close codes the gateway uses. */
export const CLOSE_CODES = { replaced: 4001, pairingRequired: 4401, robotIdInUse: 4409 } as const;

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
  /** Robots that have connected (newer gateways). */
  robots?: RobotInfo[];
  /** Stable across gateway restarts (unlike `sessionId`), so a phone can remember a gateway's pairing code. */
  gatewayId?: string;
  /** Whether clients off this computer need the pairing code. */
  auth?: boolean;
};

/**
 * `renew` marks the repeat of a held press (every 200 ms while held), or of the latest
 * sample of a value being dragged (every `STREAM_RENEW_MS` while the finger rests). It
 * only extends a hold or stream the gateway already has and never starts one, so a
 * renewal that races a release cannot start it again.
 *
 * `live` marks a sample of a value being dragged (a slider, a stick): more will follow.
 * Letting go sends the final value without `live`.
 */
export type ActionMessage = { type: 'action'; version: typeof PROTOCOL_VERSION; sessionId: string; controlId: string; action: string; value?: ControlValue; renew?: true; live?: true; sentAt: number };
export type HtmlConfigMessage = {
  type: 'html_config'; version: typeof PROTOCOL_VERSION; sessionId: string;
  htmlVersion: typeof HTML_CONFIG_VERSION; bridgeVersion: typeof HTML_BRIDGE_VERSION;
  html: string; title?: string;
  /** From `<meta name="marionette-orientation" content="portrait|landscape|any">`: the app locks to it while the screen shows. */
  orientation?: ScreenOrientation;
  /** Where the screen came from: the built-in default, a file or string the gateway was started with, or a robot. */
  source?: { kind: 'default' | 'file' | 'robot'; robotId?: string };
};
export type ScreenOrientation = 'portrait' | 'landscape' | 'any';
export type HtmlBridgeAction = {
  type: 'action'; version: typeof HTML_BRIDGE_VERSION; controlId: string; action: string;
  value?: ControlValue; live?: true; sentAt: number;
};
/**
 * A gateway reply, or feedback a console sends to the phone screens. `phoneId` names the phone it concerns;
 * phones only receive their own and gateway-wide ones. The gateway relays a console's status to the phone it
 * names and that phone's `/screen` mirrors, or to every phone and mirror without `phoneId`, never to consoles.
 */
export type StatusMessage = { type: 'status'; version: typeof PROTOCOL_VERSION; sessionId: string; controlId?: string; message: string; values?: Record<string, JsonValue>; phoneId?: string };
export type CameraFrameMessage = { type: 'camera_frame'; version: typeof PROTOCOL_VERSION; sessionId: string; cameraId: string; dataUrl: string; capturedAt: number };
/**
 * First message a client may send. The app sends `{ role: 'phone', deviceId }` so a
 * reconnecting phone keeps its identity. A console may `follow` one phone (an id, or
 * empty for the first connected phone) to mirror its screen and act as it; a console
 * that follows no one sees every phone. A console that sends `cameras: false` gets no
 * camera frames (a ROS bridge, say), and simulated streams are not rendered for it.
 */
export type HelloMessage = {
  type: 'hello'; version: typeof PROTOCOL_VERSION; role: ClientRole; deviceId?: string; follow?: string; cameras?: boolean;
  /** The gateway's pairing code, needed off the gateway's own computer when pairing is on. */
  token?: string;
  /** A phone's current pose session: reconnecting inside the same ARKit session keeps its calibration. */
  sessionId?: string;
  /** A robot's stable id (`ROBOT_ID_PATTERN`) and display name. */
  robotId?: string; name?: string;
};
/**
 * `phone`: an iPhone running the app. `console`: anything that watches (the viewer, a ROS 2 bridge, a consumer).
 * `robot`: a console that also talks back: its own screen, robot state, notices, camera frames and WebRTC video.
 */
export type ClientRole = 'phone' | 'console' | 'robot';
/**
 * The button stream. Every action a phone sends is forwarded to consoles exactly as
 * received, tagged with the phone, including the repeats of a held button or a resting
 * finger (`renew`) and every live sample of a slider or stick being dragged (`live`).
 * Marionette never filters, merges or acts on them (apart from running its own
 * calibration); the consumer decides what each one means. `source` is `mirror` for a
 * desktop mirror of the phone's screen, and `gateway` for an end the gateway infers
 * when a hold or a stream stops being renewed or its phone disconnects (`reason`).
 */
export type InputMessage = {
  type: 'input'; version: typeof PROTOCOL_VERSION; phoneId: string; sessionId?: string;
  controlId: string; action: string; value?: ControlValue; renew?: true; live?: true;
  source: 'phone' | 'mirror' | 'gateway'; reason?: string; sentAt?: number; receivedAt: number;
  /** The gateway's estimate of the time from the phone sending it to the gateway receiving it (see `PosePacket`). */
  latencyMs?: number;
};

/** Any JSON value, as robot state and status values carry it. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const MAX_ROBOT_STATE_BYTES = 65_536;
export const MAX_STATUS_VALUES_BYTES = 16_384;
/**
 * A robot's state, for the phone screens and consoles. Without `phoneId` it is for every phone; with it, for
 * that phone only. The gateway keeps the latest of each, so a phone or console that connects later starts from
 * it, fills in `robotId` and `receivedAt`, and passes it on unchanged. `everyMs` is how often the robot re-sends
 * it: a screen calls the robot unresponsive after `staleAfterMs(everyMs)` without one.
 */
export type RobotStateMessage = {
  type: 'robot_state'; version: typeof PROTOCOL_VERSION; robotId?: string; phoneId?: string;
  state: { [key: string]: JsonValue }; everyMs?: number; sentAt?: number; receivedAt?: number;
};
export const staleAfterMs = (everyMs?: number): number => Math.max(1500, 3 * (everyMs ?? 0));
/** A robot's own phone screen. It replaces the screen the phones show; the gateway answers with a `status` (`controlId: 'screen'`). */
export type ScreenMessage = { type: 'screen'; version: typeof PROTOCOL_VERSION; html: string; title?: string };
/**
 * Clock and link measurement, in either direction: whoever receives a `ping` answers with a `pong` that echoes
 * `id` and `sentAt` and adds `at`, its own wall clock. Times are wall-clock milliseconds (fractions allowed).
 * The gateway pings phones and robots every second; its pings to a phone carry `rttMs`, the round trip it last
 * measured to that phone.
 */
export type PingMessage = { type: 'ping'; version: typeof PROTOCOL_VERSION; id: number; sentAt: number; rttMs?: number };
export type PongMessage = { type: 'pong'; version: typeof PROTOCOL_VERSION; id: number; sentAt: number; at: number };
export const RTC_KINDS = ['publish', 'unpublish', 'request', 'offer', 'answer', 'candidate', 'close', 'error'] as const;
export type RtcKind = typeof RTC_KINDS[number];
export type RtcCandidate = { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
/**
 * WebRTC signaling through the gateway; the video itself goes straight from the robot to the viewer.
 * - A robot sends `publish { streams }` for the declared camera streams it serves over WebRTC (`unpublish` stops).
 * - A viewer (a phone screen, a mirror, the desktop viewer) sends `request { stream, peer }`, `peer` being its own
 *   name for the connection. The gateway passes it to the publisher with `from`, the viewer's client id, or answers
 *   `error` when nobody publishes the stream.
 * - The publisher answers with `offer { to, peer, sdp }`, the viewer with `answer { to, peer, sdp }`; either may send
 *   `candidate` and `close`. The gateway checks both ends belong to one request and stamps `from`.
 * - When either end goes away, the gateway sends the other a `close` for each of their connections.
 */
export type RtcMessage = {
  type: 'rtc'; version: typeof PROTOCOL_VERSION; kind: RtcKind;
  streams?: string[]; stream?: string; peer?: string; to?: string; from?: string;
  sdp?: string; candidate?: RtcCandidate; message?: string;
};
export type MarionetteMessage = PosePacket | ConfigMessage | HtmlConfigMessage | ActionMessage | StatusMessage | CameraFrameMessage | HelloMessage | InputMessage
  | RobotStateMessage | ScreenMessage | PingMessage | PongMessage | RtcMessage;

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
    && (p.phoneId === undefined || isBoundedString(p.phoneId, 64))
    && [p.sentAt, p.receivedAt, p.latencyMs].every(value => value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0));
}

/** Rebuilds a validated pose from its known fields so extra client data is never rebroadcast. */
export function sanitizePose(p: PosePacket): PosePacket {
  return { type: 'pose', version: PROTOCOL_VERSION, sessionId: p.sessionId, seq: p.seq, monotonicTs: p.monotonicTs,
    position: { x: p.position.x, y: p.position.y, z: p.position.z }, rotation: normalizeQuaternion(p.rotation),
    covariance: p.covariance.slice(0, 6), source: p.source, trackingState: p.trackingState, calibrationVersion: p.calibrationVersion, heartbeat: p.heartbeat,
    ...(p.sentAt !== undefined ? { sentAt: p.sentAt } : {}) };
}

function isControl(value: unknown): value is UiControl {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (!isBoundedString(c.id, 128) || !isBoundedString(c.label, 256) || !isBoundedString(c.action, 256)) return false;
  if (c.type === 'button') return (c.tone === undefined || c.tone === 'default' || c.tone === 'danger' || c.tone === 'accent') && (c.hold === undefined || typeof c.hold === 'boolean') && (c.held === undefined || typeof c.held === 'boolean');
  if (c.type === 'toggle') return typeof c.value === 'boolean';
  if (c.type === 'select') return typeof c.value === 'string' && Array.isArray(c.options) && c.options.length > 0
    && c.options.every(option => !!option && typeof option === 'object' && isBoundedString((option as { label?: unknown }).label, 256) && typeof (option as { value?: unknown }).value === 'string');
  if (c.live !== undefined && typeof c.live !== 'boolean') return false;
  if (c.type === 'slider') return [c.value, c.min, c.max, c.step].every(n => typeof n === 'number' && Number.isFinite(n))
    && (c.max as number) > (c.min as number) && (c.step as number) > 0 && (c.unit === undefined || typeof c.unit === 'string');
  if (c.type === 'joystick') return isStickInRange(c.value);
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
    phones: Array.isArray(c.phones) ? c.phones.filter(isPhoneInfo) : [],
    ...(c.robots !== undefined ? { robots: Array.isArray(c.robots) ? c.robots.filter(isRobotInfo) : [] } : {}),
    gatewayId: isBoundedString(c.gatewayId, 64) ? c.gatewayId : undefined, auth: typeof c.auth === 'boolean' ? c.auth : undefined } as ConfigMessage;
}

export function isPhoneInfo(value: unknown): value is PhoneInfo {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<PhoneInfo>;
  return isBoundedString(p.id, 64) && isBoundedString(p.name, 64) && isBoundedString(p.color, 32) && typeof p.connected === 'boolean' && (p.sessionId === undefined || isBoundedString(p.sessionId, 128));
}
export function isRobotInfo(value: unknown): value is RobotInfo {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<RobotInfo>;
  return typeof r.id === 'string' && ROBOT_ID_PATTERN.test(r.id) && isBoundedString(r.name, 64) && typeof r.connected === 'boolean'
    && (r.screen === undefined || typeof r.screen === 'boolean') && (r.streams === undefined || (Array.isArray(r.streams) && r.streams.every(id => isBoundedString(id, 128))));
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
    && (status.values === undefined || (isJsonObject(status.values) && utf8Length(JSON.stringify(status.values)) <= MAX_STATUS_VALUES_BYTES));
}
/** Whether a value is plain JSON: null, booleans, finite numbers, strings, arrays and plain objects, at most 16 deep. */
export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= 16 || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every(item => isJsonValue(item, depth + 1));
}
export function isJsonObject(value: unknown): value is { [key: string]: JsonValue } { return !!value && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value); }
/** UTF-8 byte length without TextEncoder (the app's JavaScript engine may lack it). */
export function utf8Length(text: string): number { try { return encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, 'x').length; } catch { return Infinity; } }
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalBounded = (value: unknown, maxLength: number) => value === undefined || isBoundedString(value, maxLength);

export function validateRobotState(message: unknown): message is RobotStateMessage {
  if (!message || typeof message !== 'object') return false;
  const m = message as Partial<RobotStateMessage>;
  return m.type === 'robot_state' && m.version === PROTOCOL_VERSION && (m.robotId === undefined || (typeof m.robotId === 'string' && ROBOT_ID_PATTERN.test(m.robotId)))
    && optionalBounded(m.phoneId, 64) && isJsonObject(m.state) && utf8Length(JSON.stringify(m.state)) <= MAX_ROBOT_STATE_BYTES
    && (m.everyMs === undefined || (isFiniteNumber(m.everyMs) && m.everyMs >= 10 && m.everyMs <= 60_000))
    && (m.sentAt === undefined || isFiniteNumber(m.sentAt)) && (m.receivedAt === undefined || isFiniteNumber(m.receivedAt));
}
export function validateScreen(message: unknown): message is ScreenMessage {
  if (!message || typeof message !== 'object') return false;
  const m = message as Partial<ScreenMessage>;
  return m.type === 'screen' && m.version === PROTOCOL_VERSION && typeof m.html === 'string' && m.html.trim().length > 0 && utf8Length(m.html) <= MAX_HTML_CONFIG_BYTES && optionalBounded(m.title, 128);
}
export function validatePing(message: unknown): message is PingMessage {
  if (!message || typeof message !== 'object') return false;
  const m = message as Partial<PingMessage>;
  return m.type === 'ping' && m.version === PROTOCOL_VERSION && Number.isSafeInteger(m.id) && (m.id as number) >= 0 && isFiniteNumber(m.sentAt)
    && (m.rttMs === undefined || (isFiniteNumber(m.rttMs) && m.rttMs >= 0));
}
export function validatePong(message: unknown): message is PongMessage {
  if (!message || typeof message !== 'object') return false;
  const m = message as Partial<PongMessage>;
  return m.type === 'pong' && m.version === PROTOCOL_VERSION && Number.isSafeInteger(m.id) && (m.id as number) >= 0 && isFiniteNumber(m.sentAt) && isFiniteNumber(m.at);
}
const PEER_PATTERN = /^[\w.-]{1,64}$/;
function isRtcBody(m: Partial<RtcMessage>): boolean {
  return RTC_KINDS.includes(m.kind as RtcKind)
    && (m.streams === undefined || (Array.isArray(m.streams) && m.streams.length <= 32 && m.streams.every(id => isBoundedString(id, 128))))
    && optionalBounded(m.stream, 128) && (m.peer === undefined || (typeof m.peer === 'string' && PEER_PATTERN.test(m.peer)))
    && optionalBounded(m.to, 32) && optionalBounded(m.from, 32) && (m.sdp === undefined || (typeof m.sdp === 'string' && m.sdp.length <= 65_536))
    && (m.candidate === undefined || (!!m.candidate && typeof m.candidate === 'object' && typeof m.candidate.candidate === 'string' && m.candidate.candidate.length <= 2048
      && (m.candidate.sdpMid === undefined || m.candidate.sdpMid === null || isBoundedString(m.candidate.sdpMid, 64))
      && (m.candidate.sdpMLineIndex === undefined || m.candidate.sdpMLineIndex === null || (Number.isInteger(m.candidate.sdpMLineIndex) && m.candidate.sdpMLineIndex >= 0 && m.candidate.sdpMLineIndex <= 64))))
    && (m.message === undefined || (typeof m.message === 'string' && m.message.length <= 512));
}
export function validateRtc(message: unknown): message is RtcMessage {
  if (!message || typeof message !== 'object') return false;
  const m = message as Partial<RtcMessage>;
  return m.type === 'rtc' && m.version === PROTOCOL_VERSION && isRtcBody(m);
}

function isPrimitive(value: unknown): value is string | number | boolean { return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean'; }
/** A value an action may carry: a string, finite number, boolean, or a stick's `{ x, y }`. */
export function isControlValue(value: unknown): value is ControlValue { return isPrimitive(value) || isStickValue(value); }
function isBoundedString(value: unknown, maxLength: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maxLength; }

export function validateAction(message: unknown): message is ActionMessage {
  if (!message || typeof message !== 'object') return false;
  const action = message as Partial<ActionMessage>;
  return action.type === 'action' && action.version === PROTOCOL_VERSION
    && isBoundedString(action.sessionId, 128) && isBoundedString(action.controlId, 128)
    && isBoundedString(action.action, 256) && (action.value === undefined || isControlValue(action.value))
    && (action.renew === undefined || action.renew === true) && (action.live === undefined || action.live === true)
    && typeof action.sentAt === 'number' && Number.isFinite(action.sentAt);
}

export function validateHello(message: unknown): message is HelloMessage {
  if (!message || typeof message !== 'object') return false;
  const hello = message as Partial<HelloMessage>;
  return hello.type === 'hello' && hello.version === PROTOCOL_VERSION && (hello.role === 'phone' || hello.role === 'console' || hello.role === 'robot')
    && (hello.deviceId === undefined || isBoundedString(hello.deviceId, 128)) && (hello.follow === undefined || (typeof hello.follow === 'string' && hello.follow.length <= 64))
    && (hello.cameras === undefined || typeof hello.cameras === 'boolean') && optionalBounded(hello.token, 64) && optionalBounded(hello.sessionId, 128)
    && (hello.role === 'robot' ? typeof hello.robotId === 'string' && ROBOT_ID_PATTERN.test(hello.robotId) : hello.robotId === undefined) && optionalBounded(hello.name, 64);
}

export function validateInput(message: unknown): message is InputMessage {
  if (!message || typeof message !== 'object') return false;
  const input = message as Partial<InputMessage>;
  return input.type === 'input' && input.version === PROTOCOL_VERSION && isBoundedString(input.phoneId, 64)
    && isBoundedString(input.controlId, 128) && isBoundedString(input.action, 256) && (input.value === undefined || isControlValue(input.value))
    && (input.source === 'phone' || input.source === 'mirror' || input.source === 'gateway') && typeof input.receivedAt === 'number' && Number.isFinite(input.receivedAt)
    && (input.renew === undefined || input.renew === true) && (input.live === undefined || input.live === true) && (input.sessionId === undefined || isBoundedString(input.sessionId, 128))
    && (input.reason === undefined || isBoundedString(input.reason, 256)) && (input.sentAt === undefined || (typeof input.sentAt === 'number' && Number.isFinite(input.sentAt)))
    && (input.latencyMs === undefined || (isFiniteNumber(input.latencyMs) && input.latencyMs >= 0));
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
    && (config.title === undefined || isBoundedString(config.title, 128))
    && (config.orientation === undefined || ['portrait', 'landscape', 'any'].includes(config.orientation))
    && (config.source === undefined || (!!config.source && typeof config.source === 'object' && ['default', 'file', 'robot'].includes(config.source.kind) && optionalBounded(config.source.robotId, 64)));
}

export function validateHtmlBridgeAction(message: unknown): message is HtmlBridgeAction {
  if (!message || typeof message !== 'object') return false;
  const action = message as Partial<HtmlBridgeAction>;
  return action.type === 'action' && action.version === HTML_BRIDGE_VERSION
    && isBoundedString(action.controlId, 128) && isBoundedString(action.action, 256)
    && (action.value === undefined || isControlValue(action.value)) && (action.live === undefined || action.live === true)
    && typeof action.sentAt === 'number' && Number.isFinite(action.sentAt);
}

/** Message types the HTML bridge delivers to `Marionette.on`; the last of each is replayed to late subscribers. */
export const HTML_BRIDGE_EVENTS = ['pose', 'status', 'config', 'camera_frame', 'tracking', 'connection', 'robot_state', 'robots', 'link', 'rtc'] as const;
export type HtmlBridgeEvent = typeof HTML_BRIDGE_EVENTS[number];
/** Payload of the `tracking` bridge event: the phone's own view of ARKit, including why it is degraded. */
export type TrackingEvent = { state: TrackingState; source: PoseSource; reason?: string; message?: string };
/** Payload of the `connection` bridge event. `gateway` is the address shown to the operator. */
export type ConnectionEvent = { state: 'connected' | 'disconnected' | 'reconnecting'; gateway: string; reason?: string };
/** Payload of the `link` bridge event: the round trip to the gateway and what it means for driving. */
export type LinkEvent = { rttMs?: number; quality: 'good' | 'fair' | 'poor' | 'unknown' };
export const linkQuality = (rttMs?: number): LinkEvent['quality'] => rttMs === undefined || !Number.isFinite(rttMs) ? 'unknown' : rttMs < 60 ? 'good' : rttMs < 150 ? 'fair' : 'poor';
/**
 * Payload of the `robots` bridge event, which the bridge builds from `config.robots` and every `robot_state`:
 * each robot's latest state for every phone (`state`) and for this phone (`phoneState`), and `receivedAt`, the
 * page's `Date.now()` when either last arrived.
 */
export type RobotView = { id: string; name: string; connected: boolean; state?: { [key: string]: JsonValue }; phoneState?: { [key: string]: JsonValue }; everyMs?: number; receivedAt?: number };
/** What a host (the app, the desktop mirror) supports, as `Marionette.features` lists it. */
export const HTML_BRIDGE_FEATURES = ['live', 'robot_state', 'link', 'rtc', 'reconnect', 'orientation'] as const;
export type HtmlBridgeFeature = typeof HTML_BRIDGE_FEATURES[number];
/** WebRTC signaling a page sends through `Marionette.rtc(…)`; the host forwards it to the gateway as an `rtc` message. */
export type HtmlBridgeRtc = Omit<RtcMessage, 'version' | 'from'> & { version: typeof HTML_BRIDGE_VERSION };
export function validateHtmlBridgeRtc(message: unknown): message is HtmlBridgeRtc {
  if (!message || typeof message !== 'object') return false;
  const m = message as Partial<RtcMessage>;
  return m.type === 'rtc' && m.version === HTML_BRIDGE_VERSION && m.from === undefined && isRtcBody(m);
}
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
 *
 * `sendAction(controlId, action, value, { live: true })` sends one sample of a
 * value being dragged. `stream(controlId, action)` wraps that for a slider or
 * stick: `update(value)` sends the newest value at most once per animation frame
 * and only when it changed, and `end(value)` sends the final value (the last one
 * if left out) and closes the stream. The host repeats the latest sample while
 * the stream is open.
 */
export function htmlBridgeScript(post: string, features: readonly HtmlBridgeFeature[] = []): string {
  return `(function(){if(window.Marionette){window.dispatchEvent(new Event('marionette-ready'));return;}
var deliver=(${post});var types=${JSON.stringify(HTML_BRIDGE_EVENTS)};var listeners={};var last={};var robots={};var phoneId=null;
var emit=function(type,payload){last[type]=payload;(listeners[type]||[]).slice().forEach(function(callback){try{callback(payload);}catch(e){}});};
var robotView=function(){var out={};for(var id in robots){var r=robots[id];out[id]={id:r.id,name:r.name,connected:r.connected,state:r.state,phoneState:r.phoneState,everyMs:r.everyMs,receivedAt:r.receivedAt};}return out;};
var robot=function(id){return robots[id]||(robots[id]={id:id,name:id,connected:true});};
var fold=function(type,p){if(type==='config'&&p){phoneId=p.phone?p.phone.id:null;if(Array.isArray(p.robots)){p.robots.forEach(function(info){if(!info||typeof info.id!=='string')return;var r=robot(info.id);r.name=info.name||info.id;r.connected=!!info.connected;});emit('robots',robotView());}}
else if(type==='robot_state'&&p&&typeof p.robotId==='string'&&p.state&&typeof p.state==='object'){if(p.phoneId&&p.phoneId!==phoneId)return false;var r=robot(p.robotId);if(p.phoneId)r.phoneState=p.state;else r.state=p.state;if(typeof p.everyMs==='number')r.everyMs=p.everyMs;r.receivedAt=Date.now();emit('robots',robotView());}return true;};
var primitive=function(v){var t=typeof v;return t==='string'||t==='boolean'||(t==='number'&&isFinite(v));};
var clean=function(v){if(primitive(v))return v;if(v&&typeof v==='object'&&typeof v.x==='number'&&typeof v.y==='number'&&isFinite(v.x)&&isFinite(v.y))return{x:v.x,y:v.y};return undefined;};
var same=function(a,b){return a===b||(!!a&&!!b&&typeof a==='object'&&typeof b==='object'&&a.x===b.x&&a.y===b.y);};
var M={version:${HTML_BRIDGE_VERSION},
sendAction:function(controlId,action,value,options){if(typeof controlId!=='string'||typeof action!=='string')return;var m={type:'action',version:${HTML_BRIDGE_VERSION},controlId:controlId,action:action,sentAt:Date.now()};var v=clean(value);if(v!==undefined)m.value=v;if(options&&options.live)m.live=true;deliver(m);},
stream:function(controlId,action){var open=false,pending,sent,frame=0;
var flush=function(){frame=0;if(pending===undefined)return;sent=pending;pending=undefined;M.sendAction(controlId,action,sent,{live:true});};
return{update:function(value){var v=clean(value);if(v===undefined||(open&&same(v,pending===undefined?sent:pending)))return;open=true;pending=v;if(!frame)frame=requestAnimationFrame(flush);},
end:function(value){if(!open)return;var v=value===undefined?(pending===undefined?sent:pending):value;open=false;if(frame)cancelAnimationFrame(frame);frame=0;pending=undefined;sent=undefined;M.sendAction(controlId,action,v);},
isOpen:function(){return open;}};},
on:function(type,callback){if(types.indexOf(type)<0||typeof callback!=='function')return function(){};(listeners[type]||(listeners[type]=[])).push(callback);if(Object.prototype.hasOwnProperty.call(last,type)){try{callback(last[type]);}catch(e){}}return function(){listeners[type]=(listeners[type]||[]).filter(function(item){return item!==callback;});};},
latest:function(type){return last[type];},
features:${JSON.stringify(features)},
rtc:function(message){if(!message||typeof message!=='object'||typeof message.kind!=='string')return;var m={type:'rtc',version:${HTML_BRIDGE_VERSION},kind:message.kind};['streams','stream','peer','to','sdp','candidate','message'].forEach(function(key){if(message[key]!==undefined)m[key]=message[key];});deliver(m);},
disconnect:function(){deliver({type:'disconnect',version:${HTML_BRIDGE_VERSION}});},
_receive:function(message){if(!message||types.indexOf(message.type)<0||message.type==='robots')return;if(fold(message.type,message.payload)===false)return;emit(message.type,message.payload);}};
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
/** Crockford base32 without I, L, O and U, so a pairing code is easy to read aloud and type. */
export const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A pairing code as typed: case, spaces and dashes don't matter, and O, I and L read as 0, 1 and 1. */
export function normalizePairingCode(code: string): string { return code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1'); }
/** `K7Q2M9XD` → `K7Q2-M9XD`. */
export function formatPairingCode(code: string): string { const c = normalizePairingCode(code); return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c; }
/**
 * What a gateway's pairing QR code holds: every address it can be reached at, its port, the pairing code (absent
 * when pairing is off), its stable id and its name. As a link: `marionette://pair?v=1&host=a,b&port=8787&code=…&id=…&name=…`.
 */
export type PairingLink = { hosts: string[]; port: number; code?: string; gatewayId?: string; name?: string };
const HOST_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i;
export function pairingLink(link: PairingLink): string {
  const query = [['v', '1'], ['host', link.hosts.join(',')], ['port', String(link.port)], ...(link.code ? [['code', normalizePairingCode(link.code)]] : []),
    ...(link.gatewayId ? [['id', link.gatewayId]] : []), ...(link.name ? [['name', link.name]] : [])];
  return `marionette://pair?${query.map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/%2C/gi, ',')}`).join('&')}`;
}
/** Reads a pairing link (parsed by hand: the app's JavaScript engine has no full URL support). Undefined if it isn't one. */
export function parsePairingLink(text: string): PairingLink | undefined {
  const match = /^marionette:\/\/pair\/?\?(.*)$/i.exec(text.trim()); if (!match) return undefined;
  const params: Record<string, string> = {};
  for (const part of match[1].split('&')) { const at = part.indexOf('='); if (at <= 0) continue; try { params[part.slice(0, at)] = decodeURIComponent(part.slice(at + 1).replace(/\+/g, ' ')); } catch { return undefined; } }
  const hosts = (params.host ?? '').split(',').map(host => host.trim()).filter(host => HOST_PATTERN.test(host)).slice(0, 8);
  const port = params.port === undefined ? DEFAULT_GATEWAY_PORT : Number(params.port);
  if (!hosts.length || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const code = params.code ? normalizePairingCode(params.code) : undefined;
  return { hosts, port, ...(code && code.length <= 64 ? { code } : {}), ...(params.id && params.id.length <= 64 ? { gatewayId: params.id } : {}), ...(params.name ? { name: params.name.slice(0, 64) } : {}) };
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
    { id: 'drive', type: 'joystick', label: 'Drive', action: 'base.drive', value: { ...STICK_REST } },
    { id: 'turn-left', type: 'button', label: 'Turn left', action: 'base.turnLeft', hold: true },
    { id: 'turn-right', type: 'button', label: 'Turn right', action: 'base.turnRight', hold: true },
    { id: 'speed-limit', type: 'slider', label: 'Speed limit', action: 'base.speedLimit', value: 50, min: 0, max: 100, step: 1, unit: '%' },
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
