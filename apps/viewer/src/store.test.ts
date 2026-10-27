import { describe, expect, it } from 'vitest';
import { defaultConfig, phoneColor, type ConfigMessage, type InputMessage, type PhoneInfo, type PosePacket, type UiControl } from '@marionette/protocol';
import type { ConsoleEvent } from './events';
import { ViewerStore } from './store';

/** A store on a fake clock, with every logged event collected. */
function setup() {
  const clock = { now: 0, wall: 1_000_000 };
  const events: ConsoleEvent[] = []; let configChanges = 0;
  const store = new ViewerStore({ onConfigs: () => { configChanges++; }, onEvents: batch => events.push(...batch) }, { now: () => clock.now, wall: () => clock.wall });
  const advance = (ms: number) => { clock.now += ms; clock.wall += ms; store.tick(); };
  const log = () => events.map(event => `${event.phoneId ?? 'gateway'}: ${event.message}`);
  return { store, clock, events, advance, log, configChanges: () => configChanges };
}
const info = (n: number, connected = true): PhoneInfo => ({ id: `phone-${n}`, name: `Phone ${n}`, color: phoneColor(n - 1), connected });
const gatewayConfig = (phones: PhoneInfo[]): ConfigMessage => ({ ...defaultConfig(), sessionId: 'gw', phones });
const phoneConfig = (phone: PhoneInfo, phones: PhoneInfo[], edit: (controls: UiControl[]) => UiControl[] = c => c, calibration: ConfigMessage['calibration'] = { status: 'uncalibrated', epoch: 0 }): ConfigMessage =>
  ({ ...gatewayConfig(phones), phone, controls: edit(defaultConfig().controls), calibration });
const set = (id: string, patch: Partial<UiControl>) => (controls: UiControl[]) => controls.map(c => c.id === id ? { ...c, ...patch } as UiControl : c);
const pose = (phoneId: string | undefined, seq: number, x: number, over: Partial<PosePacket> = {}): PosePacket => ({ type: 'pose', version: 1, sessionId: `s-${phoneId}`, seq, monotonicTs: seq / 60, position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
  covariance: [0.0025, 0.0025, 0.0025, 0.01, 0.01, 0.01], source: 'arkit', trackingState: 'normal', calibrationVersion: 'arkit-gravity-v2', heartbeat: true, phoneId, ...over });
const input = (phoneId: string, over: Partial<InputMessage> = {}): InputMessage => ({ type: 'input', version: 1, phoneId, controlId: 'deadman', action: 'teleop.deadman', value: true, source: 'phone', receivedAt: 1, ...over });

/** What a gateway sends a console that just said hello, with two phones on it. */
function connectTwo(store: ViewerStore) {
  const roster = [info(1), info(2)];
  store.receive({ type: 'status', version: 1, sessionId: 'gw', message: 'Connected to Marionette gateway', values: { connectedClients: 3 } });
  store.receive(gatewayConfig(roster));
  store.receive(phoneConfig(roster[0], roster));
  store.receive(phoneConfig(roster[1], roster, set('arm', { value: 'right' })));
  return roster;
}

