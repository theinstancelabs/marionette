import { describe, expect, it } from 'vitest';
import { HTML_BRIDGE_VERSION, HTML_CONFIG_VERSION, PROTOCOL_VERSION, applyPhoneFrame, gatewayLabel, gatewayUrl, htmlBridgeScript, isHtmlBridgeDisconnect, buildGuidedReference, buildQuickReference, checkCalibrationMove, defaultConfig, isPhoneInfo, phoneColor, selectedCameraView, validateHello, validateInput, dominantAxis, guidedCaptureError, phoneAxes, matrixToQuaternion, metersToMillimeters, normalizeQuaternion, operatorPose, poseFromTransform, rotateVector, sanitizeConfig, validateAction, validateCameraFrame, validateHtmlBridgeAction, validateHtmlConfig, validatePose, validateStatus, type CalibrationSample, type PoseReference, type Quaternion, type Vector3 } from './index';

// Fixtures are real ARKit camera transforms: ARKit's camera +X points to the
// bottom edge of a portrait phone, +Y to its right edge, +Z out of the screen.
// The world is gravity aligned (+Y up) and the initial heading is -Z.
// Operator outputs are ROS REP-103: +X forward, +Y left, +Z up.
const v = (x: number, y: number, z: number): Vector3 => ({ x, y, z });
const axisAngle = (axis: Vector3, degrees: number): Quaternion => { const half = degrees * Math.PI / 360; const n = Math.hypot(axis.x, axis.y, axis.z); return { x: axis.x / n * Math.sin(half), y: axis.y / n * Math.sin(half), z: axis.z / n * Math.sin(half), w: Math.cos(half) }; };
const along = (...terms: [number, Vector3][]) => terms.reduce((sum, [k, d]) => v(sum.x + k * d.x, sum.y + k * d.y, sum.z + k * d.z), v(0, 0, 0));
type Body = { right: Vector3; top: Vector3; screen: Vector3 };
const turn = (body: Body, q: Quaternion): Body => ({ right: rotateVector(q, body.right), top: rotateVector(q, body.top), screen: rotateVector(q, body.screen) });
const flatAt = (headingDegrees: number): Body => { const yaw = axisAngle(v(0, 1, 0), headingDegrees); return { right: rotateVector(yaw, v(1, 0, 0)), top: rotateVector(yaw, v(0, 0, -1)), screen: v(0, 1, 0) }; };
const transform = (b: Body, p: Vector3) => [-b.top.x, -b.top.y, -b.top.z, 0, b.right.x, b.right.y, b.right.z, 0, b.screen.x, b.screen.y, b.screen.z, 0, p.x, p.y, p.z, 1];
let seq = 0;
const pose = (b: Body, p: Vector3, sessionId = 'phone') => poseFromTransform(transform(b, p), sessionId, seq++, seq, 'normal');
const sample = (b: Body, p: Vector3, sessionId = 'phone'): CalibrationSample => { const raw = pose(b, p, sessionId); return { position: raw.position, rotation: raw.rotation, seq: raw.seq, sessionId }; };
const expectVector = (actual: Vector3, expected: Vector3) => { expect(actual.x).toBeCloseTo(expected.x, 6); expect(actual.y).toBeCloseTo(expected.y, 6); expect(actual.z).toBeCloseTo(expected.z, 6); };
const expectRotation = (actual: Quaternion, expected: Quaternion) => expect(Math.abs(actual.x * expected.x + actual.y * expected.y + actual.z * expected.z + actual.w * expected.w)).toBeCloseTo(1, 6);
const X = v(1, 0, 0), Y = v(0, 1, 0), Z = v(0, 0, 1), RIGHT = v(0, -1, 0);

function guided(headingDegrees: number, origin: Vector3, flat = flatAt(headingDegrees)) {
  const level = flatAt(headingDegrees); const up = v(0, 1, 0);
  // The forward step carries accidental lift and the up step was taken from
  // the right-hand position; neither may tilt or skew the frame.
  const reference = buildGuidedReference({
    flat: sample(flat, origin),
    forward: sample(flat, along([1, origin], [0.15, level.top], [0.05, up])),
    right: sample(flat, along([1, origin], [0.12, level.right], [-0.01, up])),
    up: sample(flat, along([1, origin], [0.1, up], [0.12, level.right])),
  }, 3);
  expect(reference).toBeDefined();
  return { reference: reference!, level };
}

