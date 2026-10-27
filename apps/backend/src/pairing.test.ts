import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOSE_CODES, PROTOCOL_VERSION, parsePairingLink } from '@marionette/protocol';
import { advertisedAddresses, createLimiter, isLoopback, pairing, pairingBanner, sameCode } from './pairing.js';
import { connect, hello, open, phone, port, start, stopGateway, tempDir, waitFor } from './test-helpers.js';

afterEach(stopGateway);
const records = () => { const list: any[] = []; return { list, diagnostics: { write: (r: any)=>list.push(r), pose: ()=>{}, close: ()=>{} } }; };
const status = (route: string, init?: RequestInit, host = '127.0.0.1') => fetch(`http://${host}:${port}${route}`, init).then(r=>r.status);
// One of this computer's own network addresses: reaching the gateway through it is not loopback.
const external = Object.values(os.networkInterfaces()).flat().filter(entry => entry && entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')).map(entry => entry!.address).at(-1);

describe('pairing',()=>{
  it('keeps the gateway id and code in the identity file, and MARIONETTE_TOKEN fixes the code', async()=>{ const home=tempDir(); await start({ home });
    const saved=JSON.parse(fs.readFileSync(path.join(home,'gateway.json'),'utf8')); expect(saved.id).toMatch(/^gw-[0-9a-z]{10}$/); expect(saved.token).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect((fs.statSync(path.join(home,'gateway.json')).mode & 0o777).toString(8)).toBe('600');
    const viewer=await connect(); expect(viewer.configOf()).toMatchObject({ gatewayId:saved.id, auth:false }); viewer.ws.close(); await stopGateway();
    // The same file next time; a fixed code replaces the saved one without rewriting it.
    const again=await start({ home, auth:'strict', token:'ab12-cd34', name:'Bench' }); expect(again.pairing()).toMatchObject({ gatewayId:saved.id, code:'AB12-CD34', name:'Bench', auth:'strict' });
    expect(JSON.parse(fs.readFileSync(path.join(home,'gateway.json'),'utf8'))).toEqual(saved);
    const bench=await open({}, '?token=AB12CD34'); hello(bench,{ role:'console' }); await waitFor(()=>!!bench.configOf()); expect(bench.configOf()).toMatchObject({ serverName:'Bench', gatewayId:saved.id, auth:true }); bench.ws.close();
    expect(()=>pairing({ id:'gw-x', token:'K7Q2M9XD' }, 'n', 'off', ['10.0.0.2'], 8787).code).not.toThrow(); expect(pairing({ id:'gw-x', token:'K7Q2M9XD' }, 'n', 'off', ['10.0.0.2'], 8787).code).toBeUndefined(); });
  it('lets clients on this computer in without the code by default', async()=>{ await start({ auth:'on', token:'K7Q2M9XD' }); const viewer=await connect(); expect(viewer.configOf().auth).toBe(true); const a=await phone('a'); expect(a.id).toBe('phone-1');
    expect(await status('/api/state')).toBe(200); expect(await status('/screen')).toBe(200);
    expect(['127.0.0.1','::1','::ffff:127.0.0.1','127.4.5.6'].every(isLoopback)).toBe(true); expect(['192.168.1.5','::ffff:10.0.0.1','100.64.0.5','fe80::1',''].some(isLoopback)).toBe(false);
    for (const c of [viewer,a]) c.ws.close(); });
  it.skipIf(!external)('asks everyone but this computer for the code by default', async()=>{ await start({ auth:'on', token:'K7Q2M9XD', pairingTimeoutMs:150 });
    const quiet=await open({}, '', external); expect((await quiet.closed).code).toBe(4401); expect(quiet.messages).toEqual([]);
    const paired=await open({}, '?token=K7Q2-M9XD', external); hello(paired,{ role:'console' }); await waitFor(()=>!!paired.configOf()); paired.ws.close();
    expect(await status('/api/state', undefined, external)).toBe(401); expect(await status('/api/state?token=K7Q2M9XD', undefined, external)).toBe(200); expect(await status('/health', undefined, external)).toBe(200); });
  it('sends an unpaired socket nothing until a hello with the code, and closes it with 4401 for anything else or 3 s of silence', async()=>{ const log=records(); await start({ auth:'strict', token:'K7Q2M9XD', pairingTimeoutMs:150, diagnostics:log.diagnostics });
    const quiet=await open(); expect(await quiet.closed).toEqual({ code:CLOSE_CODES.pairingRequired, reason:'Pairing code required' }); expect(quiet.messages).toEqual([]);
    const eager=await open(); eager.ws.send(JSON.stringify({ type:'ping', version:PROTOCOL_VERSION, id:1, sentAt:1 })); expect((await eager.closed).code).toBe(4401); expect(eager.messages).toEqual([]);
    const bare=await open(); hello(bare,{ role:'console' }); expect((await bare.closed).code).toBe(4401);
    const wrong=await open(); hello(wrong,{ role:'phone', deviceId:'a', token:'K7Q2-M9XA' }); expect(await wrong.closed).toEqual({ code:4401, reason:'Wrong pairing code' }); expect(wrong.messages).toEqual([]);
    // The code in the hello, as typed, or in the address.
    const a=await open(); hello(a,{ role:'phone', deviceId:'a', token:' k7q2-m9xd ' }); await waitFor(()=>!!a.configOf('phone-1')); expect(a.messages[0].type).toBe('html_config');
    const viewer=await open({}, '?token=k7q2m9xd'); await waitFor(()=>viewer.messages.some(m=>m.type==='html_config')); hello(viewer,{ role:'console' }); await waitFor(()=>!!viewer.configOf()); expect(viewer.configOf().phones).toHaveLength(1);
    const badLink=await open({}, '?token=NOPE'); expect(await badLink.closed).toEqual({ code:4401, reason:'Wrong pairing code' }); expect(badLink.messages).toEqual([]);
    expect(log.list.filter(r=>r.kind==='pairing').map(r=>r.msg)).toEqual(['closed 127.0.0.1 (4401): Pairing code required','closed 127.0.0.1 (4401): Pairing code required','closed 127.0.0.1 (4401): Pairing code required',
      'refused 127.0.0.1: wrong pairing code','closed 127.0.0.1 (4401): Wrong pairing code','refused 127.0.0.1: wrong pairing code','closed 127.0.0.1 (4401): Wrong pairing code']);
    for (const c of [a,viewer]) c.ws.close(); });
  it('shuts an address out for a minute after five wrong codes in a minute', async()=>{ await start({ auth:'strict', token:'K7Q2M9XD' });
    for (let i=0; i<5; i++) { const guess=await open({}, `?token=WRONG${i}`); expect((await guess.closed).code).toBe(4401); }
    const right=await open({}, '?token=K7Q2M9XD'); expect(await right.closed).toEqual({ code:4401, reason:'Too many wrong pairing codes; try again in a minute' }); expect(right.messages).toEqual([]);
    expect(await status('/api/state?token=K7Q2M9XD')).toBe(401);
    const limiter=createLimiter(2, 50); expect([limiter.miss('a'),limiter.blocked('a'),limiter.miss('a'),limiter.blocked('a'),limiter.blocked('b')]).toEqual([false,false,true,true,false]);
    await new Promise(r=>setTimeout(r,60)); expect(limiter.blocked('a')).toBe(false); });
  it('needs the code for /api and /screen (query or bearer), never for /health or the kit', async()=>{ await start({ auth:'strict', token:'K7Q2M9XD' });
    expect(await status('/health')).toBe(200); expect(await status('/marionette-kit.js')).toBe(200); expect(await status('/marionette-kit.css')).toBe(200);
    expect(await status('/api/state')).toBe(401); expect(await status('/api/pairing')).toBe(401); expect(await status('/screen')).toBe(401);
    expect(await status('/api/state?token=k7q2-m9xd')).toBe(200); expect(await status('/api/config',{ headers:{ Authorization:'Bearer K7Q2M9XD' } })).toBe(200); expect(await status('/screen?token=K7Q2M9XD&phone=phone-1')).toBe(200);
    expect(sameCode('k7q2 m9xd','K7Q2M9XD')).toBe(true); expect(sameCode('K7Q2M9X','K7Q2M9XD')).toBe(false); expect(sameCode(undefined,'K7Q2M9XD')).toBe(false); });
  it('describes the pairing at /api/pairing: code, addresses, port, link and QR code', async()=>{ process.env.MARIONETTE_ADDRESSES='192.168.1.20, 100.64.0.5';
    try { await start({ auth:'on', token:'K7Q2M9XD', name:'Axol lab' }); const viewer=await connect(); const info=await fetch(`http://127.0.0.1:${port}/api/pairing`).then(r=>r.json()) as any;
      expect(info).toMatchObject({ gatewayId:viewer.configOf().gatewayId, name:'Axol lab', code:'K7Q2-M9XD', addresses:['192.168.1.20','100.64.0.5'], port, auth:'on' });
      expect(parsePairingLink(info.url)).toEqual({ hosts:['192.168.1.20','100.64.0.5'], port, code:'K7Q2M9XD', gatewayId:info.gatewayId, name:'Axol lab' });
      expect(info.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/); viewer.ws.close();
      const banner=await pairingBanner(info); expect(banner).toContain('Pairing code: K7Q2-M9XD'); expect(banner).toContain(info.url); }
    finally { delete process.env.MARIONETTE_ADDRESSES; }
    // Without an override: this computer's IPv4 addresses, never loopback or link-local.
    for (const address of advertisedAddresses()) { expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/); expect(address).not.toMatch(/^(127|169\.254)\./); } });
});
