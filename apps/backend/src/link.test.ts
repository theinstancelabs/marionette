import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@marionette/protocol';
import { latency, newLink, offset, ping, pong } from './clock.js';
import { act, answerPings, connect, getState, held, hello, mirrorOf, open, phone, phoneState, pose, robot, sendPose, start, stopGateway, waitFor, waitUntil } from './test-helpers.js';

afterEach(stopGateway);

describe('ping, link and latency',()=>{
  it('answers every ping with a pong, from anyone', async()=>{ await start(); const viewer=await connect(); const quiet=await open(); const sentAt=Date.now()+0.25;
    for (const c of [viewer,quiet]) c.ws.send(JSON.stringify({ type:'ping', version:PROTOCOL_VERSION, id:7, sentAt }));
    await waitFor(()=>viewer.of('pong').length===1&&quiet.of('pong').length===1);
    expect(viewer.of('pong')[0]).toEqual({ type:'pong', version:1, id:7, sentAt, at:expect.any(Number) }); expect(Math.abs(viewer.of('pong')[0].at-Date.now())).toBeLessThan(1000);
    for (const c of [viewer,quiet]) c.ws.close(); });
  it('pings phones and robots (not consoles), keeps each one\'s round trip and clock offset, and shows each phone\'s link', async()=>{ await start({ pingMs:40 }); const viewer=await connect(); const a=await phone('a'); answerPings(a); const b=await phone('b'); const axol=await robot('axol'); answerPings(axol);
    await waitFor(()=>[a,b,axol].every(c=>c.of('ping').length>=3)); expect(viewer.of('ping')).toEqual([]);
    // Each ping carries the last round trip measured to that client.
    await waitFor(()=>a.of('ping').some(m=>typeof m.rttMs==='number')); expect(b.of('ping').some(m=>m.rttMs!==undefined)).toBe(false);
    expect(a.of('ping').map(m=>m.id).slice(0,3)).toEqual([1,2,3]);
    const state=await getState(); const linkA=state.phones.find((p: any)=>p.id==='phone-1').link;
    expect(linkA).toMatchObject({ offsetKnown:true, quality:'good' }); expect(linkA.rttMs).toBeGreaterThanOrEqual(0); expect(Math.abs(linkA.offsetMs)).toBeLessThan(50); expect(linkA.samples).toBeGreaterThan(0);
    expect(state.phones.find((p: any)=>p.id==='phone-2').link).toMatchObject({ offsetKnown:false, quality:'unknown' }); expect(state.robots[0].link.offsetKnown).toBe(true);
    for (const c of [viewer,a,b,axol]) c.ws.close(); });
  it('stamps poses with the gateway\'s receive time, and poses and inputs with the latency once the phone\'s clock offset is known', async()=>{ await start({ pingMs:30 }); const viewer=await connect(); const a=await phone('a'); const mirror=await mirrorOf('phone-1');
    sendPose(a,pose(a.session,1,{ sentAt:Date.now() })); await waitFor(()=>viewer.of('pose','phone-1').some(m=>m.seq===1));
    const first=viewer.of('pose','phone-1').find(m=>m.seq===1); expect(Math.abs(first.receivedAt-Date.now())).toBeLessThan(1000); expect(first.sentAt).toEqual(expect.any(Number)); expect(first.latencyMs).toBeUndefined();
    // The phone's clock runs 5 s ahead of this one; it says it sent each of these 20 ms ago.
    answerPings(a,5000); await waitUntil(async()=>(await phoneState('phone-1')).link.offsetKnown); expect(Math.abs((await phoneState('phone-1')).link.offsetMs-5000)).toBeLessThan(20);
    sendPose(a,pose(a.session,2,{ sentAt:Date.now()+5000-20 })); act(a,'arm','arm.select','right',undefined,Date.now()+5000-20); act(mirror,'arm','arm.select','left');
    await waitFor(()=>viewer.of('pose','phone-1').some(m=>m.seq===2)&&viewer.of('input','phone-1').length===2);
    const second=viewer.of('pose','phone-1').find(m=>m.seq===2); expect(second.latencyMs).toBeGreaterThanOrEqual(15); expect(second.latencyMs).toBeLessThan(80);
    const [fromPhone,fromMirror]=viewer.of('input','phone-1'); expect(fromPhone.latencyMs).toBeGreaterThanOrEqual(15); expect(fromPhone.latencyMs).toBeLessThan(80); expect(Math.abs(fromPhone.receivedAt-Date.now())).toBeLessThan(1000);
    // The gateway doesn't know a mirror's clock.
    expect(fromMirror.source).toBe('mirror'); expect(fromMirror.latencyMs).toBeUndefined();
    for (const c of [viewer,a,mirror]) c.ws.close(); });
  it('estimates the offset from the fastest of the last 16 round trips', ()=>{ const link=newLink();
    // A pong `rttMs` after its ping, from a clock that read `at` past the ping's send time when it answered.
    const answer=(rttMs: number, at: number)=>{ const sent=ping(link); pong(link,{ type:'pong', version:1, id:sent.id, sentAt:sent.sentAt, at:sent.sentAt+at },sent.sentAt+rttMs); };
    answer(40, 1000+20); answer(4, 1000+2); answer(30, 1300);
    expect(link.samples).toHaveLength(3); expect(offset(link)).toBeCloseTo(1000, 0); expect(ping(link).rttMs).toBeCloseTo(30, 0);
    for (let i=0; i<20; i++) answer(50, 2000+25); expect(link.samples).toHaveLength(16); expect(offset(link)).toBeCloseTo(2000, 0);
    expect(latency(link, undefined, 0)).toBeUndefined(); expect(latency(link, 2000+100, 120)).toBeCloseTo(20, 0); expect(latency(link, 2000+100, 50)).toBe(0); });
});

