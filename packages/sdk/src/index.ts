/**
 * `@marionette/sdk`: parts for robots and consoles that use Marionette phones, for Node and browsers. A set of parts,
 * not a framework: a robot runs its own control loop and calls these.
 */
export { GatewayClient, resolveAddress, type ClientRole, type GatewayClientEvents, type GatewayClientOptions, type GatewayMessage, type SendOptions, type SocketLike, type WebSocketConstructor } from './client.js';
export { ClockSync, monotonic, wallClock } from './clock.js';
export { Emitter } from './emitter.js';
export { Phone, PhonePose, PhoneTracker, type CalibrationStatus, type ConformancePhone, type Drag, type Hold, type MirrorPolicy, type TrackerOptions } from './tracker.js';
export { Clutch, JumpDetector, PressTracker, TELEOP_DEFAULTS, cameraFrame, follow, gate, owners, unwrapTurn, type ClutchOptions, type EngageOptions, type GateOptions, type JumpOptions, type OwnersOptions, type PoseLike } from './teleop.js';
export { add, dot, expRotation, identity, matMul, matVec, matrixFromQuaternion, norm, quaternionFromMatrix, rotationVector, scale, sub, transpose, type Mat3, type Pose, type Vec3 } from './math.js';
export { NOTICE_CONTROL_ID, RobotLink, type NoticeOptions, type RobotLinkEvents, type RobotLinkOptions, type ScreenResult } from './robot.js';
export { gatewayUrl, parsePairingLink } from '@marionette/protocol';
