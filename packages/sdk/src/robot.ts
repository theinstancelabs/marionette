import { PROTOCOL_VERSION, ROBOT_ID_PATTERN, isJsonObject, utf8Length, validateScreen, MAX_ROBOT_STATE_BYTES, MAX_STATUS_VALUES_BYTES, type JsonValue } from '@marionette/protocol';
import { GatewayClient, type GatewayClientEvents, type GatewayClientOptions, type GatewayMessage } from './client.js';
import { monotonic, wallClock } from './clock.js';
import { Emitter } from './emitter.js';
import { PhoneTracker, type TrackerOptions } from './tracker.js';

export type RobotLinkOptions = Omit<GatewayClientOptions, 'role' | 'follow'> & {
  /** The robot's stable id: lower-case letters, digits and dashes. */
  robotId: string;
  /** How often state is re-sent when nothing changes (ms, default 200); screens call the robot unresponsive after max(1500, 3 × everyMs). */
  everyMs?: number;
  /** A tracker to feed from this link: an existing one, `true` for a new one, or the options for a new one. */
  tracker?: PhoneTracker | boolean | TrackerOptions;
};
/** The gateway's answer to a screen: shown (`accepted`), or refused with the reason; `warnings` name what its config block dropped. */
export type ScreenResult = { accepted: boolean; message: string; warnings: string[] };
export type RobotLinkEvents = GatewayClientEvents & { screen: [result: ScreenResult] };
export type NoticeOptions = { phoneId?: string; values?: Record<string, JsonValue> };
export const NOTICE_CONTROL_ID = 'robot.notice';

