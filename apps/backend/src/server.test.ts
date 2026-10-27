import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createServer } from './server.js';
import { PROTOCOL_VERSION, defaultConfig, matrixToQuaternion, nominalCovariance, type ActionMessage, type PosePacket, type Vector3 } from '@marionette/protocol';

let gateway: ReturnType<typeof createServer> | undefined; let port: number;
afterEach(async()=>{ if(gateway) await gateway.close(); gateway=undefined; });
async function waitFor(predicate: () => boolean, timeoutMs = 1000) { const started = Date.now(); while (!predicate()) { if (Date.now() - started >= timeoutMs) throw new Error('Timed out waiting for gateway messages'); await new Promise(resolve => setTimeout(resolve, 10)); } }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function start(options: Parameters<typeof createServer>[1] = {}) { const created=createServer(0, options); gateway=created; await new Promise<void>(r=>created.server.listen(0,r)); port=(created.server.address() as any).port; }
type Client = { ws: WebSocket; messages: any[]; id?: string; session: string; statuses: (controlId?: string) => any[]; of: (type: string, phoneId?: string) => any[]; configOf: (phoneId?: string) => any };
async function open(headers: Record<string, string> = {}): Promise<Client> {
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers }); const messages:any[]=[]; ws.on('message',d=>messages.push(JSON.parse(d.toString())));
  await new Promise((resolve, reject)=>{ ws.once('open',resolve); ws.once('error',reject); }); ws.on('error',()=>{ /* a terminated socket may report ECONNRESET before close */ });
  const of = (type: string, phoneId?: string) => messages.filter(m=>m.type===type&&(phoneId===undefined||m.phoneId===phoneId));
  return { ws, messages, session: '', of, statuses: controlId => of('status').filter(m=>!controlId||m.controlId===controlId), configOf: phoneId => messages.filter(m=>m.type==='config'&&(phoneId ? m.phone?.id===phoneId : !m.phone)).at(-1) };
}
/** A console (viewer or consumer): says hello and gets the gateway view plus every phone's. */
async function connect(headers: Record<string, string> = {}) { const client=await open(headers); client.ws.send(JSON.stringify({ type:'hello', version:PROTOCOL_VERSION, role:'console' })); await waitFor(()=>!!client.configOf()); return client; }
/** A phone: says hello with its device id, learns its phone id, and streams one pose. */
async function phone(deviceId = 'a', session = `iphone-${deviceId}`) { const client=await open(); client.session=session; client.ws.send(JSON.stringify({ type:'hello', version:PROTOCOL_VERSION, role:'phone', deviceId })); await waitFor(()=>client.messages.some(m=>m.type==='config'&&m.phone)); client.id=client.messages.find(m=>m.type==='config'&&m.phone).phone.id; sendPose(client,pose(session,0)); await sleep(15); return client; }
const getState = async () => await fetch(`http://127.0.0.1:${port}/api/state`).then(r=>r.json()) as any;
const phoneState = async (id: string) => (await getState()).phones.find((p: any)=>p.id===id);
const value = (config: any, id: string) => config?.controls.find((c: any)=>c.id===id)?.value;
const held = (config: any, id: string) => config?.controls.find((c: any)=>c.id===id)?.held;
// A flat phone, screen up, top edge toward ARKit -Z (camera +X = bottom edge, +Y = right edge, +Z = screen).
const FLAT = matrixToQuaternion([0,0,1,0, 1,0,0,0, 0,1,0,0, 0,0,0,1]);
const NOMINAL = [.0025,.0025,.0025,.01,.01,.01];
const pose = (sessionId: string, seq: number, overrides: Partial<PosePacket> = {}): PosePacket => ({ type:'pose', version:1, sessionId, seq, monotonicTs:seq+1, position:{x:0,y:0,z:0}, rotation:FLAT, covariance:NOMINAL, source:'arkit', trackingState:'normal', calibrationVersion:'arkit-v1', heartbeat:true, ...overrides });
const sendPose = (client: Client, p: PosePacket) => client.ws.send(JSON.stringify(p));
const act = (client: Client, controlId: string, action: string, value?: string | number | boolean, renew?: true) => client.ws.send(JSON.stringify({type:'action',version:PROTOCOL_VERSION,sessionId:client.session||'console',controlId,action,value,renew,sentAt:Date.now()} satisfies ActionMessage));

