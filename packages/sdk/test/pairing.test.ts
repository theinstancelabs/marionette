import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PairingError, fetchPairing, parsePairing, parsePairingLink } from '../src/index.js';
import { startGateway } from '../src/testing/index.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });
const gatewayFor = async (options: Parameters<typeof startGateway>[0] = {}) => { const gateway = await startGateway(options); cleanup.push(() => gateway.close()); return gateway; };
const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error('resolved'); }, (error: unknown) => error as PairingError);

/** A server that answers with whatever the test queues (status, body), and its address. */
async function answering(answers: [number, string][]): Promise<string> {
  const server = http.createServer((_req, res) => { const [status, body] = answers.shift()!; res.writeHead(status, { 'content-type': 'application/json' }).end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => server.close(resolve)));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const GOOD = { gatewayId: 'gw-ab12', name: 'Axol lab', auth: 'on', code: 'K7Q2-M9XD', addresses: ['10.1.10.220'], port: 8787,
  url: 'marionette://pair?v=1&host=10.1.10.220&port=8787&code=K7Q2M9XD&id=gw-ab12', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' };

describe('fetchPairing', () => {
  it('reads the gateway on its own computer without the code', async () => {
    const gateway = await gatewayFor({ auth: 'on', token: 'K7Q2M9XD', name: 'Axol lab', addresses: ['127.0.0.1'] });
    const pairing = await fetchPairing(`127.0.0.1:${gateway.port}`);
    expect(pairing).toMatchObject({ name: 'Axol lab', auth: 'on', code: 'K7Q2-M9XD', addresses: ['127.0.0.1'], port: gateway.port });
    expect(parsePairingLink(pairing.url)).toMatchObject({ code: 'K7Q2M9XD', gatewayId: pairing.gatewayId });
    expect(pairing.qrSvg.startsWith('<svg')).toBe(true);
    expect(pairing).toEqual(await fetch(`${gateway.http}/api/pairing`).then(response => response.json()));
  });

  it('has no code when pairing is off', async () => {
    const gateway = await gatewayFor();
    const pairing = await fetchPairing(gateway.url);
    expect(pairing.auth).toBe('off'); expect('code' in pairing).toBe(false);
  });

  it('needs the code for a strict gateway, from the link or token', async () => {
    const gateway = await gatewayFor({ auth: 'strict', token: 'K7Q2M9XD' });
    const needs = await rejection(fetchPairing(gateway.url));
    expect(needs.message).toMatch(/needs its pairing code/);
    expect((await fetchPairing(`marionette://pair?v=1&host=127.0.0.1&port=${gateway.port}&code=K7Q2M9XD`)).code).toBe('K7Q2-M9XD');
    expect((await fetchPairing(gateway.url, { token: 'k7q2 m9xd' })).code).toBe('K7Q2-M9XD');
    const refused = await rejection(fetchPairing(gateway.url, { token: 'AAAA-AAAA' }));
    expect(refused.message).toMatch(/refused the pairing code/);
    expect([needs.status, refused.status]).toEqual([401, 401]);
  });

  it('tries a pairing link\'s hosts in turn', async () => {
    const gateway = await gatewayFor();
    expect((await fetchPairing(`marionette://pair?v=1&host=nowhere.invalid,127.0.0.1&port=${gateway.port}`)).port).toBe(gateway.port);
  });

  it('says when there is no gateway, or no address', async () => {
    const away = await rejection(fetchPairing('127.0.0.1:1'));
    expect(away).toBeInstanceOf(PairingError); expect(away.message).toBe("Can't reach the gateway at 127.0.0.1:1."); expect(away.status).toBeUndefined();
    expect((await rejection(fetchPairing('two words'))).message).toMatch(/not a gateway address/);
  });

  it('names an old gateway and a failing one', async () => {
    const address = await answering([[404, 'Not found'], [500, 'boom']]);
    const old = await rejection(fetchPairing(address)); const failing = await rejection(fetchPairing(address));
    expect(old.message).toMatch(/too old to pair phones/); expect(failing.message).toMatch(/answered with an error \(500\)/);
    expect([old.status, failing.status]).toEqual([404, 500]);
  });

  it('takes only a pairing link and its SVG', async () => {
    const { gatewayId: _, ...noId } = GOOD;
    const bad = [[], { ...GOOD, qrSvg: '<script>alert(1)</script>' }, { ...GOOD, url: 'https://example.com' }, { ...GOOD, auth: 'maybe' }, { ...GOOD, port: '8787' }, noId];
    const address = await answering(bad.map(body => [200, JSON.stringify(body)]));
    for (const _body of bad) expect((await rejection(fetchPairing(address))).message).toMatch(/weren't understood/);
    expect(parsePairing(GOOD)).toEqual(GOOD); expect('code' in parsePairing({ ...GOOD, code: '', auth: 'off' })).toBe(false);
  });
});
