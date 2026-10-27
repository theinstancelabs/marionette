import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayClient, PhoneTracker, RobotLink, gate } from '../src/index.js';
import { watchScreen } from '../src/node.js';
import { SimPhone, startGateway, type TestGateway } from '../src/testing/index.js';

const waitFor = async <T>(check: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> => {
  const start = Date.now();
  for (;;) { const value = check(); if (value) return value; if (Date.now() - start > timeoutMs) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });
const track = <T extends { close(): unknown }>(thing: T) => { cleanup.push(() => thing.close()); return thing; };
const gatewayFor = async (options: Parameters<typeof startGateway>[0] = {}) => track(await startGateway(options));
const phoneOn = async (gateway: TestGateway, options: ConstructorParameters<typeof SimPhone>[1] = {}) => track(await SimPhone.connect(gateway.url, options));
const robotOn = async (gateway: TestGateway, options: Partial<ConstructorParameters<typeof RobotLink>[1]> = {}) => { const link = track(new RobotLink(gateway.url, { robotId: 'axol', name: 'Axol', tracker: true, ...options })); await link.client.whenConnected(); return link; };
const near = (a: number[], b: number[], tolerance = 0.005) => a.forEach((value, i) => expect(Math.abs(value - b[i])).toBeLessThan(tolerance));
const SCREEN = (title: string, extra = '') => `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p>
<script type="application/json" id="marionette-config">{"controls":[{"id":"deadman","type":"button","label":"Hold","action":"teleop.deadman","hold":true},{"id":"estop","type":"toggle","label":"Stop","action":"safety.estop","value":false}${extra}]}</script></body></html>`;

describe('RobotLink against the real gateway', () => {
  it('pushes its screen, hears a refusal, and the previous screen stays', async () => {
    const gateway = await gatewayFor(); const phone = await phoneOn(gateway); const link = await robotOn(gateway);
    const shown = await link.setScreen(SCREEN('Axol'), 'Axol');
    expect(shown).toMatchObject({ accepted: true, message: expect.stringMatching(/Showing your screen \(1 phone connected\)/) });
    const config = await phone.waitFor(() => phone.messages.filter(m => m.type === 'html_config' && m.source?.kind === 'robot').at(-1));
    expect(config).toMatchObject({ title: 'Axol', source: { kind: 'robot', robotId: 'axol' } });
    await phone.waitFor(() => phone.config!.controls.length === 2);
    const broken = await link.setScreen('<p>broken</p><script type="application/json" id="marionette-config">{"controls": [</script>');
    expect(broken.accepted).toBe(false); expect(broken.message).toMatch(/Screen refused/);
    expect((await gateway.state()).robots).toEqual([expect.objectContaining({ id: 'axol', name: 'Axol', connected: true, screen: true })]);
    expect(await link.setScreen(SCREEN('Axol'), 'Axol')).toMatchObject({ accepted: true, message: 'This screen is already showing' });
    expect(await link.setScreen('')).toMatchObject({ accepted: false });
  });

  it('routes state to every phone or one, re-sends it every everyMs and at once on change, and replays it to late phones', async () => {
    const gateway = await gatewayFor(); const one = await phoneOn(gateway, { deviceId: 'one' }); const two = await phoneOn(gateway, { deviceId: 'two' });
    const link = await robotOn(gateway, { everyMs: 100 });
    link.state({ ready: true, battery: null, frames: ['axol', 'head'] }); link.state({ arm: 'left' }, one.id);
    await one.waitFor(() => one.robotStates().some(m => m.phoneId === 'phone-1') && one.robotStates().some(m => !m.phoneId));
    expect(one.robotStates().find(m => !m.phoneId)).toMatchObject({ robotId: 'axol', state: { ready: true, battery: null, frames: ['axol', 'head'] }, everyMs: 100, sentAt: expect.any(Number), receivedAt: expect.any(Number) });
    await sleep(450);
    expect(two.robotStates().filter(m => !m.phoneId).length).toBeGreaterThanOrEqual(4); expect(two.robotStates().some(m => m.phoneId)).toBe(false);
    // A change goes out at once, not at the next re-send: its sentAt is when state() was called.
    const changed = Date.now(); link.state({ ready: false });
    const fresh = await one.waitFor(() => one.robotStates().find(m => m.state?.ready === false)); expect(fresh.sentAt - changed).toBeLessThan(20);
    const late = await phoneOn(gateway, { deviceId: 'late' });
    await late.waitFor(() => late.robotStates().length > 0);
    expect(late.robotStates()[0]).toMatchObject({ robotId: 'axol', state: { ready: false } });
    link.state(null, one.id); const count = one.robotStates().filter(m => m.phoneId).length; await sleep(250);
    expect(one.robotStates().filter(m => m.phoneId).length).toBe(count);
    expect(() => link.state({ big: 'x'.repeat(70_000) })).toThrow(/64 KB/);
  });

  it('sends notices to one phone or all, never coalesced, and JPEG frames to the phones watching', async () => {
    const gateway = await gatewayFor(); const one = await phoneOn(gateway, { deviceId: 'one' }); const two = await phoneOn(gateway, { deviceId: 'two' }); const link = await robotOn(gateway);
    await link.setScreen(SCREEN('Cams').replace('"controls"', '"cameraStreams":[{"id":"wrist","label":"Wrist","url":"robot://wrist","status":"live"}],"controls"'));
    link.notice('Lift at its top', { phoneId: one.id, values: { lift: { at: 0.8 } } }); link.notice('Second', { phoneId: one.id }); link.notice('Everyone');
    await one.waitFor(() => one.statuses('robot.notice').length === 3);
    expect(one.statuses('robot.notice').map(m => m.message)).toEqual(['Lift at its top', 'Second', 'Everyone']);
    expect(one.statuses('robot.notice')[0]).toMatchObject({ sessionId: 'axol', phoneId: 'phone-1', values: { lift: { at: 0.8 } } });
    await two.waitFor(() => two.statuses('robot.notice').length === 1); expect(two.statuses('robot.notice')[0].message).toBe('Everyone');
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await one.waitFor(() => { link.sendJpeg('wrist', jpeg, 1234); return one.frames.get('wrist'); });
  });

  it('refuses a second robot with the same id (4409) until the first goes away', async () => {
    const gateway = await gatewayFor(); const first = await robotOn(gateway);
    const second = track(new RobotLink(gateway.url, { robotId: 'axol', minBackoffMs: 100, maxBackoffMs: 300 }));
    const [message, code] = await new Promise<[string, number | undefined]>(resolve => second.on('error', (m, c) => resolve([m, c])));
    expect(code).toBe(4409); expect(message).toMatch(/already connected/); expect(second.connected).toBe(false);
    await sleep(400); expect(first.connected).toBe(true); expect(second.connected).toBe(false);
    first.close(); await second.client.whenConnected(3000);
    expect((await gateway.state()).robots).toEqual([expect.objectContaining({ id: 'axol', connected: true })]);
  });

  it('measures its clock offset from the gateway, and refuses without the pairing code where it is needed', async () => {
    const gateway = await gatewayFor(); const link = await robotOn(gateway);
    await waitFor(() => link.client.offsetMs !== undefined);
    expect(Math.abs(link.client.offsetMs!)).toBeLessThan(20); expect(link.client.rttMs!).toBeLessThan(100);
    const paired = await gatewayFor({ auth: 'strict', token: 'K7Q2M9XD' });
    const without = track(new GatewayClient(paired.url, { maxBackoffMs: 300 }));
    const error = await new Promise<string>(resolve => without.on('error', (m, c) => { if (c === 4401) resolve(m); }));
    expect(error).toMatch(/needs its pairing code/);
    const withCode = track(new GatewayClient(paired.url, { token: 'k7q2-m9xd' })); await withCode.whenConnected();
    const link2 = track(new GatewayClient(`marionette://pair?v=1&host=127.0.0.1&port=${paired.port}&code=K7Q2M9XD`)); await link2.whenConnected();
  });

  it('re-sends a screen file on save (Node helper)', async () => {
    const gateway = await gatewayFor(); const phone = await phoneOn(gateway); const link = await robotOn(gateway);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marionette-sdk-')); cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'screen.html'); fs.writeFileSync(file, SCREEN('First'));
    const watch = watchScreen(link, file, { intervalMs: 50 }); cleanup.push(() => watch.stop());
    expect((await watch.ready).accepted).toBe(true);
    await sleep(60); fs.writeFileSync(file, SCREEN('Second, saved'));
    await phone.waitFor(() => phone.messages.some(m => m.type === 'html_config' && m.html.includes('Second, saved')), 3000);
  });
});

describe('SimPhone and the tracker against the real gateway', () => {
  it('runs guided calibration and validation through the gateway, and moves in the calibrated frame', async () => {
    const gateway = await gatewayFor(); const link = await robotOn(gateway); const tracker = link.tracker!;
    const phone = await phoneOn(gateway, { yawDeg: 40 });
    await phone.glide({ forward: 0.05, right: -0.02 });
    await phone.calibrate();
    expect(phone.calibration).toMatchObject({ status: 'captured', epoch: 1, reference: { mode: 'guided' } });
    await waitFor(() => tracker.get('phone-1')?.pose?.calibration === 'guided-v2:1' && Math.abs(tracker.get('phone-1')!.pose!.position[2]) < 0.01);
    near([...tracker.get('phone-1')!.pose!.position], [0, 0, 0]);
    expect(await phone.validate()).toBe(true);
    // Physically 10 cm along the phone's heading and 5 cm up reads as +X and +Z in the calibrated frame.
    await phone.glide({ forward: 0.15, up: 0.05 }, 100);
    await waitFor(() => tracker.get('phone-1')!.pose!.position[0] > 0.09);
    near([...tracker.get('phone-1')!.pose!.position], [0.1, 0, 0.05]);
    // Operator-frame targets come out as given.
    phone.moveTo({ x: 0.2, y: -0.1, z: 0.3 }, { x: 0, y: 0, z: Math.sin(0.3), w: Math.cos(0.3) });
    await waitFor(() => tracker.get('phone-1')!.pose!.position[0] > 0.19);
    near([...tracker.get('phone-1')!.pose!.position], [0.2, -0.1, 0.3], 1e-6);
    const q = tracker.get('phone-1')!.pose!.quaternion; near([q.x, q.y, q.z, q.w].map(v => v * Math.sign(q.w)), [0, 0, Math.sin(0.3), Math.cos(0.3)], 1e-6);
    // Same session: the calibration stays. A new session starts over.
    await phone.reconnect(); expect(phone.calibration).toMatchObject({ status: 'captured', epoch: 1 });
    await phone.reconnect({ newSession: true }); await phone.waitFor(() => phone.calibration?.status === 'uncalibrated');
    await phone.quickOrigin(); expect(phone.calibration).toMatchObject({ status: 'captured', reference: { mode: 'quick' } });
  }, 15_000);

  it('stamps latency through the gateway, so pose ages are small even with a phone clock far off', async () => {
    const gateway = await gatewayFor(); const link = await robotOn(gateway);
    const phone = await phoneOn(gateway, { clockOffsetMs: 4000 });
    await waitFor(() => link.tracker!.get(phone.id!)?.pose?.latencyMs !== undefined && link.client.offsetMs !== undefined);
    const pose = link.tracker!.get(phone.id!)!.pose!;
    // The phone's clock is 4 s ahead, and none of that shows up in the latency or the age.
    expect(pose.latencyMs!).toBeLessThan(200); expect(pose.sentAt! - Date.now()).toBeGreaterThan(3000);
    expect(pose.age(link.tracker!.now())).toBeGreaterThanOrEqual(0); expect(pose.age(link.tracker!.now())).toBeLessThan(500);
    expect(gate(link.tracker!.get(phone.id!), link.tracker!.now())).toBeUndefined();
    phone.press('teleop.deadman');
    await waitFor(() => link.tracker!.get(phone.id!)!.hold('teleop.deadman').down);
  });

  it('follows holds, drags and the mirror policy from real traffic', async () => {
    const gateway = await gatewayFor({ holdTimeoutMs: 500, streamTimeoutMs: 300 }); const link = await robotOn(gateway); const tracker = link.tracker!;
    const phone = await phoneOn(gateway); const now = () => tracker.now();
    const p = () => tracker.get('phone-1')!;
    // The robot hears about the phone on its own connection, a moment after the phone has its config.
    await waitFor(() => tracker.get('phone-1')?.connected);
    phone.press('teleop.deadman'); await waitFor(() => p().hold('teleop.deadman').down);
    await sleep(450); expect(p().holding('teleop.deadman', now())).toBe(true); expect(p().presses('teleop.deadman')).toBe(1);
    // The renewals stop: the gateway ends the hold, and renewals that come back never restart it.
    phone.pauseRenewals(); await waitFor(() => !p().hold('teleop.deadman').down, 2000);
    phone.pauseRenewals(false); await sleep(450); expect(p().hold('teleop.deadman').down).toBe(false);
    phone.release('teleop.deadman'); phone.press('teleop.deadman'); await waitFor(() => p().hold('teleop.deadman').down); expect(p().presses('teleop.deadman')).toBe(2);
    phone.release('teleop.deadman');
    phone.stick('base.drive', { x: 0.5, y: 0.25 }); await waitFor(() => p().drag('base.drive')?.live);
    expect(p().stick('base.drive', now())).toEqual({ x: 0.5, y: 0.25 });
    phone.pauseRenewals(); await waitFor(() => p().drag('base.drive')?.dropped, 2000);
    expect(p().stick('base.drive', now())).toEqual({ x: 0, y: 0 });
    phone.pauseRenewals(false); phone.stick('base.drive', { x: 0.9, y: 0 }); await sleep(200);
    expect(p().drag('base.drive')).toMatchObject({ live: false, dropped: true });
    phone.letGo('base.drive'); await waitFor(() => !p().drag('base.drive')?.dropped);
    phone.drag('teleop.translationScale', 2.5); await waitFor(() => p().value('teleop.translationScale') === 2.5); phone.letGo('teleop.translationScale');
    // A desktop mirror: by default only its Stop counts.
    const mirror = await phoneOn(gateway, { mirrorOf: 'phone-1' });
    mirror.press('teleop.deadman'); mirror.set('arm.select', 'right'); await sleep(150);
    expect(p().hold('teleop.deadman').down).toBe(false);
    mirror.set('safety.estop', true); await waitFor(() => p().stop); expect(tracker.anyStop()).toBe(true);
    mirror.release('teleop.deadman');
    // The phone leaving lets go of everything; Stop stays.
    phone.press('teleop.deadman'); await waitFor(() => p().hold('teleop.deadman').down);
    await phone.disconnect(); await waitFor(() => !p().connected);
    expect(p()).toMatchObject({ pose: null, stop: true }); expect(p().hold('teleop.deadman').down).toBe(false);
  }, 15_000);

  it('keeps a desk mirror from changing values through the configs the gateway republishes', async () => {
    const gateway = await gatewayFor({ streamTimeoutMs: 300 });
    const trackers = Object.fromEntries((['stop-only', 'deny', 'allow'] as const).map(mirror => {
      const tracker = new PhoneTracker({ mirror }); tracker.attach(track(new GatewayClient(gateway.url, { cameras: false }))); return [mirror, tracker];
    }));
    const phone = await phoneOn(gateway); const all = Object.values(trackers);
    await waitFor(() => all.every(tracker => tracker.get('phone-1')?.connected));
    const mirror = await phoneOn(gateway, { mirrorOf: 'phone-1' });
    mirror.set('arm.select', 'right'); mirror.set('teleop.translationScale', 4); mirror.set('lift.toggle', false);
    // A drag the mirror lets go of by going quiet: the gateway ends it with the mirror's last value.
    mirror.drag('base.speedLimit', 90); mirror.pauseRenewals();
    await waitFor(() => trackers.allow.get('phone-1')!.drag('base.speedLimit')?.dropped, 3000);
    // The phone's own change comes after all of that on every connection.
    phone.set('camera.view', 'arms'); await waitFor(() => all.every(tracker => tracker.get('phone-1')!.value('camera.view') === 'arms'));
    for (const policy of ['stop-only', 'deny'] as const) {
      expect(trackers[policy].get('phone-1')!.values, policy).toMatchObject({ 'arm.select': 'left', 'teleop.translationScale': 1, 'lift.toggle': true, 'base.speedLimit': 50 });
    }
    expect(trackers.allow.get('phone-1')!.values).toMatchObject({ 'arm.select': 'right', 'teleop.translationScale': 4, 'lift.toggle': false, 'base.speedLimit': 90 });
  });

  it('keeps Stop through a gateway restart until cleared, and the robot puts its screen and state back', async () => {
    const gateway = await gatewayFor(); const link = await robotOn(gateway, { minBackoffMs: 100 }); const tracker = link.tracker!;
    await link.setScreen(SCREEN('Axol'), 'Axol'); link.state({ ready: true });
    const phone = await phoneOn(gateway, { deviceId: 'left-hand' }); const other = await phoneOn(gateway, { deviceId: 'right-hand' });
    phone.set('safety.estop', true); await waitFor(() => tracker.anyStop());
    const old = tracker.gateway!;
    let lost = 0; link.on('lost', () => lost++);
    await gateway.restart();
    await waitFor(() => lost === 1); expect(tracker.get('phone-1')!.connected).toBe(false);
    // The phone that came back first gets phone-1 on the new gateway.
    await other.reconnect(); await link.client.whenConnected(5000);
    await waitFor(() => tracker.gateway !== old && tracker.get('phone-1')?.connected);
    expect(tracker.get(`phone-1@${old}`)).toMatchObject({ connected: false, stop: true });
    expect(tracker.get('phone-1')).toMatchObject({ stop: false }); expect(tracker.get('phone-2')).toBeUndefined(); expect(tracker.anyStop()).toBe(true);
    await other.waitFor(() => other.messages.some(m => m.type === 'html_config' && m.source?.robotId === 'axol') && other.robotStates().some(m => m.state.ready === true));
    tracker.clearStaleStops(); expect(tracker.anyStop()).toBe(false); expect(tracker.get(`phone-1@${old}`)).toBeUndefined();
    expect(phone.connected).toBe(false);
  }, 15_000);
});

describe('PhoneTracker on a console', () => {
  it('attaches to a plain console client', async () => {
    const gateway = await gatewayFor(); const tracker = new PhoneTracker(); const client = track(new GatewayClient(gateway.url, { cameras: false }));
    const detach = tracker.attach(client); await client.whenConnected();
    const phone = await phoneOn(gateway);
    await waitFor(() => tracker.get(phone.id!)?.pose); expect(tracker.get(phone.id!)).toMatchObject({ connected: true, name: 'Phone 1', calibration: 'uncalibrated' });
    detach(); phone.set('safety.estop', true); await sleep(100); expect(tracker.anyStop()).toBe(false);
  });
});
