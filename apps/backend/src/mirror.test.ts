import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, defaultConfig } from '@marionette/protocol';
import { screenPreview } from './preview.js';

/** A stand-in for the browser's WebSocket: the test opens, feeds and drops it. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0; sent: any[] = []; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: (event: { code: number }) => void;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: object) { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}
const HTML = '<!doctype html><html><head><title>t</title></head><body><p>screen</p></body></html>';
/** Runs the bridge the gateway serves at `/screen` in a fake page; returns the page's `window.Marionette` and every event it emitted. */
function mirrorPage(search: string) {
  const script = /<head><script>([\s\S]*?)<\/script>/.exec(screenPreview(HTML, 'phone-1'))![1];
  const page: any = { dispatchEvent() {} }; const location = { protocol: 'http:', host: 'gateway:8787', search, reloads: 0, reload() { this.reloads++; } };
  new Function('window', 'location', 'WebSocket', 'Event', 'performance', script)(page, location, FakeSocket, class { constructor(public type: string) {} }, { now: () => Date.now() });
  const events: { type: string; payload: any }[] = [];
  for (const type of ['connection', 'link', 'robot_state', 'robots', 'rtc', 'config']) page.Marionette.on(type, (payload: any) => events.push({ type, payload }));
  return { M: page.Marionette, events, location, of: (type: string) => events.filter(e => e.type === type).map(e => e.payload) };
}
const phoneConfig = (id = 'phone-1') => ({ ...defaultConfig(), sessionId:'g', phone:{ id, name:id, color:'#c98200', connected:true } });
const actions = (ws: FakeSocket) => ws.sent.filter(m => m.type === 'action');
/** A mirror the gateway has taken in: socket open, screen and config received. */
function connected(ws: FakeSocket, id = 'phone-1') { ws.open(); ws.receive({ type:'html_config', version:1, html:HTML }); ws.receive(phoneConfig(id)); }

afterEach(() => { vi.useRealTimers(); FakeSocket.all = []; });

