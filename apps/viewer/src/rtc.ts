import type { RtcCandidate, RtcMessage } from '@marionette/protocol';

/** What a camera pane shows for a WebRTC stream: waiting for the robot, its video, or a failure it retries after. */
export type VideoState = { status: 'connecting' } | { status: 'video'; media: MediaStream } | { status: 'failed'; why: string };
/** The `rtc` fields the viewer sends; the gateway connection adds `type` and `version`. */
export type RtcOut = Omit<RtcMessage, 'type' | 'version'>;
/** The parts of `RTCPeerConnection` the viewer uses, so tests can pass a fake. */
export type PeerLike = Pick<RTCPeerConnection, 'setRemoteDescription' | 'setLocalDescription' | 'createAnswer' | 'addIceCandidate' | 'close'
  | 'addEventListener' | 'removeEventListener' | 'iceGatheringState' | 'connectionState' | 'localDescription' | 'remoteDescription'>;

export const RTC_RETRY_MS = 2000, RTC_RETRY_MAX_MS = 10_000, RTC_ICE_WAIT_MS = 2000, RTC_OFFER_WAIT_MS = 10_000;

/** One request: the viewer's `peer` name for it, and once the robot offers, the robot's client id (`to`) and the peer connection. */
type Attempt = { peer: string; to?: string; pc?: PeerLike; candidates: RtcCandidate[]; offerTimer?: ReturnType<typeof setTimeout>; closed: boolean };
/** A pane watching one stream for as long as it is on screen, across retries. */
type Watch = { stream: string; publisher: string; listener: (state: VideoState) => void; attempt?: Attempt; retry?: ReturnType<typeof setTimeout>; backoff: number };

/**
 * The desktop viewer's side of WebRTC video, the same flow as the screen kit's cameras: a pane asks the gateway for a
 * stream (`request`), the robot offers, and the viewer answers once its ICE candidates are gathered (non-trickle,
 * at most 2 s), so one answer carries everything. A failure, an `error` or a `close` is retried after 2 s, doubling
 * to 10 s, while the pane stays; a pane that goes away closes its connection.
 */
export class RtcViewer {
  private readonly watches = new Set<Watch>();
  private readonly peers = new Map<string, Watch>();
  /** Peers given up before their offer arrived; a late offer gets a `close`. */
  private readonly abandoned: string[] = [];

  constructor(private readonly deps: { send: (message: RtcOut) => void; createPeer?: () => PeerLike; random?: () => string }) {}

  /** Whether this browser can play WebRTC video at all. */
  get supported(): boolean { return !!this.deps.createPeer || typeof globalThis.RTCPeerConnection === 'function'; }

  /** Starts watching `stream` from its publisher; returns the function that stops. */
  watch(stream: string, publisher: string, listener: (state: VideoState) => void): () => void {
    const watch: Watch = { stream, publisher, listener, backoff: RTC_RETRY_MS };
    this.watches.add(watch); this.start(watch);
    return () => {
      if (!this.watches.delete(watch)) return;
      if (watch.retry) clearTimeout(watch.retry);
      this.stop(watch, true);
    };
  }

  /** The gateway went away: drop every connection quietly (the gateway tells each robot itself) and forget the panes. */
  reset() {
    for (const watch of this.watches) { if (watch.retry) clearTimeout(watch.retry); this.stop(watch, false); }
    this.watches.clear(); this.peers.clear(); this.abandoned.length = 0;
  }

  /** How many requests are open, for tests and diagnostics. */
  get open(): number { return this.peers.size; }

  /** An `rtc` message from the gateway. */
  receive(message: RtcMessage) {
    if (typeof message.peer !== 'string') return;
    const watch = this.peers.get(message.peer); const attempt = watch?.attempt;
    if (!watch || !attempt || attempt.peer !== message.peer) {
      if (message.kind === 'offer' && message.from && this.abandoned.includes(message.peer)) this.deps.send({ kind: 'close', to: message.from, peer: message.peer });
      return;
    }
    if (message.kind === 'offer' && typeof message.sdp === 'string') void this.answer(watch, attempt, message.sdp, message.from);
    else if (message.kind === 'candidate' && message.candidate) {
      if (attempt.pc?.remoteDescription) attempt.pc.addIceCandidate(message.candidate).catch(() => {});
      else attempt.candidates.push(message.candidate);
    } else if (message.kind === 'error' || message.kind === 'close') this.fail(watch, message.message ?? (message.kind === 'close' ? 'the robot closed the video' : 'error'), message.kind === 'close');
  }

