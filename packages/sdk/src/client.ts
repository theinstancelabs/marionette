import { CLOSE_CODES, PROTOCOL_VERSION, ROBOT_ID_PATTERN, gatewayUrl, parsePairingLink, validatePing, validatePong, type HelloMessage, type MarionetteMessage } from '@marionette/protocol';
import { ClockSync, monotonic, wallClock } from './clock.js';
import { Emitter } from './emitter.js';

/** The part of the WebSocket API the client uses: the browser's, which the `ws` package implements too. */
export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type WebSocketConstructor = new (url: string) => SocketLike;
/** Any message from the gateway, parsed but not validated: check it before trusting a field (the tracker does). */
export type GatewayMessage = MarionetteMessage;
export type ClientRole = 'console' | 'robot';

export type GatewayClientOptions = {
  /** `console` (default) only listens and may send notices; `robot` also sends its screen, state and frames. */
  role?: ClientRole;
  /** The gateway's pairing code, needed off its computer. A pairing link given as the address brings its own. */
  token?: string;
  /** A robot's stable id (lower-case letters, digits and dashes) and display name. */
  robotId?: string; name?: string;
  /** Whether to receive camera frames (the gateway's default: consoles do, robots don't). */
  cameras?: boolean;
  /** Follow one phone like the desktop mirror (`''`: the first connected one). */
  follow?: string;
  /** `sessionId` on the status and camera messages this client sends (default: the robot id, or `console`). */
  sessionId?: string;
  /** The WebSocket class. Default: the `ws` package in Node, the global `WebSocket` in browsers. */
  WebSocket?: WebSocketConstructor;
  /** How often to ping the gateway (ms, default 1000). */
  pingMs?: number;
  /** A connection that hears nothing for this long (ms, default 3500) is dropped and retried. */
  deadAfterMs?: number;
  /** Reconnect backoff (ms): from 500, doubling to 5000. */
  minBackoffMs?: number; maxBackoffMs?: number;
  /** Frames wait while more than this many bytes (default 1 MB) are still unsent. */
  maxBufferedBytes?: number;
};
export type GatewayClientEvents = {
  /** Every message from the gateway except pings and pongs, which the client answers and measures itself. */
  message: [message: GatewayMessage];
  /** The gateway accepted the hello (its first `config` arrived). */
  connect: [];
  /** A connection that was up went away: treat it as every phone letting go. */
  lost: [];
  /** Why the client isn't connected, when that changes (pairing refused, robot id in use, unreachable). */
  error: [message: string, code: number | undefined];
};
export type SendOptions = {
  /**
   * Messages with the same key replace each other while they wait (newest only). By default robot state is keyed
   * per phone and camera frames per stream; everything else, notices included, is never coalesced.
   */
  key?: string;
};

/** Gateway WebSocket URLs for an address (one per host of a pairing link), and the pairing code a link carries. */
export function resolveAddress(address: string): { urls: string[]; token?: string } {
  const link = parsePairingLink(address);
  if (link) {
    const urls = link.hosts.map(host => gatewayUrl(`${host}:${link.port}`)).filter((url): url is string => !!url);
    if (urls.length) return { urls, ...(link.code ? { token: link.code } : {}) };
  }
  const url = gatewayUrl(address);
  if (!url) throw new Error(`"${address}" is not a gateway address: give an IP such as 192.168.1.20, host:port, a ws:// URL or a marionette:// pairing link`);
  return { urls: [url] };
}

