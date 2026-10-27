import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOSE_CODES, PROTOCOL_VERSION } from '@marionette/protocol';
import { act, connect, held, hello, mirrorOf, open, phone, port, pose, robot, sendPose, sleep, start, stopGateway, tempDir, waitFor, type Client } from './test-helpers.js';

afterEach(stopGateway);
const robotState = (client: Client, state: object, extra: object = {}) => client.ws.send(JSON.stringify({ type:'robot_state', version:PROTOCOL_VERSION, state, ...extra }));
const screen = (client: Client, html: string, title?: string) => client.ws.send(JSON.stringify({ type:'screen', version:PROTOCOL_VERSION, html, ...(title ? { title } : {}) }));
const states = (client: Client) => client.of('robot_state');
const ids = (config: any) => config.controls.map((c: any)=>c.id);
const records = () => { const list: any[] = []; return { list, diagnostics: { write: (r: any)=>list.push(r), pose: ()=>{}, close: ()=>{} } }; };

describe('robots',()=>{
  it('keeps a robot in the roster for the gateway\'s lifetime, and refuses a second connection with its id (4409)', async()=>{ const log=records(); await start({ diagnostics:log.diagnostics }); const viewer=await connect(); const axol=await robot('axol',{ name:'Axol' });
    await waitFor(()=>viewer.configOf().robots?.[0]?.connected===true); expect(viewer.configOf().robots).toEqual([{ id:'axol', name:'Axol', connected:true, screen:false, streams:[] }]); expect(axol.configOf().robots[0].id).toBe('axol');
    // No flapping: the robot that is connected stays, the newcomer is told why.
    const twin=await open(); hello(twin,{ role:'robot', robotId:'axol', name:'Axol 2' }); expect(await twin.closed).toMatchObject({ code:CLOSE_CODES.robotIdInUse });
    await sleep(30); expect(axol.ws.readyState).toBe(1); expect(viewer.configOf().robots).toEqual([{ id:'axol', name:'Axol', connected:true, screen:false, streams:[] }]);
    axol.ws.close(); await waitFor(()=>viewer.configOf().robots[0].connected===false); expect(viewer.configOf().robots[0].name).toBe('Axol');
    // Once it has gone, the next connection takes its place.
    const again=await robot('axol'); await waitFor(()=>viewer.configOf().robots[0].connected===true); expect(viewer.configOf().robots).toHaveLength(1); expect(viewer.configOf().robots[0].name).toBe('Axol');
    const misnamed=await open(); hello(misnamed,{ role:'robot', robotId:'Axol!' }); await waitFor(()=>misnamed.statuses('hello').length===1); expect(misnamed.statuses('hello')[0].values.accepted).toBe(false); misnamed.ws.close();
    expect(log.list.filter(r=>r.kind==='robot').map(r=>r.msg)).toEqual(['Robot Axol (axol) joined','refused a second connection as robot axol (4409): it is already connected','Robot Axol (axol) disconnected','Robot Axol (axol) reconnected']);
    for (const c of [viewer,again]) c.ws.close(); });
  it('gives a robot what a console gets (camera frames only if it asks), and relays its structured status to the phones only', async()=>{ await start(); const a=await phone('a'); const axol=await robot('axol'); const watcher=await robot('cam-bot',{ cameras:true }); const viewer=await connect();
    sendPose(a,pose(a.session,1)); act(a,'arm','arm.select','right');
    await waitFor(()=>axol.of('pose','phone-1').length>0&&axol.of('input','phone-1').length>0&&!!axol.configOf('phone-1'));
    await waitFor(()=>watcher.of('camera_frame').length>0&&viewer.of('camera_frame').length>0); expect(axol.of('camera_frame')).toEqual([]);
    const values={ frames:['axol','head'], battery:null, lift:{ height:0.42, limits:[0, 0.8] } };
    axol.ws.send(JSON.stringify({ type:'status', version:PROTOCOL_VERSION, sessionId:'axol', controlId:'axol.feedback', message:'', values, phoneId:'phone-1' }));
    await waitFor(()=>a.statuses('axol.feedback').length===1); expect(a.statuses('axol.feedback')[0]).toEqual({ type:'status', version:1, sessionId:'axol', controlId:'axol.feedback', message:'', values, phoneId:'phone-1' });
    await sleep(30); for (const other of [viewer,watcher,axol]) expect(other.statuses('axol.feedback')).toEqual([]);
    // Like any console, a robot only watches the controls.
    act(axol,'arm','arm.select','left'); await waitFor(()=>axol.statuses('arm').length>0); expect(axol.statuses('arm')[0].values.accepted).toBe(false);
    for (const c of [a,axol,watcher,viewer]) c.ws.close(); });
});