/** Base64 without Node's Buffer, for browsers. */
function base64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(data: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * A robot's connection to the gateway: a `GatewayClient` with role `robot` that keeps what the robot says.
 *
 * - `setScreen(html)` shows the robot's own phone screen, again on every reconnect; it resolves with the gateway's
 *   answer (`accepted` or refused, with the reason). In Node, `watchScreen()` from `@marionette/sdk/node` re-sends a
 *   file on every save.
 * - `state(obj, phoneId?)` is retained: sent at once when it changes, re-sent every `everyMs`, and again on reconnect.
 * - `notice(message)` is a one-off `status` (`controlId: 'robot.notice'`), never coalesced.
 * - `sendJpeg(stream, bytes)` sends a camera frame; a newer frame of the stream replaces one still waiting.
 * - With `tracker`, a `PhoneTracker` follows the phones from the same connection (`link.tracker`).
 *
 * WebRTC video isn't published from TypeScript: send JPEG frames, or use the Python SDK's `VideoPublisher`.
 */
export class RobotLink extends Emitter<RobotLinkEvents> {
  readonly client: GatewayClient;
  readonly robotId: string;
  readonly everyMs: number;
  readonly tracker?: PhoneTracker;
  private screen?: { html: string; title?: string };
  private waiting: ((result: ScreenResult) => void)[] = [];
  private inFlight = 0;
  private readonly states = new Map<string, { message: string; state: Record<string, JsonValue>; sentAt: number }>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(address: string, options: RobotLinkOptions) {
    super();
    if (!ROBOT_ID_PATTERN.test(options.robotId ?? '')) throw new Error(`robotId must be lower-case letters, digits and dashes (got ${JSON.stringify(options.robotId)})`);
    this.robotId = options.robotId; this.everyMs = options.everyMs ?? 200;
    if (!(this.everyMs >= 10 && this.everyMs <= 60_000)) throw new Error('everyMs must be 10 to 60000');
    const { tracker, everyMs: _everyMs, ...clientOptions } = options;
    this.client = new GatewayClient(address, { ...clientOptions, role: 'robot' });
    if (tracker) { this.tracker = tracker instanceof PhoneTracker ? tracker : new PhoneTracker(tracker === true ? {} : tracker); this.tracker.attach(this.client); }
    this.client.on('connect', () => { this.inFlight = 0; this.sendScreen(); for (const phoneId of this.states.keys()) this.sendState(phoneId); this.emit('connect'); });
    this.client.on('lost', () => { this.inFlight = 0; this.emit('lost'); });
    this.client.on('error', (message, code) => this.emit('error', message, code));
    this.client.on('message', message => { this.answer(message); this.emit('message', message); });
    this.timer = setInterval(() => this.tick(), Math.max(10, Math.min(50, this.everyMs / 4)));
  }

  get connected(): boolean { return this.client.connected; }
  get error(): string | undefined { return this.client.error; }

  /** Shows `html` as every phone's screen, now and after every reconnect. Resolves with the gateway's answer. */
  setScreen(html: string, title?: string): Promise<ScreenResult> {
    const message = { type: 'screen', version: PROTOCOL_VERSION, html, ...(title ? { title } : {}) };
    if (!validateScreen(message)) return Promise.resolve({ accepted: false, message: 'Screen refused: it needs html (at most 512 KB) and a title of at most 128 characters', warnings: [] });
    this.screen = { html, ...(title ? { title } : {}) };
    const result = new Promise<ScreenResult>(resolve => this.waiting.push(resolve));
    this.sendScreen();
    return result;
  }

  /**
   * The robot's state for every phone (or for one, with `phoneId`), as any JSON object up to 64 KB. Sent at once when
   * it changes, re-sent every `everyMs` while unchanged, and again on reconnect. `null` stops re-sending it (the
   * gateway keeps the last one it got).
   */
  state(state: Record<string, JsonValue> | null, phoneId?: string): void {
    const key = phoneId ?? '';
    if (state === null) { this.states.delete(key); return; }
    if (!isJsonObject(state) || utf8Length(JSON.stringify(state)) > MAX_ROBOT_STATE_BYTES) throw new TypeError('Robot state must be a JSON object of at most 64 KB');
    const message = JSON.stringify(state); const previous = this.states.get(key);
    if (previous?.message === message) return;
    this.states.set(key, { message, state: JSON.parse(message), sentAt: previous?.sentAt ?? -Infinity });
    this.sendState(key);
  }

  /** A one-off notice for the phone screens (one phone with `phoneId`). False if not connected. */
  notice(message: string, options: NoticeOptions = {}): boolean {
    if (options.values !== undefined && (!isJsonObject(options.values) || utf8Length(JSON.stringify(options.values)) > MAX_STATUS_VALUES_BYTES)) throw new TypeError('Notice values must be a JSON object of at most 16 KB');
    return this.client.send({ type: 'status', version: PROTOCOL_VERSION, sessionId: this.client.sessionId, controlId: NOTICE_CONTROL_ID, message,
      ...(options.values ? { values: options.values } : {}), ...(options.phoneId ? { phoneId: options.phoneId } : {}) });
  }

  /** A JPEG frame for a stream the screen declares. `capturedAt` is wall-clock ms. False if not connected. */
  sendJpeg(stream: string, jpeg: Uint8Array | ArrayBuffer, capturedAt = Date.now()): boolean {
    if (!this.client.connected) return false;
    const bytes = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg);
    return this.client.send({ type: 'camera_frame', version: PROTOCOL_VERSION, sessionId: this.client.sessionId, cameraId: stream, dataUrl: `data:image/jpeg;base64,${base64(bytes)}`, capturedAt });
  }

  /** Any other message (signaling, a raw status), through the client's outbox. */
  send(message: object, options?: { key?: string }): boolean { return this.client.send(message, options); }

  close(): void { clearInterval(this.timer); this.client.close(); for (const resolve of this.waiting.splice(0)) resolve({ accepted: false, message: 'The robot link closed', warnings: [] }); }

  private sendScreen(): void {
    if (!this.screen) return;
    if (this.client.send({ type: 'screen', version: PROTOCOL_VERSION, ...this.screen })) this.inFlight++;
  }
  private sendState(key: string): void {
    const entry = this.states.get(key); if (!entry) return;
    if (this.client.send({ type: 'robot_state', version: PROTOCOL_VERSION, ...(key ? { phoneId: key } : {}), state: entry.state, everyMs: this.everyMs, sentAt: wallClock() })) entry.sentAt = monotonic();
  }
  private tick(): void {
    if (!this.client.connected) return;
    const now = monotonic();
    for (const [key, entry] of this.states) if (now - entry.sentAt >= this.everyMs) this.sendState(key);
  }
  /** The gateway answers each screen with a `status` (`controlId: 'screen'`); the waiting calls get the answer to the latest. */
  private answer(message: GatewayMessage): void {
    if (message.type !== 'status' || message.controlId !== 'screen' || message.phoneId) return;
    const values = (message.values ?? {}) as Record<string, unknown>;
    const result: ScreenResult = { accepted: values.accepted === true, message: message.message, warnings: Array.isArray(values.warnings) ? values.warnings.filter((w): w is string => typeof w === 'string') : [] };
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.emit('screen', result);
    if (this.inFlight === 0) for (const resolve of this.waiting.splice(0)) resolve(result);
  }
}