describe('protocol', () => {
  it('normalizes quaternions and handles zero safely', () => { expect(normalizeQuaternion({x:0,y:0,z:0,w:0})).toEqual({x:0,y:0,z:0,w:1}); expect(normalizeQuaternion({x:0,y:0,z:0,w:2}).w).toBe(1); });
  it('extracts ARKit translation and rotation from a column-major transform', () => { const p = poseFromTransform([1,0,0,0,0,1,0,0,0,0,1,0,0.2,0.3,-0.4,1], 's', 1, 2, 'normal'); expect(p.position).toEqual({x:0.2,y:0.3,z:-0.4}); expect(p.rotation.w).toBeCloseTo(1); expect(validatePose(p)).toBe(true); expect(matrixToQuaternion(transform(flatAt(0), v(0,0,0)))).toBeDefined(); });
  it('publishes uncalibrated poses in operator axes with the phone body frame', () => {
    const flat = applyPhoneFrame(pose(flatAt(0), v(0.1, 0.2, -0.3)));
    expectRotation(flat.rotation, { x: 0, y: 0, z: 0, w: 1 });
    // ARKit right 0.1, up 0.2, forward 0.3 → X forward 0.3, Y left -0.1, Z up 0.2.
    expectVector(flat.position, v(0.3, -0.1, 0.2));
    // Upright portrait, screen toward the operator: the top edge pitched from forward to up (nose up is negative pitch).
    const upright = applyPhoneFrame(pose({ right: X, top: Y, screen: Z }, v(0, 0, 0)));
    expectRotation(upright.rotation, axisAngle(Y, -90));
    expectVector(rotateVector(upright.rotation, X), Z);
    expectVector(phoneAxes(upright.rotation, 'operator').screen, v(-1, 0, 0));
  });
  it('reports where the phone edges point in ARKit and operator axes', () => {
    const level = flatAt(30); const raw = pose(level, v(0, 0, 0));
    const camera = phoneAxes(raw.rotation, 'camera');
    expectVector(camera.top, level.top); expectVector(camera.left, v(-level.right.x, -level.right.y, -level.right.z)); expectVector(camera.screen, v(0, 1, 0));
    const operator = phoneAxes(applyPhoneFrame(pose(flatAt(0), v(0, 0, 0))).rotation, 'operator');
    expectVector(operator.top, X); expectVector(operator.left, Y); expectVector(operator.screen, Z);
  });
  it('degrades covariance and defaults to unavailable when ARKit does not report tracking', () => {
    const unknown = poseFromTransform(transform(flatAt(0), v(0, 0, 0)), 's', 1, 2);
    expect(unknown.trackingState).toBe('unavailable');
    expect(unknown.covariance[0]).toBeGreaterThan(1);
    expect(poseFromTransform(transform(flatAt(0), v(0, 0, 0)), 's', 1, 2, 'limited').covariance[0]).toBeGreaterThan(0.01);
  });
  it('maps guided calibration moves and rotations onto operator axes at any heading', () => {
    for (const heading of [0, 37, -120]) {
      const origin = v(0.4, -0.2, 1.1); const { reference, level } = guided(heading, origin); const up = v(0, 1, 0);
      const at = (p: Vector3, body = level) => operatorPose(pose(body, p), reference);
      const zero = at(origin);
      expectVector(zero.position, v(0, 0, 0)); expectRotation(zero.rotation, { x: 0, y: 0, z: 0, w: 1 });
      expect(zero.calibrationVersion).toBe('guided-v2:3');
      expectVector(at(along([1, origin], [0.1, up])).position, v(0, 0, 0.1));
      expectVector(at(along([1, origin], [0.1, level.top])).position, v(0.1, 0, 0));
      expectVector(at(along([1, origin], [0.1, level.right])).position, v(0, -0.1, 0));
      expectRotation(at(origin, turn(level, axisAngle(level.top, 20))).rotation, axisAngle(X, 20));
      expectRotation(at(origin, turn(level, axisAngle(level.right, 30))).rotation, axisAngle(RIGHT, 30));
      expectRotation(at(origin, turn(level, axisAngle(up, 40))).rotation, axisAngle(Z, 40));
    }
  });
  it('treats a slightly tilted flat capture as the rotation zero', () => {
    const tilted = turn(flatAt(15), axisAngle(v(1, 0, 0.3), 8));
    const { reference } = guided(15, v(0, 0, 0), tilted);
    expectRotation(operatorPose(pose(tilted, v(0, 0, 0)), reference).rotation, { x: 0, y: 0, z: 0, w: 1 });
  });
  it('builds a quick origin from gravity and the phone heading', () => {
    const level = flatAt(-60); const origin = v(0.3, 0.1, -0.5);
    const reference = buildQuickReference(sample(level, origin), 7);
    expect(reference.mode).toBe('quick');
    const at = (p: Vector3, body = level) => operatorPose(pose(body, p), reference);
    expectVector(at(along([1, origin], [0.1, v(0, 1, 0)])).position, v(0, 0, 0.1));
    expectVector(at(along([1, origin], [0.1, level.top])).position, v(0.1, 0, 0));
    expectVector(at(along([1, origin], [0.1, level.right])).position, v(0, -0.1, 0));
    expectRotation(at(origin, turn(level, axisAngle(level.right, 25))).rotation, axisAngle(RIGHT, 25));
    // Held upright, the heading comes from the back camera instead of the vertical top edge.
    const upright = buildQuickReference(sample(turn(level, axisAngle(level.right, 90)), origin), 8);
    expectVector(operatorPose(pose(level, along([1, origin], [0.1, level.top])), upright).position, v(0.1, 0, 0));
  });
  it('ignores a reference captured in a different phone session', () => {
    const reference: PoseReference = buildQuickReference(sample(flatAt(0), v(1, 1, 1), 'old'), 1);
    expect(operatorPose(pose(flatAt(0), v(1, 1, 1), 'new'), reference).calibrationVersion).toBe('arkit-gravity-v2');
  });
  it('rejects guided captures that cannot define a frame', () => {
    const level = flatAt(0); const flat = sample(level, v(0, 0, 0));
    expect(guidedCaptureError('flat', sample({ right: X, top: Y, screen: Z }, v(0, 0, 0)), {})).toMatch(/flat/);
    expect(guidedCaptureError('forward', sample(level, v(0, 0, -0.01)), { flat })).toMatch(/30 mm/);
    const forward = sample(level, v(0, 0, -0.15));
    expect(guidedCaptureError('right', sample(level, v(-0.15, 0, 0)), { flat, forward })).toMatch(/right/);
    expect(guidedCaptureError('right', sample(level, v(0, 0, -0.3)), { flat, forward })).toMatch(/right/);
    expect(guidedCaptureError('up', sample(level, v(0.12, 0.08, 0)), { flat, forward })).toBeUndefined();
    expect(guidedCaptureError('up', sample(level, v(0, 0.01, 0)), { flat, forward })).toMatch(/Lift/);
    expect(buildGuidedReference({ flat, forward, right: sample(level, v(0.12, 0, 0)), up: sample(level, v(0, 0.1, 0), 'other') })).toBeUndefined();
  });
  it('checks that each calibration move lands on its expected operator axis', () => {
    expect(dominantAxis(v(0.02, -0.09, 0.05))).toBe('-Y');
    expect(checkCalibrationMove('forward', v(0.1, 0.03, -0.02))).toMatchObject({ dominant: '+X', expected: '+X', passed: true });
    expect(checkCalibrationMove('right', v(0.01, -0.12, 0.04))).toMatchObject({ dominant: '-Y', expected: '-Y', passed: true });
    expect(checkCalibrationMove('up', v(0.1, -0.08, 0.11), v(0.1, -0.1, 0))).toMatchObject({ dominant: '+Z', expected: '+Z', passed: true });
    expect(checkCalibrationMove('forward', v(0.04, 0, 0.1))).toMatchObject({ dominant: '+Z', passed: false });
    expect(checkCalibrationMove('right', v(0, 0.1, 0))).toMatchObject({ dominant: '+Y', passed: false });
    expect(checkCalibrationMove('up', v(0.01, 0, 0.02))).toMatch(/30 mm up of the flat spot/);
  });
  it('passes the check through a real guided frame and fails it when the frame is turned', () => {
    const origin = v(0.2, 0, -0.4); const { reference, level } = guided(37, origin); const up = v(0, 1, 0);
    const at = (p: Vector3) => operatorPose(pose(level, p), reference).position;
    // Each check move starts from the flat spot, like the guided captures.
    const results = [checkCalibrationMove('forward', at(along([1, origin], [0.1, level.top]))), checkCalibrationMove('right', at(along([1, origin], [0.1, level.right]))), checkCalibrationMove('up', at(along([1, origin], [0.1, up])))];
    expect(results.map(result => typeof result === 'string' ? result : result.passed)).toEqual([true, true, true]);
    // An operator facing 90° to the left of the calibrated forward moves along the calibrated +Y.
    const turned = flatAt(127);
    expect(checkCalibrationMove('forward', at(along([1, origin], [0.1, turned.top])))).toMatchObject({ dominant: '+Y', passed: false });
  });
  it('names phones, validates hello and input messages, and picks the camera view a phone selected', () => {
    expect([0, 1, 2, 7].map(phoneColor)).toEqual(['#c98200', '#b04fc4', '#6b6f73', '#6b6f73']);
    expect(isPhoneInfo({ id: 'phone-2', name: 'Phone 2', color: '#b04fc4', connected: false })).toBe(true);
    expect(isPhoneInfo({ id: 'phone-2', name: 'Phone 2', color: '#b04fc4' })).toBe(false);
    expect(validateHello({ type: 'hello', version: PROTOCOL_VERSION, role: 'phone', deviceId: 'abc' })).toBe(true);
    expect(validateHello({ type: 'hello', version: PROTOCOL_VERSION, role: 'console', follow: '' })).toBe(true);
    expect(validateHello({ type: 'hello', version: PROTOCOL_VERSION, role: 'robot' })).toBe(false);
    expect(validateHello({ type: 'hello', version: PROTOCOL_VERSION, role: 'console', cameras: false })).toBe(true);
    expect(validateHello({ type: 'hello', version: PROTOCOL_VERSION, role: 'console', cameras: 'no' })).toBe(false);
    const input = { type: 'input', version: PROTOCOL_VERSION, phoneId: 'phone-1', controlId: 'estop', action: 'safety.estop', value: true, source: 'phone', receivedAt: 5 };
    expect(validateInput(input)).toBe(true);
    expect(validateInput({ ...input, renew: true, sessionId: 'iphone-a', sentAt: 4 })).toBe(true);
    expect(validateInput({ ...input, value: false, source: 'gateway', reason: 'renewals stopped' })).toBe(true);
    expect(validateInput({ ...input, source: 'robot' })).toBe(false);
    expect(validateInput({ ...input, value: { nested: true } })).toBe(false);
    expect(validateInput({ ...input, renew: false })).toBe(false);
    expect(validateInput({ ...input, sentAt: 'now' })).toBe(false);
    expect(validateInput({ ...input, reason: 7 })).toBe(false);
    const config = defaultConfig();
    expect(selectedCameraView(config)?.streams).toEqual(['head']);
    const arms = { ...config, controls: config.controls.map(c => c.action === 'camera.view' && c.type === 'select' ? { ...c, value: 'arms' } : c) };
    expect(selectedCameraView(arms)?.streams).toEqual(['arm-left', 'arm-right']);
    expect(selectedCameraView({ controls: [], cameraViews: [] })).toBeUndefined();
  });
  it('rejects invalid tracking, covariance, transforms, and camera frames', () => {
    const p = poseFromTransform([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], 's', 1, 2, 'normal');
    expect(validatePose({type:'pose',version:99})).toBe(false);
    expect(validatePose({ ...p, trackingState: 'lost' })).toBe(false);
    expect(validatePose({ ...p, covariance: [0.1] })).toBe(false);
    expect(validatePose({ ...p, source: 'synthetic' })).toBe(true);
    expect(() => poseFromTransform([Number.NaN, ...Array(15).fill(0)], 's', 1, 2)).toThrow();
    expect(validateCameraFrame({ type:'camera_frame', version:PROTOCOL_VERSION, sessionId:'s', cameraId:'sim', dataUrl:'data:image/svg+xml;base64,abc', capturedAt:1 })).toBe(true);
    expect(validateCameraFrame({ type:'camera_frame', version:PROTOCOL_VERSION, sessionId:'s', cameraId:'sim', dataUrl:'https://example.com/frame.jpg', capturedAt:1 })).toBe(false);
    expect(validatePose({ ...p, monotonicTs: -1 })).toBe(false);
    expect(validatePose({ ...p, rotation: { x: 0, y: 0, z: 0, w: 0 } })).toBe(false);
    expect(validatePose({ ...p, phoneId: 'phone-1' })).toBe(true);
    expect(validatePose({ ...p, phoneId: 7 })).toBe(false);
  });
  it('drops controls the app cannot render instead of rejecting a newer layout', () => {
    const config = { ...defaultConfig(), sessionId: 'gateway', controls: [...defaultConfig().controls, { id: 'stick', type: 'joystick', label: 'Base', action: 'base.drive' }, { id: 'broken', type: 'slider', label: 'Bad', action: 'x', value: 1, min: 2, max: 1, step: 0 }] };
    const sanitized = sanitizeConfig(config);
    expect(sanitized?.controls.map(control => control.id)).toEqual(defaultConfig().controls.map(control => control.id));
    expect(sanitizeConfig({ ...config, calibration: undefined })).toBeUndefined();
    const phone = { id: 'phone-1', name: 'Phone 1', color: phoneColor(0), connected: true, sessionId: 'iphone-a' };
    expect(sanitizeConfig({ ...config, phone, phones: [phone, { id: 'x' }] })).toMatchObject({ phone, phones: [phone] });
    expect(sanitizeConfig({ ...config, phone: { id: 'phone-1' } })).toBeUndefined();
    expect(sanitizeConfig({ ...config, cameraViews: [{ id: 'arms', label: 'Arm cams', streams: [] }, ...defaultConfig().cameraViews] })?.cameraViews).toEqual(defaultConfig().cameraViews);
    const check = { step: 'right', results: [{ move: 'forward', expected: '+X', dominant: '+X', displacement: v(0.1, 0, 0), passed: true }] };
    expect(sanitizeConfig({ ...config, calibration: { status: 'captured', epoch: 1, check } })?.calibration.check).toEqual(check);
    expect(sanitizeConfig({ ...config, calibration: { status: 'captured', epoch: 1, check: { results: [{ move: 'sideways' }] } } })?.calibration.check).toBeUndefined();
    expect(sanitizeConfig({ ...config, calibration: { status: 'captured', epoch: 1, check: { ...check, step: 'check-right' } } })?.calibration.check).toBeUndefined();
    expect(sanitizeConfig({ ...config, calibration: { status: 'capturing', epoch: 1, step: 'forward', anchor: v(0.1, 0, 0) } })?.calibration.anchor).toEqual(v(0.1, 0, 0));
    expect(sanitizeConfig({ ...config, calibration: { status: 'capturing', epoch: 1, step: 'forward', anchor: { x: 'a' } } })?.calibration.anchor).toBeUndefined();
    expect(sanitizeConfig({ ...config, calibration: { status: 'capturing', epoch: 1, step: 'sideways' } })?.calibration.step).toBeUndefined();
    expect(validateStatus({ type: 'status', version: PROTOCOL_VERSION, sessionId: 'g', message: 'ok', values: { a: 1 } })).toBe(true);
    expect(validateStatus({ type: 'status', version: PROTOCOL_VERSION, sessionId: 'g', message: 42 })).toBe(false);
  });
  it('converts pose translation to millimetres for operator telemetry', () => { expect(metersToMillimeters({x:0.125,y:-0.002,z:1})).toEqual({x:125,y:-2,z:1000}); });
  it('validates versioned trusted HTML configs and rejects malformed documents', () => {
    const config = { type: 'html_config', version: PROTOCOL_VERSION, sessionId: 'gateway', htmlVersion: HTML_CONFIG_VERSION, bridgeVersion: HTML_BRIDGE_VERSION, html: '<!doctype html><button>Go</button>' };
    expect(validateHtmlConfig(config)).toBe(true);
    expect(validateHtmlConfig({ ...config, bridgeVersion: 99 })).toBe(false);
    expect(validateHtmlConfig({ ...config, html: '' })).toBe(false);
  });
  it('validates WebView bridge actions without allowing arbitrary payloads', () => {
    const bridgeAction = { type: 'action', version: HTML_BRIDGE_VERSION, controlId: 'go', action: 'robot.go', value: true, sentAt: 123 };
    expect(validateHtmlBridgeAction(bridgeAction)).toBe(true);
    expect(validateHtmlBridgeAction({ ...bridgeAction, value: { unsafe: true } })).toBe(false);
    expect(validateAction({ ...bridgeAction, version: PROTOCOL_VERSION, sessionId: 'gateway' })).toBe(true);
    expect(validateAction({ ...bridgeAction, version: PROTOCOL_VERSION, sessionId: 'gateway', renew: true })).toBe(true);
    expect(validateAction({ ...bridgeAction, version: PROTOCOL_VERSION, sessionId: 'gateway', renew: 'yes' })).toBe(false);
    expect(isHtmlBridgeDisconnect({ type: 'disconnect', version: HTML_BRIDGE_VERSION })).toBe(true);
    expect(isHtmlBridgeDisconnect({ type: 'disconnect', version: 99 })).toBe(false);
  });
  it('runs the page bridge: actions go to the host, events reach listeners, and late subscribers get the last value', () => {
    const posted: unknown[] = []; const events: string[] = [];
    const page = { dispatchEvent: (event: { type: string }) => events.push(event.type) } as Record<string, any>;
    new Function('window', 'Event', 'post', htmlBridgeScript('post'))(page, class { constructor(public type: string) {} }, (m: unknown) => posted.push(m));
    const M = page.Marionette;
    expect(events).toEqual(['marionette-ready']);
    M.sendAction('arm', 'arm.select', 'right'); M.sendAction('arm', 'arm.select', { unsafe: true }); M.sendAction(42, 'x'); M.disconnect();
    expect(posted).toMatchObject([{ type: 'action', version: 1, controlId: 'arm', action: 'arm.select', value: 'right' }, { type: 'action', controlId: 'arm' }, { type: 'disconnect', version: 1 }]);
    expect(posted[1]).not.toHaveProperty('value');
    const seen: unknown[] = []; const off = M.on('tracking', (p: unknown) => seen.push(p));
    M._receive({ type: 'tracking', payload: { state: 'normal' } }); M._receive({ type: 'nope', payload: 1 });
    expect(seen).toEqual([{ state: 'normal' }]);
    const late: unknown[] = []; M.on('tracking', (p: unknown) => late.push(p)); expect(late).toEqual([{ state: 'normal' }]);
    expect(M.latest('tracking')).toEqual({ state: 'normal' });
    off(); M._receive({ type: 'tracking', payload: { state: 'limited' } }); expect(seen).toHaveLength(1); expect(late).toHaveLength(2);
    expect(M.on('nope', () => {})).toBeTypeOf('function');
  });
  it('turns what an operator types into a gateway URL', () => {
    expect(gatewayUrl('10.1.10.120')).toBe('ws://10.1.10.120:8787/ws');
    expect(gatewayUrl(' 10.1.10.120:9000 ')).toBe('ws://10.1.10.120:9000/ws');
    expect(gatewayUrl('ws://10.1.10.120:8787/ws')).toBe('ws://10.1.10.120:8787/ws');
    expect(gatewayUrl('http://My-Mac.local:8787/')).toBe('ws://my-mac.local:8787/ws');
    expect(gatewayUrl('https://gw.example.com')).toBe('wss://gw.example.com:8787/ws');
    expect(gatewayUrl('[::1]:8787')).toBe('ws://[::1]:8787/ws');
    expect(gatewayUrl('ws://host:8787/custom')).toBe('ws://host:8787/custom');
    for (const bad of ['', '   ', 'ftp://host', 'host:99999', 'host:0', 'two words', 'http://']) expect(gatewayUrl(bad)).toBeUndefined();
    expect(gatewayLabel('ws://10.1.10.120:8787/ws')).toBe('10.1.10.120');
    expect(gatewayLabel('ws://10.1.10.120:9000/ws')).toBe('10.1.10.120:9000');
    // A TLS gateway's label must reconnect over TLS.
    for (const typed of ['https://gw.example.com', 'wss://10.0.0.5:8787/ws', '10.1.10.120:9000', 'ws://host:8787/custom']) { const url = gatewayUrl(typed)!; expect(gatewayUrl(gatewayLabel(url))).toBe(url); }
    expect(gatewayLabel('wss://gw.example.com:8787/ws')).toBe('wss://gw.example.com');
  });
});