describe('gateway handshake and layout',()=>{
  it('tells a console the layout and roster, sends the screen, and streams every camera', async()=>{ await start(); const viewer=await connect();
    const config=viewer.configOf(); expect(config.phones).toEqual([]); expect(config.cameraViews.map((v: any)=>v.id)).toEqual(['head','arms']); expect(config.teleop).toBeUndefined(); expect(config.safety).toBeUndefined();
    expect(viewer.messages.some(m=>m.type==='html_config'&&m.htmlVersion===1&&m.bridgeVersion===1)).toBe(true);
    await waitFor(()=>['head','arm-left','arm-right'].every(id=>viewer.of('camera_frame').some(m=>m.cameraId===id&&m.dataUrl.startsWith('data:image/png;base64,')))); viewer.ws.close(); });
  it('treats a client that never says hello as a listening console', async()=>{ await start(); const quiet=await open(); expect(quiet.configOf()).toBeUndefined(); await waitFor(()=>!!quiet.configOf(), 600); quiet.ws.close(); });
  it('finds every control in the sample HTML by a configured action, never by a hard-coded id', ()=>{ const html=fs.readFileSync(new URL('./sample-controls.html', import.meta.url),'utf8'); const block=/const ACTION = \{([\s\S]*?)\};/.exec(html)![1]; const actions=[...block.matchAll(/'([a-z]+\.[a-zA-Z]+)'/g)].map(m=>m[1]); expect(actions.length).toBeGreaterThanOrEqual(8); const configured=new Set(defaultConfig().controls.map(c=>c.action)); expect(actions.filter(action=>!configured.has(action))).toEqual([]); expect(html).not.toMatch(/sendAction\('/); });
  it('serves the phone screen for a desktop browser, mirroring the phone named in the address', async()=>{ await start(); const page=await fetch(`http://127.0.0.1:${port}/screen?phone=phone-2`).then(r=>r.text()); expect(page.indexOf('window.Marionette=M')).toBeGreaterThan(-1); expect(page.indexOf('window.Marionette=M')).toBeLessThan(page.indexOf('</head>')); expect(page).toContain('follow="phone-2"');
    // The phone id is the only thing taken from the address, and it can never close the script.
    const hostile=await fetch(`http://127.0.0.1:${port}/screen?phone=${encodeURIComponent('</script><script>alert(1)</script>')}`).then(r=>r.text()); expect(hostile).not.toContain('<script>alert(1)'); expect(hostile).toContain('follow=""');
    // Browsers read the REST API only from pages that may open the WebSocket.
    const corsFrom=async (origin: string)=>(await fetch(`http://127.0.0.1:${port}/api/state`,{ headers:{ Origin:origin } })).headers.get('access-control-allow-origin');
    expect(await corsFrom('https://evil.example')).toBeNull(); expect(await corsFrom('http://localhost:5173')).toBe('http://localhost:5173'); });
  it('takes controls and cameras declared by a custom screen, and pushes the screen whenever it is saved', async()=>{ const dir=fs.mkdtempSync(path.join(os.tmpdir(),'marionette-')); const file=path.join(dir,'screen.html');
    const screen=(label: string)=>`<p>${label}</p><script type="application/json" id="marionette-config">${JSON.stringify({ controls:[{ id:'horn', type:'button', label, action:'horn.honk' }], cameraStreams:[{ id:'deck', label:'Deck', url:'sim://head', status:'live' }], cameraViews:[{ id:'deck', label:'Deck cam', streams:['deck'] }] })}</script>`;
    fs.writeFileSync(file,screen('Horn')); process.env.MARIONETTE_HTML_FILE=file;
    try { await start(); const viewer=await connect(); expect(viewer.configOf().controls.map((c: any)=>c.id)).toEqual(['horn']); expect(viewer.configOf().cameraViews).toEqual([{ id:'deck', label:'Deck cam', streams:['deck'] }]); await waitFor(()=>viewer.of('camera_frame').some(m=>m.cameraId==='deck'));
      fs.writeFileSync(file,screen('Beep')); await waitFor(()=>viewer.messages.some(m=>m.type==='html_config'&&m.html.includes('Beep'))&&viewer.configOf().controls[0].label==='Beep', 3000);
      // Saving without changing anything must not remount the phone's page (that would drop a held button).
      const pushed=viewer.of('html_config').length; fs.writeFileSync(file,screen('Beep')); const later=new Date(Date.now()+5000); fs.utimesSync(file,later,later); await sleep(1300); expect(viewer.of('html_config')).toHaveLength(pushed); viewer.ws.close(); }
    finally { delete process.env.MARIONETTE_HTML_FILE; fs.rmSync(dir,{recursive:true,force:true}); } });
  it('reconciles phones with a saved screen, derives views for streams declared alone, and reports what it ignored', async()=>{ const dir=fs.mkdtempSync(path.join(os.tmpdir(),'marionette-')); const file=path.join(dir,'screen.html'); const records: any[]=[];
    const screen=(layout: object)=>`<p>screen</p><script type="application/json" id="marionette-config">${JSON.stringify(layout)}</script>`;
    const pedal={ id:'pedal', type:'button', label:'Pedal', action:'base.pedal', hold:true }; const mode=(options: string[])=>({ id:'mode', type:'select', label:'Mode', action:'base.mode', value:options[0], options:options.map(value=>({ label:value, value })) });
    fs.writeFileSync(file,screen({ controls:[pedal, mode(['walk','run'])] })); process.env.MARIONETTE_HTML_FILE=file;
    try { await start({ diagnostics:{ write: record=>records.push(record), pose: ()=>{}, close: ()=>{} } }); const viewer=await connect(); const a=await phone('a');
      act(a,'pedal','base.pedal',true); act(a,'mode','base.mode','run'); await waitFor(()=>held(viewer.configOf('phone-1'),'pedal')===true&&value(viewer.configOf('phone-1'),'mode')==='run');
      // The pedal is gone and "run" is no longer an option; one control is broken, and the streams come without views.
      fs.writeFileSync(file,screen({ controls:[mode(['walk','crawl']),{ id:'broken', type:'button' }], cameraStreams:[{ id:'deck', label:'Deck', url:'sim://head', status:'live' },{ id:'mast', label:'Mast', url:'sim://head', status:'live' }] }));
      await waitFor(()=>viewer.of('input','phone-1').some(m=>m.reason==='screen changed'), 3000);
      expect(viewer.of('input','phone-1').at(-1)).toMatchObject({ controlId:'pedal', action:'base.pedal', value:false, source:'gateway' });
      await waitFor(()=>value(viewer.configOf('phone-1'),'mode')==='walk'); expect(viewer.configOf().cameraViews).toEqual([{ id:'deck', label:'Deck', streams:['deck'] },{ id:'mast', label:'Mast', streams:['mast'] }]);
      expect(records.some(r=>r.kind==='html'&&/ignored 1 of 2 controls/.test(r.msg))).toBe(true);
      // A broken edit keeps the previous screen.
      fs.writeFileSync(file,'<p>x</p><script type="application/json" id="marionette-config">{nope</script>'); await waitFor(()=>records.some(r=>r.kind==='html'&&/keeping the previous one/.test(r.msg)), 3000); expect(viewer.configOf().controls.map((c: any)=>c.id)).toEqual(['mode']);
      for (const c of [viewer,a]) c.ws.close(); }
    finally { delete process.env.MARIONETTE_HTML_FILE; fs.rmSync(dir,{recursive:true,force:true}); } });
  it('sends no camera frames to a console that opts out', async()=>{ await start(); const viewer=await connect(); const bridge=await open(); bridge.ws.send(JSON.stringify({ type:'hello', version:PROTOCOL_VERSION, role:'console', cameras:false })); await waitFor(()=>!!bridge.configOf());
    await waitFor(()=>viewer.of('camera_frame').length>=3); await sleep(300); expect(bridge.of('camera_frame')).toEqual([]); for (const c of [viewer,bridge]) c.ws.close(); });
  it('refuses to start with a screen whose control block is broken', ()=>{ process.env.MARIONETTE_HTML='<p>x</p><script type="application/json" id="marionette-config">{nope</script>'; try { expect(()=>createServer(0)).toThrow(/marionette-config/); } finally { delete process.env.MARIONETTE_HTML; } });
  it('survives invalid UTF-8 frames and refuses cross-site browser origins', async()=>{ await start(); const bad=await connect(); bad.ws.send(Buffer.from([0x7b,0xff,0xfe]),{binary:false}); await new Promise(r=>bad.ws.once('close',r)); expect((await fetch(`http://127.0.0.1:${port}/health`).then(r=>r.json()) as any).ok).toBe(true); await expect(connect({ Origin:'https://evil.example' })).rejects.toThrow(/401/); const local=await connect({ Origin:'http://localhost:5173' }); local.ws.close(); });
});

describe('several phones',()=>{
  it('names phones in order with their colors, and a phone that reconnects keeps its identity', async()=>{ await start(); const viewer=await connect(); const a=await phone('a'); const b=await phone('b');
    expect([a.id,b.id]).toEqual(['phone-1','phone-2']); await waitFor(()=>viewer.configOf().phones.length===2);
    expect(viewer.configOf().phones.map((p: any)=>[p.name,p.color,p.connected])).toEqual([['Phone 1','#c98200',true],['Phone 2','#b04fc4',true]]);
    expect(a.configOf('phone-1').phones).toHaveLength(2);
    a.ws.close(); await waitFor(()=>viewer.configOf().phones[0].connected===false); expect((await phoneState('phone-1')).config.calibration.status).toBe('uncalibrated');
    const again=await phone('a','iphone-a2'); expect(again.id).toBe('phone-1'); await waitFor(()=>viewer.configOf().phones[0].connected===true);
    // A second connection from the same phone takes over; the old one is closed.
    const closed=new Promise<number>(resolve=>b.ws.once('close',code=>resolve(code))); const b2=await phone('b','iphone-b2'); expect(b2.id).toBe('phone-2'); expect(await closed).toBe(4001);
    expect(viewer.configOf().phones.map((p: any)=>[p.id,p.connected])).toEqual([['phone-1',true],['phone-2',true]]); for (const c of [viewer,again,b2]) c.ws.close(); });
  it('tells consoles each phone\'s config when it leaves or is replaced, and a replaced phone starts uncalibrated', async()=>{ await start(); const viewer=await connect(); const a=await phone('a'); const b=await phone('b');
    act(a,'capture-origin','calibration.captureOrigin'); act(b,'capture-origin','calibration.captureOrigin'); await waitFor(()=>viewer.configOf('phone-1')?.calibration.status==='captured'&&viewer.configOf('phone-2')?.calibration.status==='captured');
    a.ws.close(); await waitFor(()=>viewer.configOf('phone-1').phone.connected===false); expect(viewer.configOf('phone-1').calibration).toMatchObject({ status:'uncalibrated', epoch:2 });
    const b2=await phone('b','iphone-b2'); await waitFor(()=>viewer.configOf('phone-2').calibration.status==='uncalibrated');
    expect(viewer.of('pose','phone-2').some(m=>m.heartbeat===false&&m.trackingState==='unavailable')).toBe(true); expect(b2.configOf('phone-2').calibration.status).toBe('uncalibrated');
    for (const c of [viewer,b2]) c.ws.close(); });
  it('streams each phone\'s poses to consoles, tagged, and never shows one phone another\'s data', async()=>{ await start(); const viewer=await connect(); const a=await phone('a'); const b=await phone('b');
    sendPose(a,pose(a.session,1,{position:{x:0.1,y:0,z:0}})); sendPose(b,pose(b.session,1,{position:{x:0,y:0.2,z:0}})); act(b,'calibration-start','calibration.start');
    await waitFor(()=>viewer.of('pose','phone-1').length>=2&&viewer.of('pose','phone-2').length>=2&&viewer.statuses('calibration-start').length>0);
    expect(viewer.statuses('calibration-start')[0].phoneId).toBe('phone-2'); expect(viewer.configOf('phone-2').calibration.status).toBe('capturing'); expect(viewer.configOf('phone-1').calibration.status).toBe('uncalibrated');
    await sleep(30);
    expect(a.of('pose')).toEqual([]); expect(a.of('input')).toEqual([]); expect(a.messages.some(m=>m.type==='config'&&m.phone&&m.phone.id!=='phone-1')).toBe(false); expect(a.statuses().some(m=>m.phoneId==='phone-2')).toBe(false); expect(a.messages.some(m=>m.type==='config'&&!m.phone)).toBe(false);
    for (const c of [viewer,a,b]) c.ws.close(); });
  it('relays every action verbatim as input, including repeats and actions no control declares', async()=>{ await start(); const viewer=await connect(); const a=await phone('a'); const b=await phone('b');
    act(a,'estop','safety.estop',true); act(a,'arm','arm.select','right'); act(a,'horn','horn.honk'); act(a,'grip','gripper.hold',true); act(a,'grip','gripper.hold',true,true); act(a,'grip','gripper.hold',false); act(a,'arm','arm.select','middle');
    await waitFor(()=>viewer.of('input','phone-1').length===7);
    expect(viewer.of('input','phone-1').map(m=>[m.controlId,m.action,m.value,m.renew,m.source])).toEqual([['estop','safety.estop',true,undefined,'phone'],['arm','arm.select','right',undefined,'phone'],['horn','horn.honk',undefined,undefined,'phone'],['grip','gripper.hold',true,undefined,'phone'],['grip','gripper.hold',true,true,'phone'],['grip','gripper.hold',false,undefined,'phone'],['arm','arm.select','middle',undefined,'phone']]);
    expect(viewer.of('input','phone-1')[0]).toMatchObject({ sessionId:'iphone-a', receivedAt: expect.any(Number), sentAt: expect.any(Number) });
    // Values are kept per phone; an impossible value is relayed but not kept, and the phone is told.
    await waitFor(()=>a.statuses('arm').length>0); const config=viewer.configOf('phone-1'); expect(value(config,'estop')).toBe(true); expect(value(config,'arm')).toBe('right'); expect(value(viewer.configOf('phone-2'),'arm')).toBe('left');
    expect(a.statuses('arm').at(-1)).toMatchObject({ message:'Action rejected by gateway validation', values:{ accepted:false } }); expect(a.of('input')).toEqual([]); expect(b.statuses().some(m=>m.controlId==='arm')).toBe(false);
    for (const c of [viewer,a,b]) c.ws.close(); });
  it('arbitrates nothing: Stop is only a value, and both phones may hold the deadman on the same arm', async()=>{ await start(); const viewer=await connect(); const a=await phone('a'); const b=await phone('b');
    act(a,'deadman','teleop.deadman',true); act(b,'deadman','teleop.deadman',true); act(a,'estop','safety.estop',true); await sleep(30); sendPose(b,pose(b.session,1)); sendPose(a,pose(a.session,1,{trackingState:'limited'}));
    await waitFor(()=>held(viewer.configOf('phone-1'),'deadman')===true&&held(viewer.configOf('phone-2'),'deadman')===true&&viewer.of('pose','phone-1').length>=2&&viewer.of('pose','phone-2').length>=2);
    expect(value(viewer.configOf('phone-1'),'estop')).toBe(true); expect(value(viewer.configOf('phone-2'),'estop')).toBe(false); expect(value(viewer.configOf('phone-1'),'arm')).toBe(value(viewer.configOf('phone-2'),'arm'));
    expect(viewer.of('input').some(m=>m.source==='gateway')).toBe(false); for (const c of [viewer,a,b]) c.ws.close(); });
  it('ends a hold whose repeats stop, or whose phone leaves, and says why; a repeat never starts one', async()=>{ await start({holdTimeoutMs:80}); const viewer=await connect(); const a=await phone('a');
    act(a,'grip','gripper.hold',true,true); await sleep(20); expect(held(viewer.configOf('phone-1'),'grip')).toBe(false);
    act(a,'grip','gripper.hold',true); await waitFor(()=>held(viewer.configOf('phone-1'),'grip')===true); act(a,'grip','gripper.hold',true,true); await sleep(50); act(a,'grip','gripper.hold',true,true); await sleep(50); expect(held(viewer.configOf('phone-1'),'grip')).toBe(true);
    await waitFor(()=>viewer.of('input','phone-1').some(m=>m.source==='gateway'), 500); expect(viewer.of('input','phone-1').at(-1)).toMatchObject({ controlId:'grip', action:'gripper.hold', value:false, source:'gateway', reason:'renewals stopped' }); expect(held(viewer.configOf('phone-1'),'grip')).toBe(false);
    act(a,'deadman','teleop.deadman',true); await waitFor(()=>held(viewer.configOf('phone-1'),'deadman')===true); a.ws.close();
    await waitFor(()=>viewer.of('input','phone-1').some(m=>m.reason==='phone disconnected')); expect(held(viewer.configOf('phone-1'),'deadman')).toBe(false); viewer.ws.close(); });
  it('treats an app that never says hello as a phone, and drops it from the roster when it leaves', async()=>{ await start(); const viewer=await connect(); const old=await open(); sendPose(old,pose('legacy',0)); await waitFor(()=>viewer.of('pose','phone-1').length>0);
    expect(viewer.configOf().phones.map((p: any)=>p.id)).toEqual(['phone-1']); old.ws.close(); await waitFor(()=>viewer.configOf().phones.length===0); viewer.ws.close(); });
  it('rejects out-of-order poses per phone, and a new session clears only that phone\'s calibration', async()=>{ await start(); const viewer=await connect(); const a=await phone('a'); const b=await phone('b');
    act(a,'capture-origin','calibration.captureOrigin'); act(b,'capture-origin','calibration.captureOrigin'); await waitFor(()=>viewer.configOf('phone-1')?.calibration.status==='captured'&&viewer.configOf('phone-2')?.calibration.status==='captured');
    sendPose(a,pose(a.session,3)); sendPose(a,pose(a.session,2)); await sleep(20); expect((await phoneState('phone-1')).poseCount).toBe(2);
    sendPose(a,pose('iphone-a-restart',0)); await waitFor(()=>viewer.configOf('phone-1').calibration.status==='uncalibrated'); expect(viewer.configOf('phone-2').calibration.status).toBe('captured'); expect(viewer.configOf().phones[0].sessionId).toBe('iphone-a-restart');
    await waitFor(()=>viewer.of('pose','phone-1').at(-1)?.sessionId==='iphone-a-restart'); expect(viewer.of('pose','phone-1').at(-1).calibrationVersion).toBe('arkit-gravity-v2'); for (const c of [viewer,a,b]) c.ws.close(); });
  it('publishes an unavailable pose for a phone that goes quiet', async()=>{ await start({watchdogMs:60}); const viewer=await connect(); const a=await phone('a'); const b=await phone('b');
    await waitFor(()=>viewer.of('pose','phone-1').some(m=>m.trackingState==='unavailable'&&m.heartbeat===false&&m.calibrationVersion.endsWith('-stale'))&&viewer.of('pose','phone-2').some(m=>!m.heartbeat), 500);
    expect((await phoneState('phone-1')).stale).toBe(true); for (const c of [viewer,a,b]) c.ws.close(); });
  it('lets consoles watch but not act', async()=>{ await start(); const viewer=await connect(); const a=await phone('a'); act(viewer,'arm','arm.select','right'); await waitFor(()=>viewer.statuses('arm').length>0);
    expect(viewer.statuses('arm')[0]).toMatchObject({ values:{ accepted:false } }); expect(viewer.of('input')).toEqual([]); expect(value(viewer.configOf('phone-1'),'arm')).toBe('left'); viewer.ws.close(); a.ws.close(); });
  it('mirrors the first connected phone on /screen, acts as it, and moves on when it leaves', async()=>{ await start(); const viewer=await connect(); const a=await phone('a'); const b=await phone('b');
    const mirror=await open(); mirror.ws.send(JSON.stringify({ type:'hello', version:PROTOCOL_VERSION, role:'console', follow:'' })); await waitFor(()=>!!mirror.configOf('phone-1'));
    act(mirror,'arm','arm.select','right'); await waitFor(()=>value(viewer.configOf('phone-1'),'arm')==='right'); expect(viewer.of('input','phone-1').at(-1).source).toBe('mirror');
    sendPose(a,pose(a.session,1)); sendPose(b,pose(b.session,1)); await waitFor(()=>mirror.of('pose','phone-1').length>0); await sleep(20); expect(mirror.of('pose','phone-2')).toEqual([]); expect(mirror.of('input')).toEqual([]);
    a.ws.close(); await waitFor(()=>!!mirror.configOf('phone-2')); expect(mirror.messages.filter(m=>m.type==='config').at(-1).phone.id).toBe('phone-2');
    const pinned=await open(); pinned.ws.send(JSON.stringify({ type:'hello', version:PROTOCOL_VERSION, role:'console', follow:'phone-1' })); await waitFor(()=>!!pinned.configOf('phone-1')); expect(pinned.configOf('phone-1').phone.connected).toBe(false);
    // A mirror of a phone that has not connected yet shows the layout, then the phone once it arrives.
    const early=await open(); early.ws.send(JSON.stringify({ type:'hello', version:PROTOCOL_VERSION, role:'console', follow:'phone-3' })); await waitFor(()=>!!early.configOf()); const c=await phone('c'); expect(c.id).toBe('phone-3'); await waitFor(()=>!!early.configOf('phone-3'));
    for (const client of [viewer,b,mirror,pinned,early,c]) client.ws.close(); });
});

describe('cameras',()=>{
  it('sends each phone only the streams in the camera view it picked, and consoles every stream', async()=>{ await start(); const viewer=await connect(); const a=await phone('a'); const producer=await connect();
    await waitFor(()=>a.of('camera_frame').length>=2); expect(new Set(a.of('camera_frame').map(m=>m.cameraId))).toEqual(new Set(['head']));
    act(a,'cameras','camera.view','arms'); await waitFor(()=>value(a.configOf('phone-1'),'cameras')==='arms'); const from=a.messages.length; const since=()=>new Set(a.messages.slice(from).filter(m=>m.type==='camera_frame').map(m=>m.cameraId));
    await waitFor(()=>since().size===2); expect(since()).toEqual(new Set(['arm-left','arm-right']));
    // Any client can feed a declared stream; undeclared streams are ignored.
    const frame=(cameraId: string)=>({ type:'camera_frame', version:PROTOCOL_VERSION, sessionId:'robot', cameraId, dataUrl:'data:image/jpeg;base64,AAAA', capturedAt:Date.now() });
    producer.ws.send(JSON.stringify(frame('arm-left'))); producer.ws.send(JSON.stringify(frame('wrist-9'))); await waitFor(()=>a.of('camera_frame').some(m=>m.sessionId==='robot')&&viewer.of('camera_frame').some(m=>m.sessionId==='robot'));
    await sleep(20); expect(viewer.of('camera_frame').some(m=>m.cameraId==='wrist-9')).toBe(false); for (const c of [viewer,a,producer]) c.ws.close(); });
});

describe('calibration, per phone',()=>{
  const flatAt = (position: Vector3) => ({ position, rotation: FLAT });
  const rig = (client: Client, overrides: Partial<PosePacket> = {}) => { let seq=1; return { at: async (position: Vector3) => { sendPose(client,pose(client.session,seq++,{ ...flatAt(position), ...overrides })); await sleep(10); }, step: async (controlId: string, action: string, v?: string) => { act(client,controlId,action,v); await sleep(10); } }; };
  it('guides flat, forward, right and up into one phone\'s frame while the other phone keeps its own', async()=>{ await start(); const viewer=await connect(); const a=await phone('a'); const b=await phone('b'); const { at, step } = rig(a); const capture=(s: string)=>step('calibration','calibration.capture',s);
    // The flat spot is 10 mm right of the ARKit origin: (0, -0.01, 0) in the uncalibrated operator frame.
    await at({x:0.01,y:0,z:0}); await step('calibration-start','calibration.start'); await capture('forward'); expect(a.statuses('calibration').at(-1).message).toMatch(/flat step first/); await capture('check-forward'); expect(a.statuses('calibration').at(-1).message).toBe('Action rejected by gateway validation');
    await capture('flat'); let config=a.configOf('phone-1'); expect(config.calibration).toMatchObject({ status:'capturing', step:'forward' }); expect(config.calibration.anchor.x).toBeCloseTo(0); expect(config.calibration.anchor.y).toBeCloseTo(-0.01);
    await at({x:0.01,y:0,z:-0.005}); await capture('forward'); expect(a.statuses('calibration').at(-1).message).toMatch(/30 mm/); await at({x:0.01,y:0.03,z:-0.2}); await capture('forward'); await at({x:0.16,y:0,z:0}); await capture('right'); expect(a.configOf('phone-1').calibration.anchor.y).toBeCloseTo(-0.01); await at({x:0.01,y:0.12,z:0}); await capture('up');
    config=a.configOf('phone-1'); expect(config.calibration).toMatchObject({ status:'captured', epoch:1, originSeq:1 }); expect(config.calibration.anchor).toBeUndefined(); expect(a.statuses('calibration').at(-1).message).toMatch(/^Calibrated: X forward, Y left, Z up/);
    await at({x:0.01,y:0.1,z:0}); await waitFor(()=>viewer.of('pose','phone-1').at(-1)?.calibrationVersion==='guided-v2:1'); const last=viewer.of('pose','phone-1').at(-1); expect(last.position.x).toBeCloseTo(0); expect(last.position.y).toBeCloseTo(0); expect(last.position.z).toBeCloseTo(0.1);
    expect(viewer.configOf('phone-2').calibration.status).toBe('uncalibrated'); expect(b.statuses().some(m=>m.controlId==='calibration')).toBe(false); for (const c of [viewer,a,b]) c.ws.close(); });
  it('validates on request, measuring each move from the flat spot, and cancelling keeps the last result', async()=>{ await start(); const a=await phone('a'); const { at, step } = rig(a); const check=(move?: string)=>step('calibration-check','calibration.check',move); const last=()=>a.statuses('calibration-check').at(-1);
    await check(); expect(last().message).toMatch(/Calibrate first/); await check('sideways'); expect(last().message).toBe('Action rejected by gateway validation');
    await at({x:0,y:0,z:0}); await step('calibration-start','calibration.start'); expect(a.statuses('calibration-start').at(-1).values.accepted).toBe(true); await step('calibration','calibration.capture','flat'); await at({x:0,y:0,z:-0.15}); await step('calibration','calibration.capture','forward'); await at({x:0.15,y:0,z:0}); await step('calibration','calibration.capture','right'); await at({x:0,y:0.12,z:0}); await step('calibration','calibration.capture','up');
    await check('forward'); expect(last().message).toMatch(/Validate calibration first/); await check(); expect(a.configOf('phone-1').calibration.check).toEqual({ step:'forward', results:[] }); await check('right'); expect(last().message).toMatch(/Check forward first/);
    // ARKit -Z is forward and +X is right. The phone is lowered from the up capture first, which must not count.
    await at({x:0,y:0,z:-0.01}); await check('forward'); expect(last().message).toMatch(/30 mm forward/); expect(last().values.accepted).toBe(false);
    await at({x:0.01,y:0.005,z:-0.1}); await check('forward'); await at({x:0.1,y:0.01,z:0.01}); await check('right'); await at({x:0.01,y:0.1,z:0}); await check('up');
    let calibration=a.configOf('phone-1').calibration; expect(calibration.check.passed).toBe(true); expect(calibration.check.results.map((r: any)=>r.dominant)).toEqual(['+X','-Y','+Z']); expect(last().message).toMatch(/^Validated/);
    await check(); await at({x:0.1,y:0,z:0}); await check('forward'); expect(last().message).toMatch(/forward → -Y ✗ expected \+X/); await at({x:0.12,y:0,z:0}); await check('right'); await at({x:0,y:0.13,z:0}); await check('up'); expect(a.configOf('phone-1').calibration.check.passed).toBe(false);
    await check(); await check('cancel'); calibration=a.configOf('phone-1').calibration; expect(calibration.check.passed).toBe(false); expect(last()).toMatchObject({ message:'Validation cancelled; the previous result still stands', values:{ accepted:true } }); a.ws.close(); });
  it('cancels a guided calibration back to the frame that was live before it started', async()=>{ await start(); const a=await phone('a'); const last=()=>a.statuses('calibration-cancel').at(-1).message; const step=async (id: string, action: string, v?: string)=>{ act(a,id,action,v); await sleep(15); };
    await step('capture-origin','calibration.captureOrigin'); await step('calibration-start','calibration.start'); expect(a.configOf('phone-1').calibration.status).toBe('capturing');
    await step('calibration-cancel','calibration.cancel'); expect(a.configOf('phone-1').calibration).toMatchObject({ status:'captured', epoch:1, reference:{ mode:'quick' } }); expect(last()).toMatch(/previous calibration/);
    await step('calibration-cancel','calibration.cancel'); expect(last()).toBe('Calibration is not running');
    await step('reset-origin','calibration.reset'); await step('calibration-start','calibration.start'); await step('calibration','calibration.capture','flat'); await step('calibration-cancel','calibration.cancel');
    expect(a.configOf('phone-1').calibration.status).toBe('uncalibrated'); expect(a.configOf('phone-1').calibration.anchor).toBeUndefined(); expect(last()).toBe('Calibration cancelled'); a.ws.close(); });
  it('calibrates from normal or limited ARKit tracking only, and runs a whole calibration on limited tracking', async()=>{ await start(); const a=await phone('a'); let seq=1; const origin=async()=>{ act(a,'capture-origin','calibration.captureOrigin'); await sleep(15); return a.statuses('capture-origin').at(-1); };
    for (const overrides of [{trackingState:'initializing'},{trackingState:'relocalizing'},{trackingState:'limited',source:'synthetic'}] as Partial<PosePacket>[]) { sendPose(a,pose(a.session,seq++,overrides)); await sleep(10); expect((await origin()).message).toBe('Wait for ARKit tracking before capturing origin'); expect(a.configOf('phone-1').calibration.status).toBe('uncalibrated'); }
    sendPose(a,pose(a.session,seq++,{trackingState:'limited',covariance:nominalCovariance('limited')})); await sleep(10); expect((await origin()).values.accepted).toBe(true); expect(a.configOf('phone-1').calibration.status).toBe('captured');
    const desk=await phone('desk'); const { at, step } = rig(desk, { trackingState:'limited', covariance:nominalCovariance('limited') });
    await at({x:0,y:0,z:0}); await step('calibration-start','calibration.start'); await step('calibration','calibration.capture','flat'); await at({x:0,y:0,z:-0.15}); await step('calibration','calibration.capture','forward'); await at({x:0.15,y:0,z:0}); await step('calibration','calibration.capture','right'); await at({x:0,y:0.12,z:0}); await step('calibration','calibration.capture','up');
    expect(desk.statuses('calibration').every(m=>m.values.accepted)).toBe(true); expect(desk.configOf(desk.id).calibration).toMatchObject({ status:'captured', epoch:1 });
    await step('calibration-check','calibration.check'); await at({x:0,y:0,z:-0.1}); await step('calibration-check','calibration.check','forward'); await at({x:0.1,y:0,z:0}); await step('calibration-check','calibration.check','right'); await at({x:0,y:0.1,z:0}); await step('calibration-check','calibration.check','up');
    expect(desk.configOf(desk.id).calibration.check.passed).toBe(true); a.ws.close(); desk.ws.close(); });
});