describe('robot state',()=>{
  it('goes to the phone it names (its mirrors and the consoles), or to everyone, never back to its robot; the gateway fills in robotId and receivedAt', async()=>{ await start(); const viewer=await connect(); const a=await phone('a'); const b=await phone('b'); const mirrorA=await mirrorOf('phone-1'); const mirrorB=await mirrorOf('phone-2'); const axol=await robot('axol'); const jelly=await robot('jelly');
    robotState(axol,{ ready:true, battery:null, frames:['axol','head'] },{ everyMs:200, sentAt:123.5, robotId:'impostor', extra:'not passed on' });
    await waitFor(()=>[viewer,a,b,mirrorA,mirrorB,jelly].every(c=>states(c).length===1));
    expect(states(a)[0]).toEqual({ type:'robot_state', version:1, robotId:'axol', state:{ ready:true, battery:null, frames:['axol','head'] }, everyMs:200, sentAt:123.5, receivedAt:expect.any(Number) }); expect(Math.abs(states(a)[0].receivedAt-Date.now())).toBeLessThan(1000);
    robotState(axol,{ arm:'left' },{ phoneId:'phone-1' }); await waitFor(()=>[viewer,a,mirrorA,jelly].every(c=>states(c).length===2));
    expect(states(mirrorA)[1]).toMatchObject({ robotId:'axol', phoneId:'phone-1', state:{ arm:'left' } });
    // Unknown phones are dropped, and only robots send state.
    robotState(axol,{ arm:'right' },{ phoneId:'phone-9' }); robotState(viewer,{ forged:true }); await waitFor(()=>viewer.statuses('robot_state').length===1); expect(viewer.statuses('robot_state')[0].values.accepted).toBe(false);
    robotState(axol,{ big:'x'.repeat(70_000) }); await waitFor(()=>axol.statuses('robot_state').length===1); expect(axol.statuses('robot_state')[0].values.accepted).toBe(false);
    await sleep(30); for (const c of [b,mirrorB]) expect(states(c)).toHaveLength(1); for (const c of [a,viewer]) expect(states(c)).toHaveLength(2); expect(states(axol)).toEqual([]);
    for (const c of [viewer,a,b,mirrorA,mirrorB,axol,jelly]) c.ws.close(); });
  it('replays the latest of each to whoever connects, right after its config, and keeps it after the robot leaves', async()=>{ await start(); const watcher=await connect(); const a=await phone('a'); await phone('b'); const axol=await robot('axol');
    robotState(axol,{ ready:true }); robotState(axol,{ ready:false }); robotState(axol,{ arm:'left' },{ phoneId:'phone-1' }); robotState(axol,{ arm:'right' },{ phoneId:'phone-2' });
    await waitFor(()=>states(watcher).length===4); axol.ws.close(); await waitFor(()=>watcher.configOf().robots[0].connected===false);
    const afterConfig=(client: Client)=>{ const first=client.messages.findIndex(m=>m.type==='robot_state'); return first>0&&client.messages[first-1].type==='config'; };
    // A console gets every one; a phone or mirror the global state and its phone's.
    const late=await connect(); await waitFor(()=>states(late).length===3);
    expect(states(late).map(m=>[m.phoneId,m.state])).toEqual([[undefined,{ ready:false }],['phone-1',{ arm:'left' }],['phone-2',{ arm:'right' }]]); expect(afterConfig(late)).toBe(true);
    a.ws.close(); await waitFor(()=>watcher.configOf('phone-1').phone.connected===false); const back=await phone('a'); await waitFor(()=>states(back).length===2); await sleep(30);
    expect(states(back).map(m=>[m.phoneId,m.state])).toEqual([[undefined,{ ready:false }],['phone-1',{ arm:'left' }]]); expect(afterConfig(back)).toBe(true);
    const mirror=await mirrorOf('phone-2'); await waitFor(()=>states(mirror).length===2); expect(states(mirror).map(m=>m.phoneId)).toEqual([undefined,'phone-2']); expect(afterConfig(mirror)).toBe(true);
    // A robot that comes back isn't sent its own state; any other robot gets all of it.
    const again=await robot('axol'); const jelly=await robot('jelly'); await waitFor(()=>states(jelly).length===3); await sleep(30); expect(states(again)).toEqual([]);
    for (const c of [watcher,late,back,mirror,again,jelly]) c.ws.close(); });
});