describe('reconnecting in place',()=>{
  it('keeps the calibration for a phone back in the same session, clears it for another session or a first pose from one, and still ends holds', async()=>{ await start(); const viewer=await connect(); const a=await phone('a','iphone-a',{ sessionId:'iphone-a' });
    act(a,'capture-origin','calibration.captureOrigin'); act(a,'deadman','teleop.deadman',true); await waitFor(()=>viewer.configOf('phone-1')?.calibration.status==='captured'&&held(viewer.configOf('phone-1'),'deadman')===true);
    a.ws.close(); await waitFor(()=>viewer.of('input','phone-1').some(m=>m.reason==='phone disconnected'));
    expect(held(viewer.configOf('phone-1'),'deadman')).toBe(false); expect(viewer.configOf('phone-1').calibration).toMatchObject({ status:'captured', epoch:1 }); expect(viewer.configOf().phones[0].sessionId).toBeUndefined();
    const back=await phone('a','iphone-a',{ sessionId:'iphone-a' }); expect(back.configOf('phone-1').calibration).toMatchObject({ status:'captured', epoch:1 }); expect(viewer.configOf().phones[0].sessionId).toBe('iphone-a');
    // The hello names the old session but the poses come from a new one: a new world after all.
    back.ws.close(); await waitFor(()=>viewer.configOf('phone-1').phone.connected===false);
    const fooled=await open(); hello(fooled,{ role:'phone', deviceId:'a', sessionId:'iphone-a' }); await waitFor(()=>!!fooled.configOf('phone-1')); expect(fooled.configOf('phone-1').calibration.status).toBe('captured');
    sendPose(fooled,pose('iphone-a-new',0)); await waitFor(()=>viewer.configOf('phone-1').calibration.status==='uncalibrated'); expect(viewer.configOf('phone-1').calibration.epoch).toBe(2);
    // A takeover before the gateway noticed the old socket died (Wi-Fi dropped) keeps it too, if the session is the same.
    act(fooled,'capture-origin','calibration.captureOrigin'); await waitFor(()=>viewer.configOf('phone-1').calibration.status==='captured');
    const takeover=await phone('a','iphone-a-new',{ sessionId:'iphone-a-new' }); expect((await fooled.closed).code).toBe(4001);
    expect(viewer.configOf('phone-1').calibration).toMatchObject({ status:'captured', epoch:3 }); expect(takeover.configOf('phone-1').calibration.status).toBe('captured');
    for (const c of [viewer,takeover]) c.ws.close(); });
});
