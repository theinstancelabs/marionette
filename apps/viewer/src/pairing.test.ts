import { describe, expect, it } from 'vitest';
import { answeredBy, configFrom, connectPlan, forgetCode, httpUrl, isPairingInfo, parseCodes, planCode, rememberCode, savedCode, typedCode, withToken, type ConnectPlan } from './pairing';

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

  it('sends a saved code only to the address that accepted it, and says it was saved', () => {
    let codes = rememberCode(none, { url: 'ws://192.168.1.20:8787/ws', gatewayId: 'gw-abc' }, 'k7q2-m9xd');
    expect(connectPlan('192.168.1.20', undefined, codes)).toMatchObject({ saved: { 'ws://192.168.1.20:8787/ws': 'K7Q2M9XD' } });
    expect(planCode(connectPlan('192.168.1.20', undefined, codes) as ConnectPlan, 'ws://192.168.1.20:8787/ws')).toEqual({ code: 'K7Q2M9XD', saved: true });
    expect(connectPlan('192.168.1.21', undefined, codes)).not.toHaveProperty('saved');
    expect(connectPlan('192.168.1.20:9000', undefined, codes)).not.toHaveProperty('saved');
    codes = forgetCode(codes, 'K7Q2-M9XD');
    expect(codes).toEqual({ gateways: {}, addresses: {} });
  });

  it('never sends a saved code to a host that merely claims a known gateway id', () => {
    const codes = rememberCode(none, { url: 'ws://192.168.1.20:8787/ws', gatewayId: 'gw-abc' }, 'K7Q2M9XD');
    // Ids are public: a crafted link with the id and a foreign host gets no code, and the viewer asks.
    const foreign = connectPlan('marionette://pair?v=1&host=203.0.113.9&port=8787&id=gw-abc', undefined, codes) as ConnectPlan;
    expect(foreign).toEqual({ urls: ['ws://203.0.113.9:8787/ws'], gatewayId: 'gw-abc', label: '203.0.113.9' });
    expect(planCode(foreign, 'ws://203.0.113.9:8787/ws')).toEqual({});
    // A link listing the known address and a foreign one: the saved code goes to the known address only.
    const mixed = connectPlan('marionette://pair?v=1&host=203.0.113.9,192.168.1.20&port=8787&id=gw-abc', undefined, codes) as ConnectPlan;
    expect(mixed.saved).toEqual({ 'ws://192.168.1.20:8787/ws': 'K7Q2M9XD' });
    expect(planCode(mixed, 'ws://203.0.113.9:8787/ws')).toEqual({});
    expect(planCode(mixed, 'ws://192.168.1.20:8787/ws')).toEqual({ code: 'K7Q2M9XD', saved: true });
    // The same gateway at another of its addresses is asked for the code once, then that address is known too.
    const tailscale = rememberCode(codes, { url: 'ws://100.88.1.2:8787/ws', gatewayId: 'gw-abc' }, 'K7Q2M9XD');
    expect(tailscale.gateways['gw-abc']).toEqual({ code: 'K7Q2M9XD', urls: ['ws://192.168.1.20:8787/ws', 'ws://100.88.1.2:8787/ws'] });
    expect(savedCode(tailscale, 'ws://100.88.1.2:8787/ws')).toBe('K7Q2M9XD');
  });

  it('uses only the gateway the link names: another one answering is refused, and its code not saved', () => {
    const plan = connectPlan('marionette://pair?v=1&host=192.168.1.20&port=8787&id=gw-abc', undefined, none) as ConnectPlan;
    expect(answeredBy(plan, 'ws://192.168.1.20:8787/ws', 'gw-abc')).toBeUndefined();
    expect(answeredBy(plan, 'ws://192.168.1.20:8787/ws', 'gw-evil')).toMatch(/192\.168\.1\.20 answered as another gateway \(gw-evil\), not the one in the pairing link \(gw-abc\)/);
    expect(answeredBy(plan, 'ws://192.168.1.20:8787/ws', undefined)).toMatch(/a gateway without an id/);
    // An address typed by hand names no gateway: whichever answers is it.
    expect(answeredBy(connectPlan('192.168.1.20', undefined, none) as ConnectPlan, 'ws://192.168.1.20:8787/ws', 'gw-evil')).toBeUndefined();
    expect(configFrom({ type: 'config', gatewayId: 'gw-abc' })).toEqual({ gatewayId: 'gw-abc' });
    expect(configFrom({ type: 'config', gatewayId: 7 })).toEqual({});
    expect(configFrom({ type: 'config', gatewayId: 'x'.repeat(65) })).toEqual({});
    expect(configFrom({ type: 'html_config' })).toBeUndefined();
    expect(configFrom(null)).toBeUndefined();
  });
});