describe('multi-phone state', () => {
  it('keeps the roster order and each phone its own config', () => {
    const { store } = setup(); connectTwo(store);
    expect(store.phones().map(phone => [phone.name, phone.color, phone.config?.controls.find(c => c.id === 'arm')?.type === 'select' && (phone.config.controls.find(c => c.id === 'arm') as { value: string }).value]))
      .toEqual([['Phone 1', '#c98200', 'left'], ['Phone 2', '#b04fc4', 'right']]);
  });

  it('routes poses by phone, each with its own trail, history and presence', () => {
    const { store, advance } = setup(); connectTwo(store);
    for (let i = 1; i <= 30; i++) { store.receive(pose('phone-1', i, i / 100)); store.receive(pose('phone-2', i, -i / 100)); advance(16); }
    const one = store.live.phones.get('phone-1')!, two = store.live.phones.get('phone-2')!;
    expect(one.history).toHaveLength(30); expect(two.history).toHaveLength(30);
    expect(one.pose?.position.x).toBeCloseTo(0.3); expect(two.pose?.position.x).toBeCloseTo(-0.3);
    expect(one.presence).toEqual({ present: true, sessionId: 's-phone-1', tracking: 'normal' });
    // Phone 2 goes quiet; Phone 1 keeps streaming.
    for (let i = 31; i <= 130; i++) { store.receive(pose('phone-1', i, 0.3)); advance(16); }
    expect(store.live.phones.get('phone-1')!.presence.present).toBe(true);
    expect(store.live.phones.get('phone-2')!.presence.present).toBe(false);
  });

  it('ignores poses it cannot attribute and messages that do not validate', () => {
    const { store } = setup(); connectTwo(store);
    store.receive(pose(undefined, 1, 0.1));
    store.receive({ ...pose('phone-1', 2, 0.1), rotation: { x: 0, y: 0, z: 0, w: 3 } });
    store.receive({ type: 'input', version: 1, phoneId: 'phone-1', controlId: 'deadman', action: 'teleop.deadman', source: 'robot', receivedAt: 1 });
    expect(store.live.phones.size).toBe(0);
  });

  it('gives a single-phone gateway’s unnamed poses to its only phone', () => {
    const { store } = setup();
    store.receive(gatewayConfig([info(1)]));
    store.receive(pose(undefined, 1, 0.1));
    expect(store.live.phones.get('phone-1')?.pose?.position.x).toBe(0.1);
  });

  it('keeps every camera stream’s latest frame', () => {
    const { store } = setup(); connectTwo(store);
    for (const cameraId of ['head', 'arm-left', 'arm-right']) store.receive({ type: 'camera_frame', version: 1, sessionId: 'gw', cameraId, dataUrl: `data:image/png;base64,${cameraId}`, capturedAt: 1 });
    expect([...store.live.cameras.keys()]).toEqual(['head', 'arm-left', 'arm-right']);
  });

  it('records inputs per phone: renewals only move the last-input time', () => {
    const { store, clock } = setup(); connectTwo(store);
    store.receive(input('phone-1'));
    clock.wall += 200; store.receive(input('phone-1', { renew: true }));
    store.receive(input('phone-2', { controlId: 'arm', action: 'arm.select', value: 'left' }));
    const one = store.live.phones.get('phone-1')!;
    expect(one.inputs.map(record => record.input.value)).toEqual([true]);
    expect(one.lastInputAt).toBe(1_000_200);
    expect(one.holding.has('deadman')).toBe(true);
    expect(store.live.phones.get('phone-2')!.inputs.map(record => record.input.controlId)).toEqual(['arm']);
  });

  it('keeps a slider drag as one recent input', () => {
    const { store, clock } = setup(); connectTwo(store);
    for (const value of [1.1, 1.3, 1.6]) { store.receive(input('phone-1', { controlId: 'sensitivity', action: 'teleop.translationScale', value })); clock.wall += 100; }
    expect(store.live.phones.get('phone-1')!.inputs.map(record => record.input.value)).toEqual([1.6]);
  });
});

