import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@marionette/protocol';
import { connect, mirrorOf, phone, robot, sleep, start, stopGateway, waitFor, type Client } from './test-helpers.js';

afterEach(stopGateway);
const rtc = (client: Client, fields: object) => client.ws.send(JSON.stringify({ type:'rtc', version:PROTOCOL_VERSION, ...fields }));
const signals = (client: Client, kind?: string) => client.of('rtc').filter(m=>!kind||m.kind===kind);
const streamOf = (config: any, id: string) => config?.cameraStreams.find((s: any)=>s.id===id);
const published = async (axol: Client, watcher: Client, streams = ['head']) => { rtc(axol,{ kind:'publish', streams }); await waitFor(()=>streams.every(id=>streamOf(watcher.configOf(),id)?.transport==='webrtc')); };

describe('WebRTC signaling',()=>{
  it('registers a robot as the publisher of declared streams, marks them in the config, and stops drawing them', async()=>{ await start(); const viewer=await connect(); const axol=await robot('axol',{ name:'Axol' });
    rtc(axol,{ kind:'publish', streams:['head','wrist-9'] }); await waitFor(()=>streamOf(viewer.configOf(),'head')?.transport==='webrtc');
    expect(streamOf(viewer.configOf(),'head')).toEqual({ id:'head', label:'Head', url:'sim://head', status:'live', transport:'webrtc', publisher:'axol' }); expect(streamOf(viewer.configOf(),'arm-left').transport).toBeUndefined();
    expect(viewer.configOf().robots[0].streams).toEqual(['head']);
    await waitFor(()=>signals(axol,'error').length===1); expect(signals(axol,'error')[0].message).toMatch(/Not declared by the screen: wrist-9/);
    // The gateway stops drawing it; the other simulated streams carry on, and JPEG frames a robot sends still go through.
    const from=viewer.messages.length; await sleep(400); const frames=viewer.messages.slice(from).filter(m=>m.type==='camera_frame');
    expect(frames.some(m=>m.cameraId==='head')).toBe(false); expect(frames.some(m=>m.cameraId==='arm-left')).toBe(true);
    axol.ws.send(JSON.stringify({ type:'camera_frame', version:PROTOCOL_VERSION, sessionId:'axol', cameraId:'head', dataUrl:'data:image/jpeg;base64,AAAA', capturedAt:Date.now() })); await waitFor(()=>viewer.of('camera_frame').some(m=>m.sessionId==='axol'));
    // Only robots publish; unpublishing puts the stream back.
    rtc(viewer,{ kind:'publish', streams:['arm-left'] }); await waitFor(()=>signals(viewer,'error').length===1); expect(signals(viewer,'error')[0].message).toMatch(/Only a robot/);
    rtc(axol,{ kind:'unpublish', streams:['head'] }); await waitFor(()=>streamOf(viewer.configOf(),'head').transport===undefined); expect(viewer.configOf().robots[0].streams).toEqual([]);
    await waitFor(()=>viewer.messages.slice(from).some(m=>m.type==='camera_frame'&&m.cameraId==='head'&&m.sessionId!=='axol'));
    for (const c of [viewer,axol]) c.ws.close(); });
  it('routes a request to the publisher and passes offer, answer, candidates and close between the two ends only, stamped with from', async()=>{ await start(); const axol=await robot('axol'); const viewer=await connect(); const a=await phone('a'); const mirror=await mirrorOf('phone-1'); const intruder=await connect();
    await published(axol,viewer);
    rtc(viewer,{ kind:'request', stream:'head', peer:'head-1' }); await waitFor(()=>signals(axol,'request').length===1);
    const request=signals(axol,'request')[0]; expect(request).toEqual({ type:'rtc', version:1, kind:'request', stream:'head', peer:'head-1', from:expect.stringMatching(/^c\d+$/) }); const viewerId=request.from;
    rtc(axol,{ kind:'offer', to:viewerId, peer:'head-1', sdp:'v=0 offer' }); await waitFor(()=>signals(viewer,'offer').length===1);
    const offer=signals(viewer,'offer')[0]; expect(offer).toEqual({ type:'rtc', version:1, kind:'offer', peer:'head-1', stream:'head', from:expect.stringMatching(/^c\d+$/), sdp:'v=0 offer' }); const axolId=offer.from; expect(axolId).not.toBe(viewerId);
    // Whatever `from` a client claims, the gateway says who it is.
    rtc(viewer,{ kind:'answer', to:axolId, peer:'head-1', sdp:'v=0 answer', from:'c999' }); await waitFor(()=>signals(axol,'answer').length===1); expect(signals(axol,'answer')[0]).toMatchObject({ from:viewerId, sdp:'v=0 answer', peer:'head-1' });
    const candidate={ candidate:'candidate:1 1 udp 2122260223 10.0.0.2 50000 typ host', sdpMid:'0', sdpMLineIndex:0 };
    rtc(viewer,{ kind:'candidate', to:axolId, peer:'head-1', candidate }); rtc(axol,{ kind:'candidate', to:viewerId, peer:'head-1', candidate });
    await waitFor(()=>signals(axol,'candidate').length===1&&signals(viewer,'candidate').length===1); expect(signals(axol,'candidate')[0]).toMatchObject({ from:viewerId, candidate }); expect(signals(viewer,'candidate')[0]).toMatchObject({ from:axolId, candidate });
    // A third client can't reach into someone else's connection, and nobody can use a peer name they never requested.
    rtc(intruder,{ kind:'offer', to:viewerId, peer:'head-1', sdp:'v=0 evil' }); rtc(intruder,{ kind:'candidate', to:axolId, peer:'head-1', candidate:{ candidate:'evil' } }); rtc(intruder,{ kind:'close', to:axolId, peer:'head-1' });
    rtc(viewer,{ kind:'candidate', to:axolId, peer:'head-2', candidate }); rtc(viewer,{ kind:'answer', to:'c999', peer:'head-1', sdp:'v=0' });
    await waitFor(()=>signals(intruder,'error').length===3&&signals(viewer,'error').length===2); expect(signals(intruder,'error')[0]).toMatchObject({ peer:'head-1', message:expect.stringMatching(/No WebRTC connection/) });
    await sleep(30); expect(signals(viewer,'offer')).toHaveLength(1); expect(signals(axol,'candidate')).toHaveLength(1); expect(signals(axol,'close')).toHaveLength(0);
    // Phones and mirrors request too; a stream nobody publishes gets an error.
    rtc(a,{ kind:'request', stream:'head', peer:'p1' }); rtc(mirror,{ kind:'request', stream:'head', peer:'p1' }); await waitFor(()=>signals(axol,'request').length===3);
    expect(new Set(signals(axol,'request').map(m=>m.from)).size).toBe(3);
    rtc(viewer,{ kind:'request', stream:'arm-left', peer:'arm-1' }); await waitFor(()=>signals(viewer,'error').length===3); expect(signals(viewer,'error')[2]).toMatchObject({ kind:'error', stream:'arm-left', peer:'arm-1', message:'Nobody publishes "arm-left" over WebRTC' });
    // Either end may close; after that the pair is gone.
    rtc(viewer,{ kind:'close', to:axolId, peer:'head-1' }); await waitFor(()=>signals(axol,'close').length===1); expect(signals(axol,'close')[0]).toMatchObject({ from:viewerId, peer:'head-1', stream:'head' });
    rtc(axol,{ kind:'candidate', to:viewerId, peer:'head-1', candidate }); await waitFor(()=>signals(axol,'error').length===1);
    for (const c of [axol,viewer,a,mirror,intruder]) c.ws.close(); });
  it('tells the other end when either end goes away, and forgets a robot\'s streams when it leaves', async()=>{ await start(); const axol=await robot('axol'); const viewer=await connect(); const other=await connect();
    await published(axol,other); rtc(viewer,{ kind:'request', stream:'head', peer:'head-1' }); rtc(other,{ kind:'request', stream:'head', peer:'head-2' }); await waitFor(()=>signals(axol,'request').length===2);
    const [fromViewer,fromOther]=signals(axol,'request').map(m=>m.from);
    viewer.ws.close(); await waitFor(()=>signals(axol,'close').length===1); expect(signals(axol,'close')[0]).toMatchObject({ peer:'head-1', from:fromViewer, stream:'head' });
    rtc(axol,{ kind:'offer', to:fromOther, peer:'head-2', sdp:'v=0' }); await waitFor(()=>signals(other,'offer').length===1); const axolId=signals(other,'offer')[0].from;
    axol.ws.close(); await waitFor(()=>signals(other,'close').length===1); expect(signals(other,'close')[0]).toMatchObject({ peer:'head-2', from:axolId, stream:'head', message:'The publisher went away' });
    await waitFor(()=>streamOf(other.configOf(),'head').transport===undefined); expect(other.configOf().robots[0]).toMatchObject({ connected:false, streams:[] });
    // Unpublishing closes the viewers' connections too.
    const jelly=await robot('jelly'); await published(jelly,other); rtc(other,{ kind:'request', stream:'head', peer:'head-3' }); await waitFor(()=>signals(jelly,'request').length===1);
    rtc(jelly,{ kind:'unpublish' }); await waitFor(()=>signals(other,'close').length===2); expect(signals(other,'close')[1]).toMatchObject({ peer:'head-3', message:'The stream is no longer published' });
    for (const c of [other,jelly]) c.ws.close(); });
});