describe('remembered pairing codes', () => {
  it('keeps the newest code per gateway with the addresses that accepted it, and per address, and survives garbage', () => {
    let codes = rememberCode(none, { url: 'ws://a:8787/ws', gatewayId: 'gw-1' }, 'AAAA-AAAA');
    codes = rememberCode(codes, { url: 'ws://b:8787/ws', gatewayId: 'gw-1' }, 'AAAA-AAAA');
    expect(codes).toEqual({ gateways: { 'gw-1': { code: 'AAAAAAAA', urls: ['ws://a:8787/ws', 'ws://b:8787/ws'] } }, addresses: { 'ws://a:8787/ws': 'AAAAAAAA', 'ws://b:8787/ws': 'AAAAAAAA' } });
    // A new code starts the gateway's addresses afresh: b never accepted it, so it isn't sent there.
    codes = rememberCode(codes, { url: 'ws://a:8787/ws', gatewayId: 'gw-1' }, 'BBBB-BBBB');
    expect(codes.gateways['gw-1']).toEqual({ code: 'BBBBBBBB', urls: ['ws://a:8787/ws'] });
    expect(savedCode(codes, 'ws://a:8787/ws')).toBe('BBBBBBBB'); expect(savedCode(codes, 'ws://b:8787/ws')).toBe('AAAAAAAA');
    expect(parseCodes(JSON.stringify(codes))).toEqual(codes);
    // An address answering as another gateway now belongs to that one.
    const moved = rememberCode(codes, { url: 'ws://a:8787/ws', gatewayId: 'gw-2' }, 'CCCC-CCCC');
    expect(moved.gateways).toEqual({ 'gw-2': { code: 'CCCCCCCC', urls: ['ws://a:8787/ws'] } });
    // A gateway without an id: saved for the address alone.
    expect(rememberCode(none, { url: 'ws://old:8787/ws' }, 'DDDD-DDDD')).toEqual({ gateways: {}, addresses: { 'ws://old:8787/ws': 'DDDDDDDD' } });
    expect(parseCodes('{"gateways":{"gw-1":"<script>"},"addresses":[1,2]}')).toEqual({ gateways: {}, addresses: {} });
    expect(parseCodes('{"gateways":{"gw-1":{"code":"AAAAAAAA","urls":[]}},"addresses":{"ws://a:8787/ws":"x"}}')).toEqual({ gateways: {}, addresses: {} });
    // Codes saved by id alone, by an earlier viewer, are dropped: nothing says where they may go.
    expect(parseCodes('{"gateways":{"gw-1":"AAAAAAAA"},"addresses":{"ws://a:8787/ws":"AAAAAAAA"}}')).toEqual({ gateways: {}, addresses: { 'ws://a:8787/ws': 'AAAAAAAA' } });
    expect(parseCodes('not json')).toEqual({ gateways: {}, addresses: {} });
    // At most 32 of each, the oldest going first.
    for (let i = 0; i < 40; i++) codes = rememberCode(codes, { url: `ws://h${i}:8787/ws` }, 'CCCC-CCCC');
    expect(Object.keys(codes.addresses)).toHaveLength(32);
    expect(codes.addresses['ws://a:8787/ws']).toBeUndefined();
  });

  it('never carries a gateway’s new code to an address that only accepted another one', () => {
    // A host claiming gw-abc accepts any code (here its own); later the real gw-abc's code is typed at its address.
    let codes = rememberCode(none, { url: 'ws://192.168.1.20:8787/ws', gatewayId: 'gw-abc' }, 'K7Q2-M9XD');
    codes = rememberCode(codes, { url: 'ws://203.0.113.9:8787/ws', gatewayId: 'gw-abc' }, 'ZZZZ-ZZZZ');
    codes = rememberCode(codes, { url: 'ws://192.168.1.20:8787/ws', gatewayId: 'gw-abc' }, 'K7Q2-M9XD');
    expect(codes.gateways['gw-abc']).toEqual({ code: 'K7Q2M9XD', urls: ['ws://192.168.1.20:8787/ws'] });
    expect(savedCode(codes, 'ws://192.168.1.20:8787/ws')).toBe('K7Q2M9XD');
    expect(savedCode(codes, 'ws://203.0.113.9:8787/ws')).toBe('ZZZZZZZZ');
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
