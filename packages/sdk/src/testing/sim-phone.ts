import WebSocket from 'ws';
import { PROTOCOL_VERSION, STICK_REST, STREAM_RENEW_MS, multiplyQuaternions, nominalCovariance, normalizeQuaternion, operatorPose, phoneAxes, rawPoseFor, validatePing,
  type CalibrationState, type ConfigMessage, type ControlValue, type PosePacket, type PoseReference, type PoseSource, type Quaternion, type TrackingState, type UiControl, type Vector3 } from '@marionette/protocol';
import { wallClock } from '../clock.js';

export type SimPhoneOptions = {
  /** The app's device id, which keeps the phone's id across reconnects (default: a random one). */
  deviceId?: string;
  /** The ARKit session (default: a random one). */
  session?: string;
  /** The gateway's pairing code. */
  token?: string;
  /** Poses per second (default 60); 0 sends none unless `sendPose()` is called. */
  poseHz?: number;
  tracking?: TrackingState;
  source?: PoseSource;
  /** This phone's wall clock minus the real one (ms), to exercise the gateway's clock offset. */
  clockOffsetMs?: number;
  /** Where the phone's top edge points at the start, in degrees left of ARKit's initial heading (default 0). */
  yawDeg?: number;
  /** Act as a desktop mirror of this phone (`''`: the first connected one) instead of being a phone: no poses. */
  mirrorOf?: string;
};
/** Where the phone is held, relative to where its session started and along its heading then: metres, and radians. */
export type Placement = { forward?: number; right?: number; up?: number; roll?: number; yaw?: number };
export type ActOptions = { controlId?: string; renew?: true; live?: true };
export type Reply = { accepted: boolean; message: string };
type Raw = { position: Vector3; rotation: Quaternion };

const HOLD_RENEW_MS = 200;
/** Kept messages (a long-running tool must not grow without bound). */
const MAX_MESSAGES = 5000;
const UP: Vector3 = { x: 0, y: 1, z: 0 };
const random = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const plus = (a: Vector3, b: Vector3, s = 1): Vector3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
const axisAngle = (axis: Vector3, angle: number): Quaternion => { const n = Math.hypot(axis.x, axis.y, axis.z) || 1, s = Math.sin(angle / 2) / n; return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) }; };
/** The phone's heading in ARKit's world: forward along its top edge (level), right, and up. */
function heading(rotation: Quaternion) {
  const { top } = phoneAxes(rotation, 'camera'); const level = Math.hypot(top.x, top.z);
  const forward = level > 1e-6 ? { x: top.x / level, y: 0, z: top.z / level } : { x: 0, y: 0, z: -1 };
  return { forward, right: { x: -forward.z, y: 0, z: forward.x }, up: UP };
}

/**
 * A scriptable phone for tests and tools, talking to a gateway the way the app does: a hello with its device id and
 * session, raw ARKit poses (converted from operator-frame targets, or placed physically), presses with 200 ms
 * renewals, drags with 50 ms renewals, guided calibration and quick origin, tracking states, and reconnects in the
 * same session or a new one. It answers the gateway's pings. With `mirrorOf` it is a desktop mirror instead.
 */
export class SimPhone {
  readonly url: string;
  readonly deviceId: string;
  readonly mirrorOf?: string;
  session: string;
  tracking: TrackingState;
  source: PoseSource;
  clockOffsetMs: number;
  /** The phone id the gateway gave it (the followed phone's for a mirror). */
  id?: string;
  /** Its latest config (its own view: values, holds, calibration). */
  config?: ConfigMessage;
  /** The messages received (the latest 5000), except camera frames, which are counted in `frames`. */
  readonly messages: any[] = [];
  readonly frames = new Map<string, number>();
  closeCode?: number;
  private ws?: WebSocket;
  private seq = 0;
  private lastTs = 0;
  private home: Raw;
  private raw: Raw;
  private placement: Placement = {};
  private poseTimer?: ReturnType<typeof setInterval>;
  private renewTimer?: ReturnType<typeof setInterval>;
  private lastHoldRenew = 0;
  private paused = false;
  private readonly held = new Map<string, { controlId: string; value: ControlValue }>();
  private readonly dragging = new Map<string, { controlId: string; value: ControlValue; at: number }>();
  private readonly watchers = new Set<() => void>();
  private readonly options: SimPhoneOptions;

