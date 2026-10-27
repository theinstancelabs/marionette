import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RtcMessage } from '@marionette/protocol';
import { RTC_ICE_WAIT_MS, RTC_OFFER_WAIT_MS, RtcViewer, type PeerLike, type RtcOut, type VideoState } from './rtc';

/** Enough of RTCPeerConnection for the viewer's side: it answers an offer and gathers ICE when told to. */
class FakePeer {
  iceGatheringState: RTCIceGatheringState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp?: string } | null = null;
  added: unknown[] = []; closed = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  addEventListener(type: string, fn: (event: unknown) => void) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(fn); }
  removeEventListener(type: string, fn: (event: unknown) => void) { this.listeners.get(type)?.delete(fn); }
  emit(type: string, event: unknown = {}) { for (const fn of [...this.listeners.get(type) ?? []]) fn(event); }
  async setRemoteDescription(description: { type: string; sdp?: string }) { this.remoteDescription = description; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
  async setLocalDescription(description: { type: string; sdp: string }) { this.localDescription = description; this.iceGatheringState = 'gathering'; }
  async addIceCandidate(candidate: unknown) { this.added.push(candidate); }
  close() { this.closed = true; }
  gathered() { this.localDescription = { type: 'answer', sdp: 'v=0 answer with candidates' }; this.iceGatheringState = 'complete'; this.emit('icegatheringstatechange'); }
}

