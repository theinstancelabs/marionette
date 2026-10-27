import { describe, expect, it } from 'vitest';
import { connectPlan, forgetCode, httpUrl, isPairingInfo, parseCodes, rememberCode, typedCode, withToken } from './pairing';

const none = parseCodes(null);
const LINK = 'marionette://pair?v=1&host=192.168.1.20,100.88.1.2&port=8790&code=K7Q2M9XD&id=gw-abc&name=Lab%20bench';

describe('connecting from what was typed or pasted', () => {
  it('reads an address, with a typed code', () => {
    expect(connectPlan('192.168.1.20', undefined, none)).toEqual({ urls: ['ws://192.168.1.20:8787/ws'], label: '192.168.1.20' });
    expect(connectPlan('192.168.1.20:9000', 'k7q2-m9xd', none)).toEqual({ urls: ['ws://192.168.1.20:9000/ws'], code: 'K7Q2M9XD', label: '192.168.1.20:9000' });
    expect(connectPlan('not an address!', undefined, none)).toHaveProperty('error');
    expect(connectPlan('  ', undefined, none)).toEqual({ error: 'Type the gateway address first.' });
  });

  it('tries every host of a pairing link, with its code, id and name', () => {
    expect(connectPlan(`  ${LINK} `, undefined, none)).toEqual({
      urls: ['ws://192.168.1.20:8790/ws', 'ws://100.88.1.2:8790/ws'], code: 'K7Q2M9XD', gatewayId: 'gw-abc', label: 'Lab bench' });
    // A code typed by hand wins over the link's.
    expect(connectPlan(LINK, 'ZZZZ-ZZZZ', none)).toMatchObject({ code: 'ZZZZZZZZ' });
    expect(connectPlan('marionette://pair?v=1&port=8787', undefined, none)).toHaveProperty('error');
  });

  it('uses a saved code for the address, else for the link’s gateway, and says it was saved', () => {
    let codes = rememberCode(none, { url: 'ws://192.168.1.20:8787/ws', gatewayId: 'gw-abc' }, 'k7q2-m9xd');
    expect(connectPlan('192.168.1.20', undefined, codes)).toMatchObject({ code: 'K7Q2M9XD', saved: true });
    expect(connectPlan('192.168.1.21', undefined, codes)).not.toHaveProperty('code');
    // A link without a code, to another address of the same gateway.
    expect(connectPlan('marionette://pair?v=1&host=100.88.1.2&port=8787&id=gw-abc', undefined, codes)).toMatchObject({ code: 'K7Q2M9XD', saved: true });
    codes = forgetCode(codes, 'K7Q2-M9XD');
    expect(codes).toEqual({ gateways: {}, addresses: {} });
  });
});

describe('remembered pairing codes', () => {
  it('keeps the newest code per gateway and per address, and survives garbage', () => {
    let codes = rememberCode(none, { url: 'ws://a:8787/ws', gatewayId: 'gw-1' }, 'AAAA-AAAA');
    codes = rememberCode(codes, { url: 'ws://b:8787/ws', gatewayId: 'gw-1' }, 'BBBB-BBBB');
    expect(codes).toEqual({ gateways: { 'gw-1': 'BBBBBBBB' }, addresses: { 'ws://a:8787/ws': 'AAAAAAAA', 'ws://b:8787/ws': 'BBBBBBBB' } });
    expect(parseCodes(JSON.stringify(codes))).toEqual(codes);
    expect(parseCodes('{"gateways":{"gw-1":"<script>"},"addresses":[1,2]}')).toEqual({ gateways: {}, addresses: {} });
    expect(parseCodes('not json')).toEqual({ gateways: {}, addresses: {} });
    // At most 32 of each, the oldest going first.
    for (let i = 0; i < 40; i++) codes = rememberCode(codes, { url: `ws://h${i}:8787/ws` }, 'CCCC-CCCC');
    expect(Object.keys(codes.addresses)).toHaveLength(32);
    expect(codes.addresses['ws://a:8787/ws']).toBeUndefined();
  });

  it('formats a code as it is typed', () => {
    expect(typedCode('k7q2')).toBe('K7Q2');
    expect(typedCode('k7q2m')).toBe('K7Q2-M');
    expect(typedCode('k7q2 m9xd')).toBe('K7Q2-M9XD');
    expect(typedCode('K7Q2-M9XD')).toBe('K7Q2-M9XD');
    // O, I and L read as 0, 1 and 1; anything else that is not a letter or digit goes.
    expect(typedCode('oil.#')).toBe('011');
    expect(typedCode('ABCDEFGHJK')).toBe('ABCDEFGHJK');
  });
});

describe('gateway URLs with the code', () => {
  it('adds the code as ?token= to the WebSocket and HTTP URLs', () => {
    expect(withToken('ws://192.168.1.20:8787/ws', undefined)).toBe('ws://192.168.1.20:8787/ws');
    expect(withToken('ws://192.168.1.20:8787/ws', 'k7q2-m9xd')).toBe('ws://192.168.1.20:8787/ws?token=K7Q2M9XD');
    expect(withToken('ws://h:1/ws?x=1', 'K7Q2M9XD')).toBe('ws://h:1/ws?x=1&token=K7Q2M9XD');
    expect(httpUrl('ws://192.168.1.20:8787/ws', '/api/pairing', 'K7Q2-M9XD')).toBe('http://192.168.1.20:8787/api/pairing?token=K7Q2M9XD');
    expect(httpUrl('wss://gw.example:443/ws', '/health')).toBe('https://gw.example:443/health');
    expect(httpUrl('ws://[::1]:8787/ws', '/api/pairing')).toBe('http://[::1]:8787/api/pairing');
  });

  it('accepts only a complete /api/pairing answer', () => {
    const info = { gatewayId: 'gw-abc', name: 'Lab', auth: 'on', code: 'K7Q2-M9XD', addresses: ['192.168.1.20'], port: 8787, url: 'marionette://pair?v=1', qrSvg: '<svg></svg>' };
    expect(isPairingInfo(info)).toBe(true);
    expect(isPairingInfo({ ...info, code: undefined, auth: 'off' })).toBe(true);
    expect(isPairingInfo({ ...info, qrSvg: 'javascript:alert(1)' })).toBe(false);
    expect(isPairingInfo({ ...info, addresses: '192.168.1.20' })).toBe(false);
  });
});
