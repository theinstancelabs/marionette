import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@marionette/protocol';
import { page, type Page } from './page';

let p: Page;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { expect(p.errors).toEqual([]); p.close(); vi.useRealTimers(); });

const axol = (connected = true) => ({ robots: [{ id: 'axol', name: 'Axol', connected, screen: true }, { id: 'cart', name: 'Cart', connected: true }] });
const state = (extra: Record<string, unknown>) => ({ type: 'robot_state', version: PROTOCOL_VERSION, robotId: 'axol', receivedAt: 1, ...extra });

describe('robots', () => {
  it('goes stale without an update for staleAfterMs(everyMs), re-checked on a timer', () => {
    p = page(); p.connect(); const seen: any[] = [];
    p.K.robot((r: any) => seen.push(r && { name: r.name, stale: r.stale, offline: r.offline, values: r.values }));
    expect(seen).toEqual([undefined]);
    p.config({}, axol());
    // The screen's own robot, connected, with nothing said yet.
    expect(seen.at(-1)).toEqual({ name: 'Axol', stale: false, offline: false, values: {} });
    vi.advanceTimersByTime(1400); expect(seen.at(-1).stale).toBe(false);
    vi.advanceTimersByTime(400); expect(seen.at(-1).stale).toBe(true);
    // A state that says it repeats every second: stale after 3 s without another.
    p.receive('robot_state', state({ state: { ready: true, battery: null }, everyMs: 1000 }));
    expect(seen.at(-1)).toEqual({ name: 'Axol', stale: false, offline: false, values: { ready: true, battery: null } });
    vi.advanceTimersByTime(2900); expect(seen.at(-1).stale).toBe(false);
    vi.advanceTimersByTime(300); expect(seen.at(-1).stale).toBe(true);
    // State for this phone sits over the global state; state for another phone never arrives.
    p.receive('robot_state', state({ phoneId: 'phone-1', state: { arm: 'left' }, everyMs: 1000 }));
    p.receive('robot_state', state({ phoneId: 'phone-2', state: { arm: 'right' }, everyMs: 1000 }));
    expect(seen.at(-1)).toEqual({ name: 'Axol', stale: false, offline: false, values: { ready: true, battery: null, arm: 'left' } });
    // Gone: offline (never stale), with its last state kept.
    p.config({}, axol(false));
    expect(seen.at(-1)).toEqual({ name: 'Axol', stale: false, offline: true, values: { ready: true, battery: null, arm: 'left' } });
    vi.advanceTimersByTime(10_000); expect(seen.at(-1).offline).toBe(true); expect(seen.at(-1).stale).toBe(false);
  });

  it('lists every robot, and picks one by id', () => {
    p = page(); p.connect(); p.config({}, axol());
    let all: any; const off = p.K.robots((views: any) => { all = views; });
    expect(Object.keys(all)).toEqual(['axol', 'cart']); expect(all.cart).toMatchObject({ name: 'Cart', connected: true, screen: false, staleAfterMs: 1500 });
    let cart: any; p.K.robot('cart', (r: any) => { cart = r; });
    p.receive('robot_state', { ...state({ state: { speed: 0.4 }, everyMs: 200 }), robotId: 'cart' });
    expect(cart.values).toEqual({ speed: 0.4 }); expect(cart.ageMs).toBe(0); expect(all.cart.everyMs).toBe(200);
    off(); const before = all; vi.advanceTimersByTime(5000); expect(all).toBe(before);
  });
});