describe('live drags', () => {
  it('keeps a stick drag as one recent input with its latest sample, and logs only the push and the let-go', () => {
    const { store, clock, log } = setup(); connectTwo(store);
    const drive = (value: { x: number; y: number }, over: Partial<InputMessage> = {}) => { store.receive(input('phone-1', { controlId: 'drive', action: 'base.drive', value, live: true, ...over })); clock.wall += 30; };
    drive({ x: 0.2, y: 0 }); drive({ x: 0.5, y: 0.1 }); drive({ x: 0.5, y: 0.1 }, { renew: true });
    const one = store.live.phones.get('phone-1')!;
    expect(one.dragging.get('drive')).toEqual({ x: 0.5, y: 0.1 });
    drive({ x: 0, y: 0 }, { live: undefined }); store.journal.flush();
    expect(one.dragging.has('drive')).toBe(false);
    expect(one.inputs.map(record => record.input.value)).toEqual([{ x: 0, y: 0 }]);
    expect(log().filter(line => line.includes('Drive'))).toEqual(['phone-1: Drive pushed', 'phone-1: Drive let go']);
  });

  it('logs a drag the gateway ended once, even when the phone lets go afterwards', () => {
    const { store, clock, log } = setup(); connectTwo(store);
    store.receive(input('phone-1', { controlId: 'drive', action: 'base.drive', value: { x: 0.7, y: 0 }, live: true })); clock.wall += 500;
    store.receive(input('phone-1', { controlId: 'drive', action: 'base.drive', value: { x: 0, y: 0 }, source: 'gateway', reason: 'samples stopped' }));
    store.receive(input('phone-1', { controlId: 'drive', action: 'base.drive', value: { x: 0, y: 0 } })); store.journal.flush();
    expect(log().filter(line => line.includes('Drive'))).toEqual(['phone-1: Drive pushed', 'phone-1: Drive let go by the gateway (samples stopped)']);
  });
});