describe('the /screen mirror bridge',()=>{
  it('connects with the page\'s token, relays robot state and signaling both ways, and measures the link', ()=>{ vi.useFakeTimers(); const { M, of, events } = mirrorPage('?phone=phone-1&token=k7q2-m9xd');
    expect(M.features).toEqual(['live','robot_state','link','rtc','reconnect']);
    const ws = FakeSocket.all[0]; expect(ws.url).toBe('ws://gateway:8787/ws?token=k7q2-m9xd'); ws.open();
    // An open socket is not yet a connection: that is the gateway's config, which the page gets first.
    expect(ws.sent[0]).toEqual({ type:'hello', version:1, role:'console', follow:'phone-1' }); expect(of('connection')).toEqual([]);
    ws.receive({ type:'html_config', version:1, html:HTML }); ws.receive({ ...phoneConfig(), robots:[{ id:'axol', name:'Axol', connected:true }] });
    expect(events.map(e => e.type).slice(-3)).toEqual(['robots','config','connection']); expect(of('connection').at(-1)).toMatchObject({ state:'connected' });
    ws.receive({ type:'robot_state', version:1, robotId:'axol', state:{ ready:true }, everyMs:200 }); ws.receive({ type:'robot_state', version:1, robotId:'axol', phoneId:'phone-1', state:{ arm:'left' } });
    expect(of('robot_state')).toHaveLength(2); expect(of('robots').at(-1).axol).toMatchObject({ name:'Axol', connected:true, state:{ ready:true }, phoneState:{ arm:'left' }, everyMs:200 });
    // Signaling goes out through the page's Marionette.rtc and comes back as rtc events.
    M.rtc({ kind:'request', stream:'head', peer:'head-1' }); expect(ws.sent.at(-1)).toEqual({ type:'rtc', version:PROTOCOL_VERSION, kind:'request', stream:'head', peer:'head-1' });
    ws.receive({ type:'rtc', version:1, kind:'offer', peer:'head-1', from:'c1', sdp:'v=0' }); expect(of('rtc').at(-1)).toMatchObject({ kind:'offer', from:'c1', sdp:'v=0' });
    // A ping each second; the pong's round trip is the link.
    vi.advanceTimersByTime(1000); const sent = ws.sent.filter(m=>m.type==='ping'); expect(sent).toHaveLength(1); vi.advanceTimersByTime(25);
    ws.receive({ type:'pong', version:1, id:sent[0].id, sentAt:sent[0].sentAt, at:Date.now() }); expect(of('link').at(-1)).toEqual({ rttMs:25, quality:'good' });
    ws.receive({ type:'ping', version:1, id:9, sentAt:5 }); expect(ws.sent.at(-1)).toMatchObject({ type:'pong', id:9, sentAt:5 }); });
  it('reconnects in place, saying so, reloads only for a different screen, and stops on a pairing refusal', ()=>{ vi.useFakeTimers(); const { M, of, location } = mirrorPage('?phone=phone-1');
    const first = FakeSocket.all[0]; expect(first.url).toBe('ws://gateway:8787/ws'); first.open(); first.receive({ type:'html_config', version:1, html:HTML });
    first.drop(); expect(of('connection').at(-1)).toMatchObject({ state:'reconnecting' }); expect(of('link').at(-1)).toEqual({ quality:'unknown' });
    vi.advanceTimersByTime(1000); const second = FakeSocket.all[1]; expect(second).toBeDefined(); second.open(); expect(of('connection').at(-1)).toMatchObject({ state:'reconnecting' });
    second.receive({ type:'html_config', version:1, html:HTML }); expect(location.reloads).toBe(0); second.receive(phoneConfig()); expect(of('connection').at(-1)).toMatchObject({ state:'connected' });
    // A ping nobody answers for 3.5 s is a dead connection, even if the socket hasn't noticed.
    vi.advanceTimersByTime(5000); expect(of('connection').at(-1)).toMatchObject({ state:'reconnecting' }); vi.advanceTimersByTime(1000);
    const third = FakeSocket.all.at(-1)!; expect(third).not.toBe(second); third.open(); third.receive({ type:'html_config', version:1, html:'<p>new screen</p>' }); expect(location.reloads).toBe(1);
    third.drop(4401); expect(of('connection').at(-1)).toMatchObject({ state:'disconnected', reason:expect.stringMatching(/pairing code/) }); const count = FakeSocket.all.length; vi.advanceTimersByTime(5000); expect(FakeSocket.all).toHaveLength(count);
    // While it is down, signaling is answered with an error instead of vanishing.
    M.rtc({ kind:'request', stream:'head', peer:'head-1' }); expect(of('rtc').at(-1)).toMatchObject({ kind:'error', peer:'head-1', stream:'head' }); });
  it('cuts a drag the connection dropped until the finger lifts, and never repeats what it could not send', ()=>{ vi.useFakeTimers(); const { M, of } = mirrorPage('?phone=phone-1');
    const first = FakeSocket.all[0]; connected(first);
    M.sendAction('drive','base.drive',{ x:0, y:0.5 },{ live:true }); M.sendAction('deadman','teleop.deadman',true); vi.advanceTimersByTime(250);
    expect(actions(first).filter(m=>m.controlId==='drive' && m.renew)).not.toHaveLength(0); expect(actions(first).filter(m=>m.controlId==='deadman' && m.renew)).not.toHaveLength(0);
    first.drop(); expect(of('connection').at(-1)).toMatchObject({ state:'reconnecting' });
    // While it is down the finger keeps moving, a second stick starts, and a hold is pressed: none of it can go out.
    M.sendAction('drive','base.drive',{ x:0, y:0.6 },{ live:true }); M.sendAction('sensitivity','teleop.translationScale',0.5,{ live:true }); M.sendAction('turn-left','base.turnLeft',true);
    vi.advanceTimersByTime(1000); const second = FakeSocket.all[1]; second.open();
    // Open, but without its config the mirror is still reconnecting and sends nothing.
    M.sendAction('grip','gripper.hold',true); expect(of('connection').at(-1)).toMatchObject({ state:'reconnecting' });
    second.receive({ type:'html_config', version:1, html:HTML }); second.receive(phoneConfig()); expect(of('connection').at(-1)).toMatchObject({ state:'connected' });
    // Back, with the fingers still down and moving: no stream starts by itself, and nothing from before is repeated.
    M.sendAction('drive','base.drive',{ x:0.1, y:0.7 },{ live:true }); M.sendAction('sensitivity','teleop.translationScale',0.6,{ live:true }); vi.advanceTimersByTime(1000);
    expect(actions(second)).toEqual([]);
    // Lifting the finger ends the cut drag here; the next touch streams again, and a new press is held.
    M.sendAction('drive','base.drive',{ x:0, y:0 }); M.sendAction('sensitivity','teleop.translationScale',0.6); expect(actions(second)).toEqual([]);
    M.sendAction('drive','base.drive',{ x:0, y:0.2 },{ live:true }); M.sendAction('deadman','teleop.deadman',true); vi.advanceTimersByTime(250);
    expect(actions(second)[0]).toMatchObject({ controlId:'drive', value:{ x:0, y:0.2 }, live:true, sessionId:'g' }); expect(actions(second)[1]).toMatchObject({ controlId:'deadman', value:true });
    expect(new Set(actions(second).map(m=>m.controlId))).toEqual(new Set(['drive','deadman'])); expect(actions(second).filter(m=>m.renew).length).toBeGreaterThan(2); });
  it('cuts a drag when the gateway moves the mirror to another phone', ()=>{ vi.useFakeTimers(); const { M } = mirrorPage('');
    const ws = FakeSocket.all[0]; connected(ws, 'phone-1');
    M.sendAction('drive','base.drive',{ x:0, y:0.5 },{ live:true }); M.sendAction('deadman','teleop.deadman',true); const before = actions(ws).length; expect(before).toBe(2);
    // Phone 1 left; the mirror now follows phone 2, with the finger still on the stick.
    ws.receive(phoneConfig('phone-2')); M.sendAction('drive','base.drive',{ x:0, y:0.6 },{ live:true }); vi.advanceTimersByTime(1000);
    expect(actions(ws)).toHaveLength(before);
    M.sendAction('drive','base.drive',{ x:0, y:0 }); expect(actions(ws)).toHaveLength(before);
    M.sendAction('drive','base.drive',{ x:0.2, y:0 },{ live:true }); expect(actions(ws).at(-1)).toMatchObject({ controlId:'drive', value:{ x:0.2, y:0 }, live:true }); });
});