/** A stand-in for the browser's RTCPeerConnection: gathers ICE 50 ms after the answer is set, unless told to hang. */
class FakePC extends EventTarget {
  static all: FakePC[] = [];
  static hangIce = false;
  connectionState = 'new'; iceGatheringState = 'new'; remoteDescription: any = null; localDescription: any = null; closed = false; added: any[] = [];
  constructor(public config: any) { super(); FakePC.all.push(this); }
  async setRemoteDescription(d: any) { this.remoteDescription = d; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
  async setLocalDescription(d: any) {
    this.localDescription = d; this.iceGatheringState = 'gathering';
    if (!FakePC.hangIce) setTimeout(() => { this.iceGatheringState = 'complete'; this.localDescription = { type: 'answer', sdp: d.sdp + ' a=candidate' }; this.dispatchEvent(new Event('icegatheringstatechange')); }, 50);
  }
  async addIceCandidate(c: any) { this.added.push(c); }
  close() { this.closed = true; this.connectionState = 'closed'; }
  state(s: string) { this.connectionState = s; this.dispatchEvent(new Event('connectionstatechange')); }
  track() { const e: any = new Event('track'); e.track = { kind: 'video' }; e.streams = [{ id: 'media' }]; this.dispatchEvent(e); }
}

const rtcStreams = (head: Record<string, unknown> = { transport: 'webrtc', publisher: 'axol' }) => ({
  cameraStreams: [{ id: 'head', label: 'Head', url: 'axol://head', status: 'live' as const, ...head }, { id: 'arm-left', label: 'Left arm', url: 'sim://arm-left', status: 'live' as const }, { id: 'arm-right', label: 'Right arm', url: 'sim://arm-right', status: 'live' as const }],
});

describe('cameras', () => {
  beforeEach(() => { FakePC.all = []; FakePC.hangIce = false; });
  function rtcPage(features?: any) {
    p = page({ features, body: '<figure id="cam"></figure>', setup: w => { w.RTCPeerConnection = FakePC; } });
    p.connect(); p.config({}, rtcStreams());
    return p.K.cameras(p.document.getElementById('cam'));
  }
  const pane = (id = 'head') => p.document.querySelector(`[data-stream="${id}"]`) as HTMLElement;
  const offer = (peer: string, from = 'c7') => p.receive('rtc', { type: 'rtc', version: PROTOCOL_VERSION, kind: 'offer', from, peer, sdp: 'v=0 offer' });

  it('requests a WebRTC stream, answers the offer once ICE is gathered, and plays it', async () => {
    rtcPage();
    const [request] = p.rtc(); expect(request).toMatchObject({ type: 'rtc', kind: 'request', stream: 'head' }); expect(request.peer).toMatch(/^head-[a-z0-9]+$/);
    expect(pane().dataset.transport).toBe('webrtc'); expect(pane().dataset.state).toBe('waiting'); expect(pane().textContent).toContain('Waiting for head');
    offer(request.peer);
    p.receive('rtc', { type: 'rtc', version: PROTOCOL_VERSION, kind: 'candidate', from: 'c7', peer: request.peer, candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host', sdpMid: '0' } });
    await vi.advanceTimersByTimeAsync(10);
    const pc = FakePC.all[0]; expect(pc.config).toEqual({ iceServers: [] }); expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'v=0 offer' });
    expect(pc.added).toHaveLength(1);
    expect(p.rtc()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(p.rtc()[1]).toEqual({ type: 'rtc', version: 1, kind: 'answer', to: 'c7', peer: request.peer, sdp: 'v=0 answer a=candidate' });
    pc.track(); const video = pane().querySelector('video')!;
    expect(video.hasAttribute('autoplay') && video.hasAttribute('playsinline') && video.muted).toBe(true);
    expect((video as any).srcObject).toEqual({ id: 'media' });
    video.dispatchEvent(new p.window.Event('playing'));
    expect(pane().dataset.state).toBe('live'); expect(video.hidden).toBe(false); expect(pane().querySelector('figcaption')!.hidden).toBe(false);
  });

  it('answers after 2 s with what ICE has when gathering does not finish', async () => {
    FakePC.hangIce = true; rtcPage(); const peer = p.rtc()[0].peer; offer(peer);
    await vi.advanceTimersByTimeAsync(1900); expect(p.rtc()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200); expect(p.rtc()[1]).toMatchObject({ kind: 'answer', to: 'c7', peer, sdp: 'v=0 answer' });
  });

  it('shows the pane as unavailable and retries 2 s, 4 s, 8 s, then every 10 s', async () => {
    rtcPage(); const requests = () => p.rtc().filter(m => m.kind === 'request');
    const first = requests()[0].peer; offer(first); await vi.advanceTimersByTimeAsync(100);
    FakePC.all[0].state('failed');
    expect(p.rtc().at(-1)).toEqual({ type: 'rtc', version: 1, kind: 'close', to: 'c7', peer: first }); expect(FakePC.all[0].closed).toBe(true);
    expect(pane().dataset.state).toBe('unavailable'); expect(pane().textContent).toContain('Head unavailable, retrying');
    const gaps: number[] = []; let at = Date.now();
    for (let i = 0; i < 5; i++) {
      const count = requests().length;
      while (requests().length === count) await vi.advanceTimersByTimeAsync(100);
      gaps.push(Math.round((Date.now() - at) / 1000)); at = Date.now();
      // Nobody publishes it now: the gateway answers with an error.
      p.receive('rtc', { type: 'rtc', version: 1, kind: 'error', peer: requests().at(-1).peer, message: 'nobody publishes head' });
    }
    expect(gaps).toEqual([2, 4, 8, 10, 10]);
    // A close from the robot is a failure too, but not answered with a close.
    const count = requests().length; while (requests().length === count) await vi.advanceTimersByTimeAsync(100);
    const peer = requests().at(-1).peer; offer(peer, 'c9'); await vi.advanceTimersByTimeAsync(100);
    p.receive('rtc', { type: 'rtc', version: 1, kind: 'close', from: 'c9', peer });
    expect(p.rtc().filter(m => m.kind === 'close' && m.peer === peer)).toEqual([]);
    expect(pane().dataset.state).toBe('unavailable');
  });

  it('closes on a view change, a hidden page or the stream leaving WebRTC, and asks again when it comes back', async () => {
    rtcPage(); let peer = p.rtc()[0].peer; offer(peer); await vi.advanceTimersByTimeAsync(100);
    // Another view: close the head stream; the arm streams are JPEG.
    p.config({ cameras: { value: 'arms' } as never }, rtcStreams());
    expect(p.rtc().at(-1)).toEqual({ type: 'rtc', version: 1, kind: 'close', to: 'c7', peer });
    expect([pane('arm-left').dataset.transport, pane('arm-right').dataset.transport]).toEqual(['jpeg', 'jpeg']);
    p.config({ cameras: { value: 'head' } as never }, rtcStreams());
    peer = p.rtc().at(-1).peer; expect(p.rtc().at(-1)).toMatchObject({ kind: 'request', stream: 'head' });
    offer(peer); await vi.advanceTimersByTimeAsync(100);
    Object.defineProperty(p.document, 'hidden', { value: true, configurable: true }); p.document.dispatchEvent(new p.window.Event('visibilitychange'));
    expect(p.rtc().at(-1)).toEqual({ type: 'rtc', version: 1, kind: 'close', to: 'c7', peer });
    vi.advanceTimersByTime(30_000); expect(p.rtc().at(-1).kind).toBe('close');
    Object.defineProperty(p.document, 'hidden', { value: false, configurable: true }); p.document.dispatchEvent(new p.window.Event('visibilitychange'));
    peer = p.rtc().at(-1).peer; expect(p.rtc().at(-1)).toMatchObject({ kind: 'request', stream: 'head' });
    offer(peer); await vi.advanceTimersByTimeAsync(100);
    // The robot stopped publishing it: close, and show its JPEG frames.
    p.config({}, rtcStreams({ transport: 'jpeg' }));
    expect(p.rtc().at(-1)).toEqual({ type: 'rtc', version: 1, kind: 'close', to: 'c7', peer });
    expect(pane().dataset.transport).toBe('jpeg');
    const sent = p.rtc().length; vi.advanceTimersByTime(30_000); expect(p.rtc()).toHaveLength(sent);
  });

  it('turns away an offer for a request it gave up on, and re-asks after the gateway comes back', async () => {
    rtcPage(); const peer = p.rtc()[0].peer;
    // No offer within 10 s: give up and ask again later; the late offer gets a close.
    await vi.advanceTimersByTimeAsync(10_100); expect(pane().dataset.state).toBe('unavailable');
    offer(peer, 'c4'); expect(p.rtc().at(-1)).toEqual({ type: 'rtc', version: 1, kind: 'close', to: 'c4', peer });
    await vi.advanceTimersByTimeAsync(2100); const again = p.rtc().at(-1); expect(again).toMatchObject({ kind: 'request', stream: 'head' });
    offer(again.peer); await vi.advanceTimersByTimeAsync(100);
    // The gateway went away: drop the connection quietly; ask again once it is back.
    const sent = p.rtc().length; p.connect('reconnecting'); expect(p.rtc()).toHaveLength(sent); expect(FakePC.all.at(-1)!.closed).toBe(true);
    p.connect('connected'); expect(p.rtc().at(-1)).toMatchObject({ kind: 'request', stream: 'head' }); expect(p.rtc().at(-1).peer).not.toBe(again.peer);
  });

  it('shows JPEG frames when the host has no rtc, and fresh frames only', () => {
    p = page({ features: ['live'], body: '<figure id="cam"></figure>', setup: w => { w.RTCPeerConnection = FakePC; } });
    p.connect(); p.config({}, rtcStreams()); p.K.cameras(p.document.getElementById('cam'));
    expect(p.rtc()).toEqual([]); expect(pane().dataset.transport).toBe('jpeg');
    p.receive('camera_frame', { type: 'camera_frame', version: 1, sessionId: 'g', cameraId: 'head', dataUrl: 'data:image/jpeg;base64,AAAA', capturedAt: 1 });
    const img = pane().querySelector('img')!; expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA'); expect(img.hidden).toBe(false); expect(pane().dataset.state).toBe('live');
    vi.advanceTimersByTime(2100); expect(img.hidden).toBe(true); expect(pane().textContent).toContain('Waiting for head');
  });

  it('uses JPEG without RTCPeerConnection, and stacks several panes on a tap', () => {
    p = page({ body: '<figure id="cam"></figure>' }); p.connect(); p.config({ cameras: { value: 'arms' } as never }, rtcStreams());
    const cam = p.K.cameras(p.document.getElementById('cam')).el;
    expect(cam.getAttribute('data-panes')).toBe('2'); expect(cam.getAttribute('role')).toBe('button'); expect(cam.getAttribute('aria-expanded')).toBe('false');
    cam.click(); expect(cam.getAttribute('aria-expanded')).toBe('true');
    p.config({ cameras: { value: 'head' } as never }, rtcStreams());
    expect(p.rtc()).toEqual([]); expect(cam.hasAttribute('role')).toBe(false); expect(pane().dataset.transport).toBe('jpeg');
  });
});
