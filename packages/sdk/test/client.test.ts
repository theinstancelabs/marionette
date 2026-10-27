import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { CLOSE_CODES } from '@marionette/protocol';
import { GatewayClient, resolveAddress, type GatewayMessage } from '../src/index.js';

/** A stand-in gateway that records what clients send; `onHello` decides what happens next. */
async function fakeGateway(onHello: (socket: WebSocket, hello: any, count: number) => void = socket => socket.send(JSON.stringify({ type: 'config', version: 1, sessionId: 'fake' }))) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await new Promise(resolve => server.once('listening', resolve));
  const received: any[] = []; const sockets: WebSocket[] = []; const opened: number[] = []; let hellos = 0;
  server.on('connection', socket => {
    sockets.push(socket); opened.push(Date.now());
    socket.on('message', data => { const message = JSON.parse(String(data)); received.push(message); if (message.type === 'hello') onHello(socket, message, ++hellos); });
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}/ws`, port, server, received, sockets, opened, of: (type: string) => received.filter(m => m.type === type),
    close: () => new Promise<void>(resolve => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()); }) };
}
const waitFor = async (check: () => boolean, timeoutMs = 3000) => { const start = Date.now(); while (!check()) { if (Date.now() - start > timeoutMs) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });
const track = <T extends { close(): unknown }>(thing: T) => { cleanup.push(() => thing.close()); return thing; };

describe('addresses', () => {
  it('reads what an operator types, and every host of a pairing link with its code', () => {
    expect(resolveAddress('192.168.1.20')).toEqual({ urls: ['ws://192.168.1.20:8787/ws'] });
    expect(resolveAddress('robot.local:9000')).toEqual({ urls: ['ws://robot.local:9000/ws'] });
    expect(resolveAddress('https://gw.example.com')).toEqual({ urls: ['wss://gw.example.com:8787/ws'] });
    expect(resolveAddress('marionette://pair?v=1&host=10.0.0.5,100.64.0.2&port=8788&code=K7Q2M9XD&id=gw-1')).toEqual({ urls: ['ws://10.0.0.5:8788/ws', 'ws://100.64.0.2:8788/ws'], token: 'K7Q2M9XD' });
    expect(() => resolveAddress('not an address!')).toThrow(/not a gateway address/);
  });
});

describe('GatewayClient', () => {
  it('says hello with its role, token and robot id, and connects when the config arrives', async () => {
    const gateway = await fakeGateway(); track(gateway);
    const client = track(new GatewayClient(gateway.url, { role: 'robot', robotId: 'axol', name: 'Axol', token: 'k7q2-m9xd', cameras: false }));
    const events: string[] = []; client.on('connect', () => events.push('connect')); client.on('message', m => events.push(m.type));
    await client.whenConnected();
    expect(gateway.of('hello')[0]).toEqual({ type: 'hello', version: 1, role: 'robot', token: 'k7q2-m9xd', robotId: 'axol', name: 'Axol', cameras: false });
    expect(events).toEqual(['connect', 'config']);
    expect(() => new GatewayClient(gateway.url, { role: 'robot', robotId: 'Axol!' })).toThrow(/robotId/);
  });

  it('sends notices in order, coalesces state and frames to the newest, and sends small messages before frames', async () => {
    const gateway = await fakeGateway(); track(gateway);
    const client = track(new GatewayClient(gateway.url)); await client.whenConnected();
    for (let i = 0; i < 5; i++) client.send({ type: 'camera_frame', version: 1, sessionId: 's', cameraId: 'head', dataUrl: `data:image/jpeg;base64,${i}`, capturedAt: i });
    client.send({ type: 'camera_frame', version: 1, sessionId: 's', cameraId: 'arm', dataUrl: 'data:image/jpeg;base64,a', capturedAt: 0 });
    for (let i = 0; i < 3; i++) client.send({ type: 'robot_state', version: 1, state: { i } });
    client.send({ type: 'robot_state', version: 1, phoneId: 'phone-1', state: { mine: true } });
    client.send({ type: 'status', version: 1, sessionId: 's', controlId: 'robot.notice', message: 'one' });
    client.send({ type: 'status', version: 1, sessionId: 's', controlId: 'robot.notice', message: 'two' });
    client.send({ type: 'robot_state', version: 1, state: { custom: 1 } }, { key: 'mine' }); client.send({ type: 'robot_state', version: 1, state: { custom: 2 } }, { key: 'mine' });
    await waitFor(() => gateway.of('camera_frame').length === 2);
    await new Promise(r => setTimeout(r, 30));
    const sent = gateway.received.filter(m => m.type !== 'hello' && m.type !== 'ping').map(m => m.type === 'camera_frame' ? `frame ${m.cameraId} ${m.dataUrl.slice(-1)}` : m.type === 'status' ? `notice ${m.message}` : `state ${JSON.stringify(m.state)}${m.phoneId ? ` ${m.phoneId}` : ''}`);
    expect(sent).toEqual(['state {"i":2}', 'state {"mine":true} phone-1', 'notice one', 'notice two', 'state {"custom":2}', 'frame head 4', 'frame arm a']);
  });

  it('drops messages while disconnected', async () => {
    const gateway = await fakeGateway(() => {}); track(gateway);
    const client = track(new GatewayClient(gateway.url)); await waitFor(() => gateway.of('hello').length === 1);
    expect(client.connected).toBe(false); expect(client.send({ type: 'status', version: 1, sessionId: 's', message: 'lost' })).toBe(false);
  });

  it('answers pings and measures the round trip and clock offset from its own', async () => {
    // A gateway whose clock is 5 s ahead of ours.
    const gateway = await fakeGateway(socket => {
      socket.send(JSON.stringify({ type: 'config', version: 1, sessionId: 'fake' }));
      socket.on('message', data => { const m = JSON.parse(String(data)); if (m.type === 'ping') setTimeout(() => socket.send(JSON.stringify({ type: 'pong', version: 1, id: m.id, sentAt: m.sentAt, at: Date.now() + 5000 })), 4); });
      socket.send(JSON.stringify({ type: 'ping', version: 1, id: 7, sentAt: 123.5, rttMs: 3 }));
    }); track(gateway);
    const client = track(new GatewayClient(gateway.url, { pingMs: 50 }));
    const seen: GatewayMessage[] = []; client.on('message', m => seen.push(m));
    await waitFor(() => client.offsetMs !== undefined && gateway.of('pong').length === 1);
    expect(gateway.of('pong')[0]).toMatchObject({ type: 'pong', version: 1, id: 7, sentAt: 123.5, at: expect.any(Number) });
    expect(Math.abs(gateway.of('pong')[0].at - Date.now())).toBeLessThan(1000);
    await waitFor(() => gateway.of('ping').length >= 3);
    expect(client.offsetMs!).toBeGreaterThan(-5000 - 30); expect(client.offsetMs!).toBeLessThan(-5000 + 30);
    expect(client.rttMs!).toBeGreaterThanOrEqual(3); expect(Math.abs(client.gatewayNow()! - (Date.now() + 5000))).toBeLessThan(50);
    expect(seen.map(m => m.type)).toEqual(['config']);
  });

  it('reconnects with backoff, says why for 4401 and 4409, and reports a lost connection once', async () => {
    const gateway = await fakeGateway((socket, _hello, count) => {
      if (count === 1) socket.close(CLOSE_CODES.pairingRequired, 'Wrong pairing code');
      else if (count === 2) socket.close(CLOSE_CODES.robotIdInUse, 'A robot with id axol is already connected');
      else socket.send(JSON.stringify({ type: 'config', version: 1, sessionId: 'fake' }));
    }); track(gateway);
    const client = track(new GatewayClient(gateway.url, { role: 'robot', robotId: 'axol', token: 'nope' }));
    const errors: [string, number | undefined][] = []; client.on('error', (message, code) => errors.push([message, code]));
    let lost = 0; client.on('lost', () => lost++);
    await client.whenConnected(5000);
    expect(errors[0][1]).toBe(4401); expect(errors[0][0]).toMatch(/refused the pairing code \(Wrong pairing code\)/);
    expect(errors[1][1]).toBe(4409); expect(errors[1][0]).toMatch(/robot with id "axol" is already connected/);
    expect(client.error).toBeUndefined();
    // 0.5 s, then 1 s.
    expect(gateway.opened[1] - gateway.opened[0]).toBeGreaterThanOrEqual(450); expect(gateway.opened[2] - gateway.opened[1]).toBeGreaterThanOrEqual(950);
    gateway.sockets[2].close(1001, 'Going away');
    await waitFor(() => !client.connected); expect(lost).toBe(1); expect(client.error).toMatch(/Lost the gateway/);
    // Back after the shortest wait, since it had connected.
    const dropped = Date.now(); await client.whenConnected(3000); expect(Date.now() - dropped).toBeLessThan(1000);
  });

  it('drops a connection that goes quiet, and tries each host of a pairing link', async () => {
    const quiet = await fakeGateway(() => {}); track(quiet);
    const client = track(new GatewayClient(`marionette://pair?v=1&host=127.0.0.1&port=${quiet.port}`, { deadAfterMs: 300, minBackoffMs: 50 }));
    await waitFor(() => quiet.sockets.length >= 2, 3000);
    expect(client.error).toMatch(/no answer for 0.3 s/);
    const good = await fakeGateway(); track(good);
    // An unreachable host first: the client moves on to the next one.
    const linked = track(new GatewayClient(`marionette://pair?v=1&host=127.0.0.2,127.0.0.1&port=${good.port}&code=ABCD2345`, { deadAfterMs: 500, minBackoffMs: 50 }));
    await linked.whenConnected(4000); expect(linked.url).toBe(`ws://127.0.0.1:${good.port}/ws`); expect(good.of('hello')[0].token).toBe('ABCD2345');
  });

  it('iterates over messages until closed, and close stops reconnecting', async () => {
    const gateway = await fakeGateway(socket => { socket.send(JSON.stringify({ type: 'config', version: 1, sessionId: 'fake' })); socket.send(JSON.stringify({ type: 'status', version: 1, sessionId: 'fake', message: 'hi' })); }); track(gateway);
    const client = new GatewayClient(gateway.url); const types: string[] = [];
    let lost = 0; client.on('lost', () => lost++);
    for await (const message of client) { types.push(message.type); if (message.type === 'status') client.close(); }
    expect(types).toEqual(['config', 'status']); expect(lost).toBe(1);
    await new Promise(r => setTimeout(r, 700)); expect(gateway.of('hello')).toHaveLength(1);
  });
});