describe('robot screens',()=>{
  const block=(id: string)=>`<script type="application/json" id="marionette-config">${JSON.stringify({ controls:[{ id, type:'button', label:id, action:`robot.${id}`, hold:true }] })}</script>`;
  const page=(id: string)=>`<!doctype html><html><head><meta content="landscape" name="marionette-orientation"></head><body><p>${id}</p>${block(id)}</body></html>`;
  it('shows a robot\'s screen everywhere, answers it, refuses a broken block, ignores a repeat, and keeps the screen when the robot leaves', async()=>{ await start(); const viewer=await connect(); const a=await phone('a'); const axol=await robot('axol',{ name:'Axol' }); const shown=viewer.of('html_config').length;
    screen(axol,page('honk'),'Axol'); await waitFor(()=>axol.statuses('screen').length===1); expect(axol.statuses('screen')[0]).toMatchObject({ controlId:'screen', values:{ accepted:true } });
    await waitFor(()=>a.of('html_config').length===2&&viewer.of('html_config').length===shown+1);
    expect(a.of('html_config')[1]).toMatchObject({ title:'Axol', orientation:'landscape', source:{ kind:'robot', robotId:'axol' }, html:page('honk') });
    await waitFor(()=>ids(viewer.configOf()).join()==='honk'); expect(viewer.configOf().robots[0]).toMatchObject({ id:'axol', screen:true });
    expect((await fetch(`http://127.0.0.1:${port}/api/html-config`).then(r=>r.json()) as any).source).toEqual({ kind:'robot', robotId:'axol' });
    // The same screen again changes nothing.
    screen(axol,page('honk'),'Axol'); await waitFor(()=>axol.statuses('screen').length===2); expect(axol.statuses('screen')[1].values.accepted).toBe(true); await sleep(30); expect(a.of('html_config')).toHaveLength(2);
    // A broken block is refused with the reason, and the previous screen stays.
    screen(axol,'<p>x</p><script type="application/json" id="marionette-config">{nope</script>'); await waitFor(()=>axol.statuses('screen').length===3);
    expect(axol.statuses('screen')[2]).toMatchObject({ controlId:'screen', values:{ accepted:false } }); expect(axol.statuses('screen')[2].message).toMatch(/marionette-config block is not valid JSON/);
    await sleep(30); expect(a.of('html_config')).toHaveLength(2); expect(ids(viewer.configOf())).toEqual(['honk']);
    // A new layout ends holds on buttons it dropped, as a saved file does.
    act(a,'honk','robot.honk',true); await waitFor(()=>held(viewer.configOf('phone-1'),'honk')===true);
    screen(axol,page('beep')); await waitFor(()=>viewer.of('input','phone-1').some(m=>m.reason==='screen changed')); expect(a.of('html_config').at(-1).title).toBe('Marionette HTML controls');
    axol.ws.close(); await waitFor(()=>viewer.configOf().robots[0].connected===false); expect(viewer.configOf().robots[0].screen).toBe(true); expect(ids(viewer.configOf())).toEqual(['beep']);
    // Only robots send screens.
    screen(viewer,page('nope')); await waitFor(()=>viewer.statuses('screen').length===1); expect(viewer.statuses('screen')[0].values.accepted).toBe(false); expect(ids(viewer.configOf())).toEqual(['beep']);
    for (const c of [viewer,a]) c.ws.close(); });
  it('lets the newest win between a robot\'s push and a save of the screen file, and logs each change', async()=>{ const dir=tempDir(); const file=path.join(dir,'screen.html'); const log=records();
    fs.writeFileSync(file,'<p>file one</p>'); process.env.MARIONETTE_HTML_FILE=file;
    try { await start({ diagnostics:log.diagnostics }); const viewer=await connect(); const axol=await robot('axol'); const latest=()=>viewer.of('html_config').at(-1);
      expect(latest()).toMatchObject({ html:'<p>file one</p>', source:{ kind:'file' } });
      screen(axol,'<p>robot</p>'); await waitFor(()=>latest().html==='<p>robot</p>');
      fs.writeFileSync(file,'<p>file two</p>'); await waitFor(()=>latest().html==='<p>file two</p>', 3000); expect(latest().source).toEqual({ kind:'file' }); await waitFor(()=>viewer.configOf().robots[0].screen===false);
      screen(axol,'<p>robot</p>'); await waitFor(()=>latest().html==='<p>robot</p>');
      expect(log.list.filter(r=>r.kind==='html').map(r=>r.msg)).toEqual([`screen from robot axol replaces ${file}`,`screen from ${file} replaces robot axol`,`screen from robot axol replaces ${file}`]);
      for (const c of [viewer,axol]) c.ws.close(); }
    finally { delete process.env.MARIONETTE_HTML_FILE; fs.rmSync(dir,{recursive:true,force:true}); } });
});