let nodeWs: Promise<WebSocketConstructor | undefined> | undefined;
async function webSocketClass(given?: WebSocketConstructor): Promise<WebSocketConstructor> {
  if (given) return given;
  if ((globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node) {
    // Not a literal, so browser bundlers leave it alone.
    const specifier = 'ws';
    nodeWs ??= import(/* @vite-ignore */ specifier).then(module => (module.WebSocket ?? module.default) as WebSocketConstructor, () => undefined);
    const Socket = await nodeWs; if (Socket) return Socket;
  }
  const Socket = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (Socket) return Socket as WebSocketConstructor;
  throw new Error('No WebSocket implementation: install the ws package, or pass { WebSocket }');
}

const OPEN = 1;
const detach = (socket: SocketLike) => { socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = () => {}; };

/**
 * A reconnecting connection to a Marionette gateway, for Node (`ws`) and browsers. It says hello as a console or a
 * robot, answers the gateway's pings and pings it every second for the clock offset (`offsetMs`) and round trip
 * (`rttMs`), and reconnects with backoff (0.5 s doubling to 5 s) until `close()`, trying each host of a pairing link
 * in turn. A refused pairing code (4401) or a robot id in use (4409) is reported in `error`, and it keeps retrying.
 *
 * Outgoing messages wait in an outbox while the socket is busy: newest only per key (robot state per phone, frames per
 * stream), small messages before camera frames. While disconnected, `send()` drops messages and returns false; send
 * what must survive again on `connect` (`RobotLink` does that for its screen and state).
 */
export class GatewayClient extends Emitter<GatewayClientEvents> implements AsyncIterable<GatewayMessage> {
  readonly urls: readonly string[];
  readonly role: ClientRole;
  readonly token?: string;
  readonly sessionId: string;
  /** Whether the gateway has accepted this client (its config arrived) and the connection is up. */
  connected = false;
  /** Why the client isn't connected, if it knows; cleared on connect. */
  error?: string;
  /** The close code of the last connection that ended. */
  closeCode?: number;
  /** Round trips and the clock offset, from pings. */
  readonly clock = new ClockSync();
  private socket?: SocketLike;
  private stopped = false;
  private hostIndex = 0;
  private delay: number;
  private heardAt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushQueued = false;
  private readonly watchdog: ReturnType<typeof setInterval>;
  private readonly outbox = new Map<string, { data: string; bulk: boolean }>();
  private unique = 0;
  private readonly enders = new Set<() => void>();

  constructor(address: string, private readonly options: GatewayClientOptions = {}) {
    super();
    const resolved = resolveAddress(address);
    this.urls = resolved.urls; this.token = options.token ?? resolved.token; this.role = options.role ?? 'console';
    if (this.role === 'robot' && !(options.robotId && ROBOT_ID_PATTERN.test(options.robotId))) throw new Error(`A robot needs a robotId of lower-case letters, digits and dashes (got ${JSON.stringify(options.robotId)})`);
    this.sessionId = options.sessionId ?? options.robotId ?? 'console';
    this.delay = this.minBackoff;
    this.watchdog = setInterval(() => this.check(), Math.min(250, this.deadAfter / 4));
    void this.open();
  }

  /** The URL in use (or tried next). */
  get url(): string { return this.urls[this.hostIndex]; }
  /** Our clock minus the gateway's (ms), from the fastest of the last 16 pings; undefined until the first pong. */
  get offsetMs(): number | undefined { return this.clock.offsetMs; }
  /** The last round trip to the gateway (ms). */
  get rttMs(): number | undefined { return this.clock.rttMs; }
  /** The gateway's clock now, in wall-clock ms, once the offset is known. */
  gatewayNow(): number | undefined { const offset = this.offsetMs; return offset === undefined ? undefined : wallClock() - offset; }
  private get minBackoff() { return this.options.minBackoffMs ?? 500; }
  private get maxBackoff() { return this.options.maxBackoffMs ?? 5000; }
  private get deadAfter() { return this.options.deadAfterMs ?? 3500; }

  /** Queues a message for the gateway. False (and dropped) while not connected. */
  send(message: object, options: SendOptions = {}): boolean {
    if (!this.connected) return false;
    const m = message as { type?: unknown; phoneId?: unknown; cameraId?: unknown };
    const key = options.key ?? (m.type === 'robot_state' ? `state:${m.phoneId ?? ''}` : m.type === 'camera_frame' ? `frame:${m.cameraId}` : `#${++this.unique}`);
    this.outbox.set(key, { data: JSON.stringify(message), bulk: m.type === 'camera_frame' });
    if (!this.flushQueued && !this.flushTimer) { this.flushQueued = true; queueMicrotask(() => { this.flushQueued = false; this.flush(); }); }
    return true;
  }

  /** Resolves once connected, or rejects with the current error after `timeoutMs`. */
  whenConnected(timeoutMs = 5000): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(this.error ?? `Not connected to ${this.url} after ${timeoutMs} ms`)); }, timeoutMs);
      const off = this.once('connect', () => { clearTimeout(timer); resolve(); });
    });
  }

  /** Every message from now on, until `close()`: `for await (const message of client) …`. */
  messages(): AsyncIterableIterator<GatewayMessage> {
    const queue: GatewayMessage[] = []; let wake: (() => void) | undefined; let done = this.stopped;
    const off = this.on('message', message => { queue.push(message); wake?.(); });
    const end = () => { done = true; off(); this.enders.delete(end); wake?.(); };
    this.enders.add(end);
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        while (!queue.length && !done) await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
        if (queue.length) return { value: queue.shift()!, done: false };
        end(); return { value: undefined, done: true };
      },
      async return() { end(); return { value: undefined, done: true }; },
    };
  }
  [Symbol.asyncIterator](): AsyncIterator<GatewayMessage> { return this.messages(); }

  /** Closes the connection and stops reconnecting. A connection that was up counts as lost. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retryTimer); clearTimeout(this.flushTimer); clearInterval(this.pingTimer); clearInterval(this.watchdog);
    const socket = this.socket; this.socket = undefined;
    if (socket) { detach(socket); try { socket.close(1000, 'Client closed'); } catch { /* already gone */ } }
    const was = this.connected; this.connected = false; this.outbox.clear();
    if (was) this.emit('lost');
    for (const end of [...this.enders]) end();
  }

  private hello(): HelloMessage {
    const o = this.options;
    return { type: 'hello', version: PROTOCOL_VERSION, role: this.role, ...(this.token ? { token: this.token } : {}), ...(this.role === 'robot' ? { robotId: o.robotId } : {}),
      ...(o.name ? { name: o.name } : {}), ...(o.cameras !== undefined ? { cameras: o.cameras } : {}), ...(o.follow !== undefined ? { follow: o.follow } : {}) };
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    let Socket: WebSocketConstructor;
    try { Socket = await webSocketClass(this.options.WebSocket); }
    catch (error) { this.setError((error as Error).message, undefined); this.retry(false); return; }
    if (this.stopped) return;
    let socket: SocketLike;
    try { socket = new Socket(this.url); }
    catch (error) { this.setError(`Can't connect to ${this.url}: ${(error as Error).message}`, undefined); this.retry(false); return; }
    this.socket = socket; this.heardAt = monotonic();
    socket.onopen = () => { if (socket !== this.socket) return; this.heardAt = monotonic(); this.raw(this.hello()); };
    socket.onmessage = event => { if (socket === this.socket) this.receive(event.data); };
    socket.onclose = event => this.closed(socket, event.code, event.reason);
    // Errors are followed by a close; the listener must stay, or ws throws.
    socket.onerror = () => {};
  }

  private receive(data: unknown): void {
    this.heardAt = monotonic();
    if (typeof data !== 'string') return;
    let message: unknown; try { message = JSON.parse(data); } catch { return; }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof (message as { type?: unknown }).type !== 'string') return;
    const m = message as GatewayMessage;
    if (m.type === 'ping') { if (validatePing(m)) this.raw({ type: 'pong', version: PROTOCOL_VERSION, id: m.id, sentAt: m.sentAt, at: wallClock() }); return; }
    if (m.type === 'pong') { if (validatePong(m)) this.clock.pong(m); return; }
    if (m.type === 'config' && !this.connected) this.established();
    this.emit('message', m);
  }

  private established(): void {
    this.connected = true; this.error = undefined; this.closeCode = undefined; this.delay = this.minBackoff; this.clock.reset();
    this.raw(this.clock.ping());
    this.pingTimer = setInterval(() => this.raw(this.clock.ping()), this.options.pingMs ?? 1000);
    this.emit('connect');
  }

  /** Sends now, bypassing the outbox (hello, pings, pongs). */
  private raw(message: object): void {
    const socket = this.socket;
    if (socket?.readyState === OPEN) try { socket.send(JSON.stringify(message)); } catch { /* the close handler deals with it */ }
  }

  private flush(): void {
    this.flushTimer = undefined;
    const socket = this.socket; if (!socket || socket.readyState !== OPEN || !this.connected) return;
    const limit = this.options.maxBufferedBytes ?? 1024 * 1024;
    while (this.outbox.size) {
      let key: string | undefined;
      for (const [candidate, entry] of this.outbox) if (!entry.bulk) { key = candidate; break; }
      key ??= this.outbox.keys().next().value as string;
      // Small messages go even when the socket is backed up; frames wait for it to drain.
      if (this.outbox.get(key)!.bulk && socket.bufferedAmount > limit) { this.flushTimer = setTimeout(() => this.flush(), 10); return; }
      const { data } = this.outbox.get(key)!; this.outbox.delete(key);
      try { socket.send(data); } catch { return; }
    }
  }

  /** Drops a connection that has gone quiet (a half-open socket, a gateway that froze) and tries again. */
  private check(): void {
    const socket = this.socket;
    if (!socket || monotonic() - this.heardAt <= this.deadAfter) return;
    detach(socket);
    try { if (socket.terminate) socket.terminate(); else socket.close(); } catch { /* already gone */ }
    this.closed(socket, 1006, `no answer for ${(this.deadAfter / 1000).toFixed(1)} s`);
  }

  private closed(socket: SocketLike, code: number, reason: string): void {
    if (socket !== this.socket) return;
    detach(socket); this.socket = undefined; clearInterval(this.pingTimer); clearTimeout(this.flushTimer); this.flushTimer = undefined;
    const was = this.connected; this.connected = false; this.outbox.clear(); this.closeCode = code;
    this.setError(this.describe(code, reason, was), code);
    if (was) this.emit('lost');
    this.retry(was);
  }

  private retry(wasConnected: boolean): void {
    if (this.stopped) return;
    // A host that never answered gives way to the next one a pairing link lists.
    if (!wasConnected) this.hostIndex = (this.hostIndex + 1) % this.urls.length;
    const delay = this.delay; this.delay = Math.min(this.delay * 2, this.maxBackoff);
    this.retryTimer = setTimeout(() => void this.open(), delay);
  }

  private describe(code: number, reason: string, was: boolean): string {
    const url = this.url;
    if (code === CLOSE_CODES.pairingRequired) return this.token
      ? `The gateway at ${url} refused the pairing code (${reason || 'wrong pairing code'}). Check the code it printed when it started; retrying.`
      : `The gateway at ${url} needs its pairing code (${reason || 'pairing code required'}). Pass it as token; the gateway prints it when it starts. Retrying.`;
    if (code === CLOSE_CODES.robotIdInUse) return `A robot with id "${this.options.robotId}" is already connected to ${url}. Retrying: this one takes over when the other goes away.`;
    if (code === CLOSE_CODES.replaced) return `Replaced by a newer connection to ${url}`;
    return was ? `Lost the gateway at ${url}${reason ? ` (${reason})` : ''}; reconnecting` : `Can't reach the Marionette gateway at ${url}${reason ? ` (${reason})` : ''}; retrying`;
  }

  private setError(message: string, code: number | undefined): void {
    if (message === this.error) return;
    this.error = message; this.emit('error', message, code);
  }
}
