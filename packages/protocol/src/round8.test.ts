import { describe, expect, it } from 'vitest';
import { CLOSE_CODES, HTML_BRIDGE_VERSION, PROTOCOL_VERSION, buildQuickReference, formatPairingCode, operatorPose, rawPoseFor, htmlBridgeScript, isJsonValue, linkQuality, normalizePairingCode, pairingLink, parsePairingLink, sanitizeConfig, sanitizePose, defaultConfig,
  staleAfterMs, validateHello, validateHtmlBridgeRtc, validateHtmlConfig, validatePing, validatePong, validatePose, validateRobotState, validateRtc, validateScreen, validateStatus, type RobotView } from './index';

const pose = { type: 'pose', version: 1, sessionId: 's', seq: 1, monotonicTs: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, covariance: [0, 0, 0, 0, 0, 0], source: 'arkit', trackingState: 'normal', calibrationVersion: 'v', heartbeat: true };

describe('round 8 protocol additions', () => {
  it('accepts robots in the hello only with a valid robot id', () => {
    expect(validateHello({ type: 'hello', version: 1, role: 'robot', robotId: 'axol', name: 'Axol', token: 'K7Q2M9XD' })).toBe(true);
    expect(validateHello({ type: 'hello', version: 1, role: 'robot' })).toBe(false);
    expect(validateHello({ type: 'hello', version: 1, role: 'robot', robotId: 'Axol!' })).toBe(false);
    expect(validateHello({ type: 'hello', version: 1, role: 'phone', robotId: 'axol' })).toBe(false);
    expect(validateHello({ type: 'hello', version: 1, role: 'phone', deviceId: 'iphone-abcdefgh', sessionId: 'iphone-1' })).toBe(true);
  });

  it('carries nested JSON in robot state and status values, within limits', () => {
    const state = { frames: ['axol', 'head'], battery: null, arms: { left: { engaged: true, reach: [0.1, 0.2] } } };
    expect(validateRobotState({ type: 'robot_state', version: 1, state, everyMs: 200 })).toBe(true);
    expect(validateRobotState({ type: 'robot_state', version: 1, state: [1, 2] })).toBe(false);
    expect(validateRobotState({ type: 'robot_state', version: 1, state: { big: 'x'.repeat(70_000) } })).toBe(false);
    expect(validateRobotState({ type: 'robot_state', version: 1, state: { nan: Number.NaN } })).toBe(false);
    expect(validateRobotState({ type: 'robot_state', version: 1, state: {}, everyMs: 1 })).toBe(false);
    expect(validateStatus({ type: 'status', version: 1, sessionId: 's', message: '', values: state })).toBe(true);
    expect(validateStatus({ type: 'status', version: 1, sessionId: 's', message: '', values: { when: new Date() } })).toBe(false);
    expect(isJsonValue(JSON.parse('['.repeat(20) + ']'.repeat(20)))).toBe(false);
    expect(staleAfterMs()).toBe(1500); expect(staleAfterMs(1000)).toBe(3000);
  });

  it('validates screens, pings, pongs and signaling', () => {
    expect(validateScreen({ type: 'screen', version: 1, html: '<p>hi</p>' })).toBe(true);
    expect(validateScreen({ type: 'screen', version: 1, html: ' ' })).toBe(false);
    expect(validatePing({ type: 'ping', version: 1, id: 3, sentAt: 1.5, rttMs: 12 })).toBe(true);
    expect(validatePong({ type: 'pong', version: 1, id: 3, sentAt: 1.5, at: 2 })).toBe(true);
    expect(validatePong({ type: 'pong', version: 1, id: -1, sentAt: 1.5, at: 2 })).toBe(false);
    expect(validateRtc({ type: 'rtc', version: 1, kind: 'request', stream: 'head', peer: 'head-1' })).toBe(true);
    expect(validateRtc({ type: 'rtc', version: 1, kind: 'offer', to: 'c3', peer: 'head-1', sdp: 'v=0' })).toBe(true);
    expect(validateRtc({ type: 'rtc', version: 1, kind: 'dance' })).toBe(false);
    expect(validateRtc({ type: 'rtc', version: 1, kind: 'request', peer: 'bad peer' })).toBe(false);
    expect(validateHtmlBridgeRtc({ type: 'rtc', version: HTML_BRIDGE_VERSION, kind: 'answer', to: 'c1', peer: 'p', sdp: 'v=0' })).toBe(true);
    expect(validateHtmlBridgeRtc({ type: 'rtc', version: HTML_BRIDGE_VERSION, kind: 'answer', from: 'c1' })).toBe(false);
  });

  it('keeps the phone send time on a sanitized pose and checks latency stamps', () => {
    expect(sanitizePose({ ...pose, sentAt: 123 } as never).sentAt).toBe(123);
    expect(validatePose({ ...pose, latencyMs: -1 })).toBe(false);
    expect(validatePose({ ...pose, sentAt: 1, receivedAt: 2, latencyMs: 0.4 })).toBe(true);
  });

  it('passes robots, the gateway id and screen orientation through validation', () => {
    const config = sanitizeConfig({ ...defaultConfig(), sessionId: 'g', gatewayId: 'gw-1', auth: true, robots: [{ id: 'axol', name: 'Axol', connected: true, screen: true }, { id: 'BAD', name: 'x', connected: true }] });
    expect(config?.robots).toEqual([{ id: 'axol', name: 'Axol', connected: true, screen: true }]);
    expect(config?.gatewayId).toBe('gw-1');
    const html = { type: 'html_config', version: 1, sessionId: 's', htmlVersion: 1, bridgeVersion: 1, html: '<p>x</p>' };
    expect(validateHtmlConfig({ ...html, orientation: 'landscape', source: { kind: 'robot', robotId: 'axol' } })).toBe(true);
    expect(validateHtmlConfig({ ...html, orientation: 'sideways' })).toBe(false);
  });

  it('round-trips pairing links and normalizes typed codes', () => {
    const link = pairingLink({ hosts: ['192.168.1.20', '100.64.0.5'], port: 8787, code: 'k7q2-m9xd', gatewayId: 'gw-ab12', name: 'Axol lab' });
    expect(link).toBe('marionette://pair?v=1&host=192.168.1.20,100.64.0.5&port=8787&code=K7Q2M9XD&id=gw-ab12&name=Axol%20lab');
    expect(parsePairingLink(link)).toEqual({ hosts: ['192.168.1.20', '100.64.0.5'], port: 8787, code: 'K7Q2M9XD', gatewayId: 'gw-ab12', name: 'Axol lab' });
    expect(parsePairingLink('marionette://pair?host=robot.local')).toEqual({ hosts: ['robot.local'], port: 8787 });
    expect(parsePairingLink('https://example.com')).toBeUndefined();
    expect(parsePairingLink('marionette://pair?host=;rm&port=1')).toBeUndefined();
    expect(normalizePairingCode(' k7q2-m9xd ')).toBe('K7Q2M9XD');
    expect(normalizePairingCode('oil')).toBe('011');
    expect(formatPairingCode('k7q2m9xd')).toBe('K7Q2-M9XD');
    expect(CLOSE_CODES.pairingRequired).toBe(4401);
  });

  it('inverts operatorPose, so a simulated phone can stream the raw pose for an operator-frame target', () => {
    const target = { position: { x: 0.3, y: -0.12, z: 0.05 }, rotation: { x: 0.1, y: -0.2, z: 0.3, w: 0.927 } };
    const norm = Math.hypot(0.1, 0.2, 0.3, 0.927); target.rotation = { x: 0.1 / norm, y: -0.2 / norm, z: 0.3 / norm, w: 0.927 / norm };
    const yaw = 0.7; const reference = buildQuickReference({ position: { x: 0.4, y: 1.1, z: -0.2 }, rotation: { x: -Math.SQRT1_2 * Math.cos(yaw), y: Math.SQRT1_2 * Math.sin(yaw), z: Math.SQRT1_2 * Math.sin(yaw), w: Math.SQRT1_2 * Math.cos(yaw) }, seq: 3, sessionId: 's' }, 2);
    for (const ref of [undefined, reference]) {
      const raw = rawPoseFor(target, ref); const back = operatorPose({ ...pose, ...raw } as never, ref);
      for (const axis of ['x', 'y', 'z'] as const) expect(back.position[axis]).toBeCloseTo(target.position[axis], 9);
      const dot = back.rotation.x * target.rotation.x + back.rotation.y * target.rotation.y + back.rotation.z * target.rotation.z + back.rotation.w * target.rotation.w;
      expect(Math.abs(dot)).toBeCloseTo(1, 9);
    }
  });

  it('rates the link from the round trip', () => {
    expect(linkQuality()).toBe('unknown'); expect(linkQuality(20)).toBe('good'); expect(linkQuality(90)).toBe('fair'); expect(linkQuality(400)).toBe('poor');
  });

  it('builds the robots view in the page bridge from config and robot state, and forwards signaling', () => {
    const page: { Marionette?: { _receive(m: unknown): void; on(type: string, cb: (p: unknown) => void): () => void; rtc(m: unknown): void; features: string[] }; dispatchEvent(event: unknown): void } = { dispatchEvent() {} };
    const posted: unknown[] = [];
    new Function('window', 'Event', 'post', htmlBridgeScript('post', ['live', 'robot_state', 'rtc']))(page, class { constructor(public type: string) {} }, (m: unknown) => posted.push(m));
    const M = page.Marionette!;
    expect(M.features).toEqual(['live', 'robot_state', 'rtc']);
    const views: Record<string, RobotView>[] = []; M.on('robots', view => views.push(view as Record<string, RobotView>));
    M._receive({ type: 'config', payload: { ...defaultConfig(), phone: { id: 'phone-1', name: 'Phone 1', color: '#c98200', connected: true }, robots: [{ id: 'axol', name: 'Axol', connected: true }] } });
    M._receive({ type: 'robot_state', payload: { type: 'robot_state', version: PROTOCOL_VERSION, robotId: 'axol', state: { ready: true }, everyMs: 200 } });
    M._receive({ type: 'robot_state', payload: { type: 'robot_state', version: PROTOCOL_VERSION, robotId: 'axol', phoneId: 'phone-1', state: { arm: 'left' } } });
    M._receive({ type: 'robot_state', payload: { type: 'robot_state', version: PROTOCOL_VERSION, robotId: 'axol', phoneId: 'phone-2', state: { arm: 'right' } } });
    M._receive({ type: 'robots', payload: { forged: true } });
    const latest = views.at(-1)!;
    expect(views).toHaveLength(3);
    expect(latest.axol).toMatchObject({ id: 'axol', name: 'Axol', connected: true, state: { ready: true }, phoneState: { arm: 'left' }, everyMs: 200 });
    expect(typeof latest.axol.receivedAt).toBe('number');
    M.rtc({ kind: 'answer', to: 'c4', peer: 'head-1', sdp: 'v=0', from: 'spoofed', extra: 1 });
    expect(posted).toEqual([{ type: 'rtc', version: HTML_BRIDGE_VERSION, kind: 'answer', to: 'c4', peer: 'head-1', sdp: 'v=0' }]);
  });

  it('drops robot views that went stale: another phone, a restarted gateway, a robot no longer listed', () => {
    const page: { Marionette?: { _receive(m: unknown): void; latest(type: string): unknown }; dispatchEvent(event: unknown): void } = { dispatchEvent() {} };
    new Function('window', 'Event', htmlBridgeScript('function(){}', ['robot_state']))(page, class { constructor(public type: string) {} });
    const M = page.Marionette!; const robots = () => M.latest('robots') as Record<string, RobotView>;
    const config = (sessionId: string, phone: string | undefined, list: { id: string; name: string; connected: boolean }[]) => M._receive({ type: 'config', payload: { ...defaultConfig(), sessionId, ...(phone ? { phone: { id: phone, name: phone, color: '#c98200', connected: true } } : {}), robots: list } });
    const state = (robotId: string, fields: { phoneId?: string; state: object }) => M._receive({ type: 'robot_state', payload: { type: 'robot_state', version: PROTOCOL_VERSION, robotId, ...fields } });
    const axol = { id: 'axol', name: 'Axol', connected: true }, arm = { id: 'arm', name: 'Arm', connected: true };
    config('g1', 'phone-1', [axol, arm]); state('axol', { state: { ready: true } }); state('axol', { phoneId: 'phone-1', state: { arm: 'left' } }); state('arm', { state: { homed: true } });
    expect(robots().axol).toMatchObject({ state: { ready: true }, phoneState: { arm: 'left' } });
    // A mirror that now follows phone 2: what the robots said to phone 1 is gone, what they said to every phone stays.
    config('g1', 'phone-2', [axol, arm]);
    expect(robots().axol.phoneState).toBeUndefined(); expect(robots().axol.state).toEqual({ ready: true });
    state('axol', { phoneId: 'phone-1', state: { arm: 'left' } }); expect(robots().axol.phoneState).toBeUndefined();
    state('axol', { phoneId: 'phone-2', state: { arm: 'right' } }); expect(robots().axol.phoneState).toEqual({ arm: 'right' });
    // The same gateway, no longer listing a robot: it reads as not connected, its state kept.
    config('g1', 'phone-2', [axol]); expect(robots().arm).toMatchObject({ connected: false, state: { homed: true } }); expect(robots().axol.connected).toBe(true);
    // A restarted gateway: nothing from before lingers, connected or not.
    config('g2', 'phone-2', []); expect(robots()).toEqual({});
    config('g2', 'phone-2', [{ ...axol, connected: false }]); expect(robots()).toEqual({ axol: { id: 'axol', name: 'Axol', connected: false } });
    // A config without a phone (a mirror whose phone left) clears the phone's view too.
    state('axol', { phoneId: 'phone-2', state: { arm: 'right' } }); config('g2', undefined, [axol]); expect(robots().axol.phoneState).toBeUndefined();
  });
});