  constructor(url: string, options: SimPhoneOptions = {}) {
    this.url = url; this.options = options; this.deviceId = options.deviceId ?? `sim-${random()}`; this.mirrorOf = options.mirrorOf;
    this.session = options.session ?? `iphone-sim-${random()}`; this.tracking = options.tracking ?? 'normal'; this.source = options.source ?? 'arkit'; this.clockOffsetMs = options.clockOffsetMs ?? 0;
    this.home = this.raw = this.start();
  }
  /** Creates a phone and connects it. */
  static async connect(url: string, options: SimPhoneOptions = {}): Promise<SimPhone> { return new SimPhone(url, options).connect(); }

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN && !!this.id; }
  get calibration(): CalibrationState | undefined { return this.config?.calibration; }

  /* ---------- Connection ---------- */
  /** Opens the socket, says hello and waits for its own config. */
  async connect(timeoutMs = 3000): Promise<this> {
    if (this.ws) return this;
    const ws = new WebSocket(this.url); this.ws = ws; this.config = undefined;
    ws.on('message', data => this.receive(String(data)));
    ws.on('close', code => { this.closeCode = code; if (this.ws === ws) { this.ws = undefined; this.stopTimers(); } this.wake(); });
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    ws.on('error', () => { /* a reset socket reports here before closing */ });
    const token = this.options.token ? { token: this.options.token } : {};
    this.send(this.mirrorOf !== undefined ? { type: 'hello', version: PROTOCOL_VERSION, role: 'console', follow: this.mirrorOf, ...token }
      : { type: 'hello', version: PROTOCOL_VERSION, role: 'phone', deviceId: this.deviceId, sessionId: this.session, ...token });
    try { await this.waitFor(() => this.config?.phone, timeoutMs); }
    catch { throw new Error(this.closeCode ? `The gateway closed the connection (${this.closeCode})` : this.mirrorOf !== undefined ? `No phone ${this.mirrorOf || ''} to mirror` : 'No config from the gateway'); }
    if (this.mirrorOf === undefined) {
      const hz = this.options.poseHz ?? 60;
      this.sendPose();
      if (hz > 0) this.poseTimer = setInterval(() => this.sendPose(), 1000 / hz);
    }
    this.renewTimer = setInterval(() => this.renew(), STREAM_RENEW_MS / 2);
    return this;
  }
  /** Closes the connection, like the app leaving; holds and drags are forgotten (the gateway ends them). */
  async disconnect(): Promise<void> {
    const ws = this.ws; this.stopTimers(); this.held.clear(); this.dragging.clear();
    if (!ws) return;
    const closed = new Promise<void>(resolve => ws.once('close', () => resolve()));
    ws.close(1000, 'Phone left'); await closed;
  }
  /** Connects again: in the same ARKit session (calibration kept), or a new one (a new world, starting over). */
  async reconnect(options: { newSession?: boolean } = {}): Promise<this> {
    await this.disconnect();
    if (options.newSession) { this.session = `iphone-sim-${random()}`; this.seq = 0; this.home = this.raw = this.start(); this.placement = {}; }
    return this.connect();
  }
  close(): void { this.stopTimers(); this.ws?.close(1000, 'Phone left'); }

  /* ---------- Poses ---------- */
  /** The pose consumers see now, in this phone's operator frame. */
  operator(): Raw { return operatorPose(this.packet(this.raw), this.reference()); }
  /** Puts the phone where consumers will see `position` (and `rotation`, else the current one) in its operator frame. */
  moveTo(position: Vector3, rotation?: Quaternion): void {
    this.raw = rawPoseFor({ position, rotation: rotation ?? this.operator().rotation }, this.reference()); this.placement = {};
  }
  /** Holds the phone at a placement relative to where its session started (unset fields keep their value). */
  place(placement: Placement): void { this.placement = { ...this.placement, ...placement }; this.raw = this.placed(this.placement); }
  /** Moves smoothly to a placement over `ms`. */
  async glide(placement: Placement, ms = 200): Promise<void> { const next = { ...this.placement, ...placement }; await this.glideRaw(this.placed(next), ms); this.placement = next; }
  /** Moves smoothly to an operator-frame target over `ms`. */
  async glideTo(position: Vector3, rotation?: Quaternion, ms = 200): Promise<void> {
    await this.glideRaw(rawPoseFor({ position, rotation: rotation ?? this.operator().rotation }, this.reference()), ms); this.placement = {};
  }
  setTracking(tracking: TrackingState): void { this.tracking = tracking; }
  /** Sends one pose now (the stream does this `poseHz` times a second). */
  sendPose(): void { if (this.mirrorOf === undefined) this.send(this.packet(this.raw)); }

  /* ---------- Controls ---------- */
  /** One action, as the screen sends it. `controlId` defaults to the control declaring the action. */
  act(action: string, value?: ControlValue, options: ActOptions = {}): void {
    this.send({ type: 'action', version: PROTOCOL_VERSION, sessionId: this.mirrorOf !== undefined ? 'mirror' : this.session, controlId: this.controlId(action, options.controlId), action,
      ...(value !== undefined ? { value } : {}), ...(options.renew ? { renew: true } : {}), ...(options.live ? { live: true } : {}),
      // A mirror names the phone it means, so the gateway drops a press still in flight when it moves to another phone.
      ...(this.mirrorOf !== undefined && this.id ? { phoneId: this.id } : {}), sentAt: this.now() });
  }
  /** A plain button press. */
  tap(action: string, options: { controlId?: string } = {}): void { this.act(action, undefined, options); }
  /** Sets a toggle, a select or a slider (a final value, not a drag). */
  set(action: string, value: ControlValue, options: { controlId?: string } = {}): void { this.act(action, value, options); }
  /** Presses a hold (`true`, or `value`) and renews it every 200 ms until `release`. */
  press(action: string, options: { controlId?: string; value?: ControlValue } = {}): void {
    const controlId = this.controlId(action, options.controlId); const value = options.value ?? true;
    this.act(action, value, { controlId }); this.held.set(action, { controlId, value });
  }
  release(action: string, options: { value?: ControlValue } = {}): void {
    const held = this.held.get(action); this.held.delete(action);
    this.act(action, options.value ?? false, { controlId: held?.controlId });
  }
  /** Presses, holds for `ms` with renewals, and releases. */
  async hold(action: string, ms: number, options: { controlId?: string; value?: ControlValue } = {}): Promise<void> { this.press(action, options); await sleep(ms); this.release(action); }
  /** A live sample of a slider or stick being dragged; the latest is repeated every 50 ms while the finger rests. */
  drag(action: string, value: ControlValue, options: { controlId?: string } = {}): void {
    const controlId = this.dragging.get(action)?.controlId ?? this.controlId(action, options.controlId);
    this.act(action, value, { controlId, live: true }); this.dragging.set(action, { controlId, value, at: Date.now() });
  }
  /** Pushes a stick (`{ x: forward, y: left }`). */
  stick(action: string, value: { x: number; y: number }, options: { controlId?: string } = {}): void { this.drag(action, value, options); }
  /** Lets go of a drag: the final value (a stick returns to rest; a slider keeps its last value unless given one). */
  letGo(action: string, value?: ControlValue, options: { controlId?: string } = {}): void {
    const drag = this.dragging.get(action); this.dragging.delete(action);
    const control = this.control(action);
    const final = value ?? (control?.type === 'joystick' ? { ...STICK_REST } : drag?.value ?? (control && 'value' in control ? control.value : undefined));
    this.act(action, final, { controlId: drag?.controlId ?? options.controlId });
  }
  /** Stops (or resumes) the 200 ms hold and 50 ms drag renewals, so the gateway ends them as if the link froze. */
  pauseRenewals(paused = true): void { this.paused = paused; }

  /** Sends an action and waits for the gateway's reply to it (`status` for this control). */
  async request(action: string, value?: ControlValue, options: { controlId?: string; timeoutMs?: number } = {}): Promise<Reply> {
    const controlId = this.controlId(action, options.controlId); let reply: any;
    const done = this.collect(message => message.type === 'status' && message.controlId === controlId && (!message.phoneId || message.phoneId === this.id), message => { reply = message; });
    this.sendPose(); this.act(action, value, { controlId });
    try { await this.waitFor(() => reply, options.timeoutMs ?? 3000); } finally { done(); }
    return { accepted: reply.values?.accepted === true, message: reply.message };
  }

  /* ---------- Calibration ---------- */
  /**
   * Guided calibration through the gateway, the way an operator does it: from where the phone is (it should be
   * roughly flat), capture flat, move 12 cm forward along its heading and capture, back and 11 cm right, back and
   * 15 cm up, then back to the flat spot. Throws with the gateway's reason if a step is refused.
   */
  async calibrate(options: { moveMs?: number } = {}): Promise<void> {
    const ms = options.moveMs ?? 150; const base = this.raw; const { forward, right, up } = heading(base.rotation);
    const at = (direction: Vector3, metres: number): Raw => ({ position: plus(base.position, direction, metres), rotation: base.rotation });
    await this.must('calibration.start');
    await this.must('calibration.capture', 'flat');
    await this.glideRaw(at(forward, 0.12), ms); await this.must('calibration.capture', 'forward');
    await this.glideRaw(base, ms); await this.glideRaw(at(right, 0.11), ms); await this.must('calibration.capture', 'right');
    await this.glideRaw(base, ms); await this.glideRaw(at(up, 0.15), ms); await this.must('calibration.capture', 'up');
    await this.waitFor(() => this.config?.calibration.status === 'captured' && this.config.calibration.reference?.mode === 'guided', 2000);
    await this.glideRaw(base, ms);
  }
  /** The optional validation: forward, right and up 10 cm from the flat spot. Resolves with whether it passed. */
  async validate(options: { moveMs?: number } = {}): Promise<boolean> {
    const ms = options.moveMs ?? 150; const base = this.raw; const { forward, right, up } = heading(base.rotation);
    await this.must('calibration.check');
    for (const [move, direction] of [['forward', forward], ['right', right], ['up', up]] as const) {
      await this.glideRaw({ position: plus(base.position, direction, 0.1), rotation: base.rotation }, ms); await this.must('calibration.check', move); await this.glideRaw(base, ms);
    }
    await this.waitFor(() => this.config?.calibration.check?.passed !== undefined, 2000);
    return this.config!.calibration.check!.passed!;
  }
  /** Quick origin: zero here, forward along the phone's heading. */
  async quickOrigin(): Promise<void> {
    const epoch = this.config?.calibration.epoch ?? 0;
    await this.must('calibration.captureOrigin');
    await this.waitFor(() => this.config?.calibration.status === 'captured' && this.config.calibration.epoch > epoch, 2000);
  }

  /* ---------- What it received ---------- */
  statuses(controlId?: string): any[] { return this.messages.filter(m => m.type === 'status' && (controlId === undefined || m.controlId === controlId)); }
  robotStates(): any[] { return this.messages.filter(m => m.type === 'robot_state'); }
  /** Resolves with the first truthy value of `check`, re-run on every message (and every 20 ms), or rejects after `timeoutMs`. */
  waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 2000): Promise<T> {
    return new Promise((resolve, reject) => {
      const done = (ok: boolean, value?: T) => { clearTimeout(timer); clearInterval(poll); this.watchers.delete(test); ok ? resolve(value!) : reject(new Error(`SimPhone: timed out after ${timeoutMs} ms`)); };
      const test = () => { const value = check(); if (value) done(true, value); };
      const timer = setTimeout(() => done(false), timeoutMs); const poll = setInterval(test, 20);
      this.watchers.add(test); test();
    });
  }

  /* ---------- Internals ---------- */
  private start(): Raw {
    const yaw = (this.options.yawDeg ?? 0) * Math.PI / 180;
    return rawPoseFor({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) } });
  }
  private placed(p: Placement): Raw {
    const { forward, right, up } = heading(this.home.rotation); const top = phoneAxes(this.home.rotation, 'camera').top;
    const rotation = multiplyQuaternions(axisAngle(UP, p.yaw ?? 0), multiplyQuaternions(axisAngle(top, p.roll ?? 0), this.home.rotation));
    return { position: plus(plus(plus(this.home.position, forward, p.forward ?? 0), right, p.right ?? 0), up, p.up ?? 0), rotation };
  }
  private async glideRaw(to: Raw, ms: number): Promise<void> {
    const from = this.raw; const steps = Math.max(1, Math.round(ms / 16));
    const sign = from.rotation.x * to.rotation.x + from.rotation.y * to.rotation.y + from.rotation.z * to.rotation.z + from.rotation.w * to.rotation.w < 0 ? -1 : 1;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps; const mix = (a: number, b: number) => a + (b - a) * t;
      this.raw = { position: { x: mix(from.position.x, to.position.x), y: mix(from.position.y, to.position.y), z: mix(from.position.z, to.position.z) },
        rotation: normalizeQuaternion({ x: mix(from.rotation.x, sign * to.rotation.x), y: mix(from.rotation.y, sign * to.rotation.y), z: mix(from.rotation.z, sign * to.rotation.z), w: mix(from.rotation.w, sign * to.rotation.w) }) };
      if (i < steps) await sleep(16);
    }
    // The gateway has the final pose by the time a glide resolves.
    this.raw = to; this.sendPose();
  }
  private reference(): PoseReference | undefined { const reference = this.config?.calibration.reference; return reference && reference.sessionId === this.session ? reference : undefined; }
  private now(): number { return wallClock() + this.clockOffsetMs; }
  private packet(raw: Raw): PosePacket {
    this.lastTs = Math.max(performance.now() / 1000, this.lastTs + 1e-6);
    return { type: 'pose', version: PROTOCOL_VERSION, sessionId: this.session, seq: this.seq++, monotonicTs: this.lastTs, position: { ...raw.position }, rotation: { ...raw.rotation },
      covariance: nominalCovariance(this.tracking), source: this.source, trackingState: this.tracking, calibrationVersion: 'arkit-v1', heartbeat: true, sentAt: this.now() };
  }
  private control(action: string): UiControl | undefined { return this.config?.controls.find(control => control.action === action); }
  private controlId(action: string, given?: string): string { return given ?? this.control(action)?.id ?? action; }
  private async must(action: string, value?: ControlValue): Promise<Reply> {
    const reply = await this.request(action, value);
    if (!reply.accepted) throw new Error(`${action}${value !== undefined ? ` ${String(value)}` : ''} refused: ${reply.message}`);
    return reply;
  }
  private collect(match: (message: any) => boolean, take: (message: any) => void): () => void {
    const test = () => { const last = this.messages.at(-1); if (last && match(last)) take(last); };
    this.watchers.add(test); return () => this.watchers.delete(test);
  }
  private renew(): void {
    if (this.paused) return;
    const now = Date.now();
    if (now - this.lastHoldRenew >= HOLD_RENEW_MS) { this.lastHoldRenew = now; for (const [action, held] of this.held) this.act(action, held.value, { controlId: held.controlId, renew: true }); }
    for (const [action, drag] of this.dragging) if (now - drag.at >= STREAM_RENEW_MS) { drag.at = now; this.act(action, drag.value, { controlId: drag.controlId, live: true, renew: true }); }
  }
  private receive(text: string): void {
    let message: any; try { message = JSON.parse(text); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'camera_frame') { this.frames.set(message.cameraId, (this.frames.get(message.cameraId) ?? 0) + 1); return; }
    if (message.type === 'ping') { if (validatePing(message)) this.send({ type: 'pong', version: PROTOCOL_VERSION, id: message.id, sentAt: message.sentAt, at: this.now() }); return; }
    this.messages.push(message); if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    // A phone only ever gets its own config, a mirror the followed phone's.
    if (message.type === 'config' && message.phone) { this.config = message; this.id = message.phone.id; }
    this.wake();
  }
  private wake(): void { for (const watcher of [...this.watchers]) watcher(); }
  private send(message: object): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message)); }
  private stopTimers(): void { clearInterval(this.poseTimer); clearInterval(this.renewTimer); this.poseTimer = this.renewTimer = undefined; }
}