describe('the screen kit',()=>{
  it('inlines the kit into every screen, serves it, follows edits to it, and counts it against the 512 KB limit', async()=>{ const kitDir=tempDir(); const log=records(); const js='window.MarionetteKit={ version:1, end:"</script>", money:"$& $1" };';
    fs.writeFileSync(path.join(kitDir,'marionette-kit.js'),js);
    process.env.MARIONETTE_HTML='<!doctype html><html><head><script src="./marionette-kit.js" defer></script><link rel="stylesheet" href="/marionette-kit.css" /></head><body><p>kit</p></body></html>';
    try { await start({ kitDir, diagnostics:log.diagnostics }); const viewer=await connect(); const latest=()=>viewer.of('html_config').at(-1).html;
      // A missing kit file reads as empty, reported once.
      expect(latest()).toBe('<!doctype html><html><head><script defer>window.MarionetteKit={ version:1, end:"<\\/script>", money:"$& $1" };</script><style></style></head><body><p>kit</p></body></html>');
      expect(log.list.filter(r=>/marionette-kit\.css not found/.test(r.msg))).toHaveLength(1);
      const js200=await fetch(`http://127.0.0.1:${port}/marionette-kit.js`); expect(js200.headers.get('content-type')).toMatch(/javascript/); expect(await js200.text()).toBe(js);
      fs.writeFileSync(path.join(kitDir,'marionette-kit.css'),'.mk-hold{color:red}</style>'); await waitFor(()=>latest().includes('<style>.mk-hold{color:red}<\\/style></style>'), 3000);
      expect(await fetch(`http://127.0.0.1:${port}/marionette-kit.css`).then(r=>r.text())).toBe('.mk-hold{color:red}</style>');
      // A robot's screen gets it too.
      const axol=await robot('axol'); screen(axol,'<script src="marionette-kit.js"></script><p>robot</p>'); await waitFor(()=>latest().endsWith('<p>robot</p>')); expect(latest()).toBe(`<script>${js.replace('</script>','<\\/script>')}</script><p>robot</p>`);
      fs.writeFileSync(path.join(kitDir,'marionette-kit.js'),'window.MarionetteKit={ version:2 };'); await waitFor(()=>latest()==='<script>window.MarionetteKit={ version:2 };</script><p>robot</p>', 3000);
      // The limit applies with the kit inlined.
      fs.writeFileSync(path.join(kitDir,'marionette-kit.css'),`/*${'x'.repeat(520_000)}*/`); await sleep(1200);
      screen(axol,'<link href="marionette-kit.css" rel="stylesheet"><p>big</p>'); await waitFor(()=>axol.statuses('screen').length===2); expect(axol.statuses('screen')[1]).toMatchObject({ values:{ accepted:false } }); expect(axol.statuses('screen')[1].message).toMatch(/512 KB/);
      expect(latest()).toBe('<script>window.MarionetteKit={ version:2 };</script><p>robot</p>');
      for (const c of [viewer,axol]) c.ws.close(); }
    finally { delete process.env.MARIONETTE_HTML; fs.rmSync(kitDir,{recursive:true,force:true}); } });
});