  private start(watch: Watch) {
    const name = watch.stream.replace(/[^\w.-]/g, '').slice(0, 40) || 'cam';
    const attempt: Attempt = { peer: `${name}-${(this.deps.random ?? randomId)()}`, candidates: [], closed: false };
    watch.attempt = attempt; this.peers.set(attempt.peer, watch);
    watch.listener({ status: 'connecting' });
    this.deps.send({ kind: 'request', stream: watch.stream, peer: attempt.peer });
    attempt.offerTimer = setTimeout(() => { if (watch.attempt === attempt) this.fail(watch, 'the robot sent no video offer'); }, RTC_OFFER_WAIT_MS);
  }

  /** Ends the current attempt: tells the robot (`tell`, once it is known), or remembers the peer so a late offer is turned down. */
  private stop(watch: Watch, tell: boolean) {
    const attempt = watch.attempt; if (!attempt) return;
    watch.attempt = undefined; this.peers.delete(attempt.peer); clearTimeout(attempt.offerTimer); attempt.closed = true;
    if (attempt.to) { if (tell) this.deps.send({ kind: 'close', to: attempt.to, peer: attempt.peer }); }
    else { this.abandoned.push(attempt.peer); if (this.abandoned.length > 32) this.abandoned.shift(); }
    if (attempt.pc) { try { attempt.pc.close(); } catch { /* already closed */ } }
  }

  /** The attempt failed, was refused or closed: show it, and ask again after the backoff while the pane stays. */
  private fail(watch: Watch, why: string, closedByRobot = false) {
    if (!watch.attempt) return;
    this.stop(watch, !closedByRobot);
    watch.listener({ status: 'failed', why });
    if (watch.retry) clearTimeout(watch.retry);
    const delay = watch.backoff; watch.backoff = Math.min(watch.backoff * 2, RTC_RETRY_MAX_MS);
    watch.retry = setTimeout(() => { watch.retry = undefined; if (this.watches.has(watch)) this.start(watch); }, delay);
  }

  private async answer(watch: Watch, attempt: Attempt, sdp: string, from: string | undefined) {
    if (attempt.pc || !from) return;
    clearTimeout(attempt.offerTimer); attempt.to = from;
    let pc: PeerLike;
    try { pc = attempt.pc = this.deps.createPeer?.() ?? new RTCPeerConnection({ iceServers: [] }); }
    catch (error) { this.fail(watch, errorText(error)); return; }
    pc.addEventListener('track', event => {
      if (watch.attempt !== attempt) return;
      const { streams, track } = event as RTCTrackEvent;
      const media = streams?.[0] ?? (typeof MediaStream === 'function' ? new MediaStream([track]) : undefined);
      if (media) { watch.backoff = RTC_RETRY_MS; watch.listener({ status: 'video', media }); }
    });
    pc.addEventListener('connectionstatechange', () => {
      if (watch.attempt !== attempt || attempt.closed) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.fail(watch, `the video connection ${pc.connectionState}`);
    });
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      for (const candidate of attempt.candidates.splice(0)) pc.addIceCandidate(candidate).catch(() => {});
      await pc.setLocalDescription(await pc.createAnswer());
      await iceGathered(pc);
      if (watch.attempt !== attempt) return;
      this.deps.send({ kind: 'answer', to: from, peer: attempt.peer, sdp: pc.localDescription?.sdp ?? '' });
    } catch (error) { if (watch.attempt === attempt) this.fail(watch, errorText(error)); }
  }
}

const randomId = () => Math.random().toString(36).slice(2, 10);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Resolves once ICE gathering is complete, or after 2 s with what there is. */
function iceGathered(pc: PeerLike): Promise<void> {
  return new Promise(done => {
    if (pc.iceGatheringState === 'complete') { done(); return; }
    const finish = () => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); done(); };
    const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const timer = setTimeout(finish, RTC_ICE_WAIT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}