function setup() {
  const sent: RtcOut[] = []; const peers: FakePeer[] = []; let n = 0;
  const rtc = new RtcViewer({ send: message => sent.push(message), createPeer: () => { const peer = new FakePeer(); peers.push(peer); return peer as unknown as PeerLike; }, random: () => `r${++n}` });
  const states: VideoState[] = [];
  const offer = (peer: string, from = 'c7'): RtcMessage => ({ type: 'rtc', version: 1, kind: 'offer', peer, from, stream: 'head', sdp: 'v=0 offer' });
  return { rtc, sent, peers, states, offer, kinds: () => sent.map(message => message.kind) };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('WebRTC video in a camera pane', () => {
  it('requests the stream, answers the robot’s offer once ICE is gathered, and plays its track', async () => {
    const { rtc, sent, peers, states, offer } = setup();
    rtc.watch('head', 'humanoid', state => states.push(state));
    expect(sent).toEqual([{ kind: 'request', stream: 'head', peer: 'head-r1' }]);
    expect(states).toEqual([{ status: 'connecting' }]);
    // A candidate can come before the offer is applied; it waits for the remote description.
    rtc.receive({ type: 'rtc', version: 1, kind: 'candidate', peer: 'head-r1', from: 'c7', candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
    rtc.receive(offer('head-r1'));
    await flush();
    const peer = peers[0];
    expect(peer.remoteDescription).toEqual({ type: 'offer', sdp: 'v=0 offer' });
    expect(peer.added).toHaveLength(1);
    // Non-trickle: no answer until gathering completes.
    expect(sent).toHaveLength(1);
    peer.gathered(); await flush();
    expect(sent[1]).toEqual({ kind: 'answer', to: 'c7', peer: 'head-r1', sdp: 'v=0 answer with candidates' });
    const media = { id: 'media' } as unknown as MediaStream;
    peer.emit('track', { streams: [media], track: {} });
    expect(states.at(-1)).toEqual({ status: 'video', media });
  });

  it('answers with what it has after 2 s of ICE gathering', async () => {
    const { rtc, sent, offer } = setup();
    rtc.watch('head', 'humanoid', () => {});
    rtc.receive(offer('head-r1')); await flush();
    expect(sent.map(message => message.kind)).toEqual(['request']);
    await vi.advanceTimersByTimeAsync(RTC_ICE_WAIT_MS);
    expect(sent[1]).toMatchObject({ kind: 'answer', sdp: 'v=0 answer' });
  });

  it('closes the connection when the pane goes away, and turns down an offer that comes too late', async () => {
    const { rtc, sent, peers, offer, kinds } = setup();
    const stop = rtc.watch('head', 'humanoid', () => {});
    rtc.receive(offer('head-r1')); await flush(); peers[0].gathered(); await flush();
    stop();
    expect(sent.at(-1)).toEqual({ kind: 'close', to: 'c7', peer: 'head-r1' });
    expect(peers[0].closed).toBe(true);
    expect(rtc.open).toBe(0);
    // Gone before the robot offered: there is no one to tell yet, so the late offer is closed when it comes.
    const early = rtc.watch('arm-left', 'humanoid', () => {}); early();
    expect(kinds()).toEqual(['request', 'answer', 'close', 'request']);
    rtc.receive({ ...offer('arm-left-r2', 'c9'), stream: 'arm-left' });
    expect(sent.at(-1)).toEqual({ kind: 'close', to: 'c9', peer: 'arm-left-r2' });
    expect(peers).toHaveLength(1);
  });

  it('retries after an error or a close, 2 s doubling to 10 s, without closing back what the robot closed', async () => {
    const { rtc, sent, states, offer, kinds } = setup();
    rtc.watch('head', 'humanoid', state => states.push(state));
    rtc.receive({ type: 'rtc', version: 1, kind: 'error', peer: 'head-r1', message: 'Nobody publishes "head" over WebRTC' });
    expect(states.at(-1)).toEqual({ status: 'failed', why: 'Nobody publishes "head" over WebRTC' });
    // Not answered yet, so nothing to close.
    expect(kinds()).toEqual(['request']);
    await vi.advanceTimersByTimeAsync(1999); expect(kinds()).toEqual(['request']);
    await vi.advanceTimersByTimeAsync(1); expect(sent.at(-1)).toEqual({ kind: 'request', stream: 'head', peer: 'head-r2' });
    // The robot offers, then closes: the viewer doesn't send close back, and asks again after 4 s.
    rtc.receive(offer('head-r2')); await vi.advanceTimersByTimeAsync(RTC_ICE_WAIT_MS);
    rtc.receive({ type: 'rtc', version: 1, kind: 'close', peer: 'head-r2', from: 'c7', message: 'The publisher went away' });
    expect(kinds()).toEqual(['request', 'request', 'answer']);
    await vi.advanceTimersByTimeAsync(3999); expect(kinds()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1); expect(kinds()).toEqual(['request', 'request', 'answer', 'request']);
    // No offer at all: given up after 10 s, then asked again after 8 s, then every 10 s.
    await vi.advanceTimersByTimeAsync(RTC_OFFER_WAIT_MS); expect(states.at(-1)).toEqual({ status: 'failed', why: 'the robot sent no video offer' });
    await vi.advanceTimersByTimeAsync(8000); expect(kinds()).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(RTC_OFFER_WAIT_MS + 10_000); expect(kinds()).toHaveLength(6);
  });

  it('fails over a failed connection, and ignores messages for other peers', async () => {
    const { rtc, sent, peers, states, offer } = setup();
    rtc.watch('head', 'humanoid', state => states.push(state));
    rtc.receive(offer('somebody-else')); await flush();
    expect(peers).toHaveLength(0);
    rtc.receive(offer('head-r1')); await flush(); peers[0].gathered(); await flush();
    peers[0].connectionState = 'failed'; peers[0].emit('connectionstatechange');
    expect(states.at(-1)).toEqual({ status: 'failed', why: 'the video connection failed' });
    expect(sent.at(-1)).toEqual({ kind: 'close', to: 'c7', peer: 'head-r1' });
  });

  it('drops everything quietly when the gateway goes away', async () => {
    const { rtc, sent, peers, offer } = setup();
    rtc.watch('head', 'humanoid', () => {}); rtc.watch('arm-left', 'humanoid', () => {});
    rtc.receive(offer('head-r1')); await flush();
    rtc.reset();
    expect(peers[0].closed).toBe(true); expect(rtc.open).toBe(0);
    const before = sent.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(before);
  });
});