describe('event attribution', () => {
  it('tags connections, holds, Stop and arm changes with their phone', () => {
    const { store, advance, log } = setup(); const roster = connectTwo(store);
    store.receive(input('phone-1'));
    store.receive(phoneConfig(roster[0], roster, set('deadman', { held: true })));
    store.receive(input('phone-2', { controlId: 'estop', action: 'safety.estop', value: true }));
    store.receive(phoneConfig(roster[1], roster, c => set('estop', { value: true })(set('arm', { value: 'right' })(c))));
    store.receive(phoneConfig(roster[0], roster, c => set('arm', { value: 'right' })(set('deadman', { held: true })(c))));
    store.receive(input('phone-1', { value: false, source: 'gateway', reason: 'hold not renewed' }));
    advance(300);
    expect(log()).toEqual([
      'gateway: Connected to Marionette gateway', 'phone-1: Connected', 'phone-2: Connected',
      'phone-1: Hold to move pressed', 'phone-2: Stop on', 'phone-1: Active arm: Right arm',
      'phone-1: Hold to move released by the gateway (hold not renewed)',
    ]);
    expect(store.phones().map(phone => phone.config?.controls.find(c => c.id === 'estop'))).toMatchObject([{ value: false }, { value: true }]);
  });

  it('logs a disconnect once, as the gateway sends it', () => {
    const { store, advance, log } = setup(); const roster = connectTwo(store);
    store.receive(pose('phone-2', 1, 0)); advance(16);
    store.receive(input('phone-2', { controlId: 'grip', action: 'gripper.hold' }));
    advance(300);
    // Stale pose, the gateway's release of the hold, the phone's config, then the roster.
    store.receive({ ...pose('phone-2', 1, 0), heartbeat: false, trackingState: 'unavailable', calibrationVersion: 'arkit-gravity-v2-stale' });
    store.receive(input('phone-2', { controlId: 'grip', action: 'gripper.hold', value: false, source: 'gateway', reason: 'phone disconnected' }));
    store.receive(phoneConfig(roster[1], roster, set('arm', { value: 'right' })));
    store.receive(gatewayConfig([info(1), info(2, false)]));
    advance(300); advance(2000);
    expect(log().slice(3)).toEqual(['phone-2: Streaming poses, tracking good', 'phone-2: Grip pressed', 'phone-2: Grip released by the gateway (phone disconnected)', 'phone-2: Disconnected']);
    expect(store.phones()[1].connected).toBe(false);
  });

  it('joins a calibration reply with the config change it explains, and shows refusals in red', () => {
    const { store, advance, events, log } = setup(); const roster = connectTwo(store);
    // The gateway replies first, then publishes the phone's new config.
    store.receive({ type: 'status', version: 1, sessionId: 'gw', controlId: 'calibration-start', message: 'Hold the phone roughly flat, screen up, top edge forward, then press Capture flat reference', values: { accepted: true }, phoneId: 'phone-1' });
    store.receive(phoneConfig(roster[0], roster, c => c, { status: 'capturing', epoch: 0, step: 'flat' }));
    store.receive({ type: 'status', version: 1, sessionId: 'gw', controlId: 'calibration', message: 'Hold the phone within 30° of flat', values: { accepted: false }, phoneId: 'phone-2' });
    advance(300);
    expect(log().slice(3)).toEqual(['phone-1: Guided calibration started. Hold the phone roughly flat, screen up, top edge forward, then press Capture flat reference', 'phone-2: Hold the phone within 30° of flat']);
    expect(events.at(-1)?.tone).toBe('fail');
    expect(store.live.phones.get('phone-2')?.reply).toMatchObject({ tone: 'fail' });
  });

  it('forgets a phone that leaves the roster, so a new phone given its id starts clean', () => {
    const { store, advance, log } = setup(); const roster = connectTwo(store);
    store.receive(pose('phone-2', 1, 0.2)); store.receive(input('phone-2', { controlId: 'grip', action: 'gripper.hold' }));
    store.receive(phoneConfig(roster[1], roster, set('grip', { held: true })));
    store.receive(gatewayConfig([info(1)]));
    advance(300);
    expect(store.phones().map(phone => phone.id)).toEqual(['phone-1']);
    expect(store.live.phones.has('phone-2')).toBe(false);
    expect(log().at(-1)).toBe('phone-2: Disconnected');
    store.receive(gatewayConfig([info(1), info(2)]));
    expect(store.phones()[1]).toMatchObject({ id: 'phone-2', connected: true, config: undefined });
  });

  it('logs a hold’s release once, even when the phone lets go after the gateway released it', () => {
    const { store, advance, log } = setup(); const roster = connectTwo(store);
    // Gateway order: relay the press, then publish the hold.
    store.receive(input('phone-1')); store.receive(phoneConfig(roster[0], roster, set('deadman', { held: true })));
    // Renewals stop: the gateway's release, then its config; the finger comes up a second later.
    store.receive(input('phone-1', { value: false, source: 'gateway', reason: 'renewals stopped' })); store.receive(phoneConfig(roster[0], roster));
    store.receive(input('phone-1', { value: false }));
    advance(300);
    expect(log().slice(3)).toEqual(['phone-1: Hold to move pressed', 'phone-1: Hold to move released by the gateway (renewals stopped)']);
    // The late release still shows in the phone's recent inputs.
    expect(store.live.phones.get('phone-1')!.inputs.map(record => record.input.source)).toEqual(['phone', 'gateway', 'phone']);
  });

  it('logs the release of a hold that was already on when the viewer connected', () => {
    const { store, advance, log } = setup(); const roster = [info(1)];
    store.receive(gatewayConfig(roster)); store.receive(phoneConfig(roster[0], roster, set('grip', { held: true })));
    store.receive(input('phone-1', { controlId: 'grip', action: 'gripper.hold', renew: true }));
    store.receive(input('phone-1', { controlId: 'grip', action: 'gripper.hold', value: false })); store.receive(phoneConfig(roster[0], roster));
    advance(300);
    expect(log()).toEqual(['phone-1: Connected', 'phone-1: Grip released']);
  });

  it('says so when a new connection from the same phone takes over', () => {
    const { store, advance, log } = setup(); const roster = [{ ...info(1), sessionId: 'arkit-a' }, info(2)];
    store.receive(gatewayConfig(roster)); store.receive(phoneConfig(roster[0], roster, c => c, { status: 'captured', epoch: 1 }));
    store.receive(pose('phone-1', 1, 0, { sessionId: 'arkit-a' })); advance(300);
    // attach(): the old stream's last pose, calibration cleared, then the roster with the session gone.
    store.receive({ ...pose('phone-1', 1, 0, { sessionId: 'arkit-a' }), heartbeat: false, trackingState: 'unavailable', calibrationVersion: 'guided-v2:1-stale' });
    const next = [info(1), info(2)];
    store.receive(gatewayConfig(next)); store.receive(phoneConfig(next[0], next, c => c, { status: 'uncalibrated', epoch: 2 }));
    advance(300);
    expect(log().slice(2)).toEqual(['phone-1: Streaming poses, tracking good', 'phone-1: Reconnected, replacing its previous connection', 'phone-1: Calibration cleared']);
  });

  it('keeps the name of a phone that left the roster for its log lines', () => {
    const { store } = setup(); connectTwo(store);
    store.receive(gatewayConfig([info(1)]));
    expect(store.seen.get('phone-2')).toEqual({ name: 'Phone 2', color: '#b04fc4' });
    store.reset();
    expect(store.seen.size).toBe(0);
  });

  it('gives every recent input its own id', () => {
    const { store } = setup(); connectTwo(store);
    for (let i = 0; i < 3; i++) store.receive(input('phone-1', { controlId: 'grip', action: 'gripper.hold', value: i % 2 === 0 }));
    const ids = store.live.phones.get('phone-1')!.inputs.map(record => record.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('notices tracking changes per phone', () => {
    const { store, advance, log } = setup(); connectTwo(store);
    store.receive(pose('phone-1', 1, 0)); store.receive(pose('phone-2', 1, 0)); advance(16);
    store.receive(pose('phone-2', 2, 0, { trackingState: 'limited' })); advance(300);
    expect(log().slice(3)).toEqual(['phone-1: Streaming poses, tracking good', 'phone-2: Streaming poses, tracking good', 'phone-2: Tracking limited']);
  });
});

describe('simulation', () => {
  it('runs two phones on their own arms, with distinct motion and holds', () => {
    const { store, clock, log } = setup();
    store.simulate();
    const phones = store.phones();
    expect(phones.map(phone => [phone.name, phone.color, (phone.config?.controls.find(c => c.id === 'arm') as { value: string }).value])).toEqual([['Phone 1', '#c98200', 'left'], ['Phone 2', '#b04fc4', 'right']]);
    expect(store.config.cameraViews).toEqual([]);
    for (let frame = 0; frame < 60 * 6; frame++) { clock.now += 1000 / 60; clock.wall += 1000 / 60; store.simulateFrame(); if (frame % 5 === 0) store.tick(); }
    store.tick(); store.journal.flush();
    const one = store.live.phones.get('phone-1')!, two = store.live.phones.get('phone-2')!;
    expect(one.presence.present && two.presence.present).toBe(true);
    expect(one.pose!.position.x).not.toBeCloseTo(two.pose!.position.x, 2);
    expect(log()).toEqual(expect.arrayContaining(['phone-1: Hold to move pressed', 'phone-2: Grip pressed', 'phone-2: Grip released']));
    expect(one.inputs.every(record => !record.input.renew)).toBe(true);
    // Phone 1 drives its stick from 6 s for 4 s: live while pushed, back to rest after.
    const drive = () => store.phoneConfigs['phone-1'].controls.find(c => c.id === 'drive') as { value: { x: number; y: number }; live?: boolean };
    for (let frame = 0; frame < 60 * 2; frame++) { clock.now += 1000 / 60; clock.wall += 1000 / 60; store.simulateFrame(); }
    expect(drive().live).toBe(true); expect(Math.hypot(drive().value.x, drive().value.y)).toBeLessThanOrEqual(1); expect(one.dragging.has('drive')).toBe(true);
    for (let frame = 0; frame < 60 * 3; frame++) { clock.now += 1000 / 60; clock.wall += 1000 / 60; store.simulateFrame(); }
    store.journal.flush(); expect(drive()).toMatchObject({ live: false, value: { x: 0, y: 0 } }); expect(log()).toEqual(expect.arrayContaining(['phone-1: Drive pushed', 'phone-1: Drive let go']));
  });
});
