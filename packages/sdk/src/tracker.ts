import { STICK_REST, isControlValue, isStickInRange, type ControlValue, type PoseSource, type Quaternion, type StickValue, type TrackingState } from '@marionette/protocol';
import { monotonic, wallClock } from './clock.js';
import { matrixFromQuaternion, type Mat3, type Vec3 } from './math.js';
import type { GatewayClient } from './client.js';

/**
 * What a desktop mirror of a phone's screen (the gateway's `/screen`) may do through its input: `allow` treats it like
 * the phone's; `stop-only` (the default) lets it turn Stop on and nothing else, because someone at a desk would
 * otherwise move a robot with a phone nobody may be holding; `deny` ignores it. The policy governs motion, not
 * settings: the gateway applies a mirror's changes to the phone and the phone's screen shows them, so a phone's
 * toggles, selects and sliders follow its config whoever set them. Stop off is the exception: unless it is `allow`, a
 * config never turns Stop off once it is on.
 */
export type MirrorPolicy = 'allow' | 'stop-only' | 'deny';
export type CalibrationStatus = 'uncalibrated' | 'capturing' | 'captured';
export type TrackerOptions = {
  mirror?: MirrorPolicy;
  /** The action whose `true` means Stop (default `safety.estop`). */
  stopAction?: string;
  /** The clock for presses, samples and pose arrivals, in ms (default: monotonic). Pass the same `now` to the accessors. */
  clock?: () => number;
  /** Wall-clock ms, to compare with the gateway's stamps (default: the system clock). */
  wallClock?: () => number;
  /** Our clock minus the gateway's (ms), when known: `client.offsetMs`. `attach()` sets it. */
  offsetMs?: () => number | undefined;
};

/** A hold button: whether it is down, when it was last pressed or renewed, and how many presses it has had. */
export type Hold = { down: boolean; at: number; presses: number };
/**
 * A slider or stick. `live` while it is being dragged; `dropped` once the gateway ended a drag the operator hasn't let
 * go of yet (its samples count again after the let-go); `value` its latest value; `at` the last sample or renewal.
 */
export type Drag = { kind: 'slider' | 'joystick'; live: boolean; dropped: boolean; value?: ControlValue; at: number };

const TRACKING: readonly string[] = ['initializing', 'normal', 'limited', 'relocalizing', 'unavailable'];
const CALIBRATION: readonly string[] = ['uncalibrated', 'capturing', 'captured'];
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const rest = (): StickValue => ({ ...STICK_REST });
/** Control values are primitives or a stick's `{ x, y }`. */
const clone = <T extends ControlValue | undefined>(value: T): T => (isObject(value) ? { ...(value as object) } as T : value);
const cloneValues = (values: Record<string, ControlValue>) => Object.fromEntries(Object.entries(values).map(([action, value]) => [action, clone(value)]));

/**
 * One pose in the phone's operator frame (+X forward, +Y left, +Z up, metres), as the gateway forwarded it.
 * `age(now)` is how old it is at `now` (the tracker's clock): the time it took to reach us, from the gateway's
 * stamps (`latencyMs` to the gateway, `receivedAt` and our clock offset from there), plus the time since it arrived.
 */
export class PhonePose {
  readonly position: Vec3;
  readonly rotation: Mat3;
  constructor(
    position: Vec3, readonly quaternion: Quaternion, readonly tracking: TrackingState, readonly source: PoseSource,
    /** The gateway's `calibrationVersion`: changes with every calibration (`guided-v2:3`). */
    readonly calibration: string,
    /** The phone's ARKit session: a new one is a new world. */
    readonly session: string,
    readonly seq: number,
    /** The phone's own clock (`monotonicTs`), in seconds. */
    readonly stamp: number,
    /** Tracker clock when it arrived, and how old it already was then (ms). */
    readonly at: number, readonly transitMs: number,
    readonly sentAt?: number, readonly receivedAt?: number, readonly latencyMs?: number,
  ) {
    this.position = Object.freeze([...position]) as unknown as Vec3;
    this.rotation = Object.freeze(matrixFromQuaternion(quaternion).map(row => Object.freeze(row))) as unknown as Mat3;
    Object.freeze(this);
  }
  /** How old the pose is at `now` (tracker clock, ms). */
  age(now: number): number { return this.transitMs + now - this.at; }
}

/** One phone as the gateway last described it. A snapshot: the tracker hands out copies. */
export class Phone {
  name: string;
  color = '#6b6f73';
  connected = false;
  /** The phone's current ARKit session, from the roster. */
  session?: string;
  calibration: CalibrationStatus = 'uncalibrated';
  /** Increments whenever the phone's frame changes: re-anchor. */
  epoch = 0;
  pose: PhonePose | null = null;
  /** Control values by action: toggles, selects, sliders, sticks, and Stop. */
  values: Record<string, ControlValue> = {};
  holds: Record<string, Hold> = {};
  drags: Record<string, Drag> = {};
  /** Presses of plain buttons by action (holds count theirs in `holds`). */
  pressCounts: Record<string, number> = {};

  constructor(public id: string, readonly stopAction = 'safety.estop') { this.name = id; }

  /** Whether this phone has Stop on. */
  get stop(): boolean { return this.values[this.stopAction] === true; }
  /** Kept from before a gateway restart for its Stop (`phone-1@marionette-ab12cd3`); never connected again. */
  get stale(): boolean { return this.id.includes('@'); }
  /** The gateway numbers phones in order: `phone-2` is 2 (1 000 000 if the id isn't numbered). */
  get ordinal(): number { const match = /-(\d+)$/.exec(this.id.split('@')[0]); return match ? Number(match[1]) : 1_000_000; }

  value(action: string): ControlValue | undefined { return this.values[action]; }
  /** A numeric value, clamped to `min`..`max`; `fallback` when it isn't a finite number. */
  number(action: string, fallback: number, min = -Infinity, max = Infinity): number {
    const value = this.values[action];
    return finite(value) ? Math.min(Math.max(value, min), max) : fallback;
  }
  /** A value that must be one of `options`; `fallback` otherwise. */
  choice<T extends ControlValue>(action: string, options: readonly T[], fallback: T): T {
    const value = this.values[action];
    return options.includes(value as T) ? value as T : fallback;
  }
  hold(action: string): Readonly<Hold> { return this.holds[action] ?? { down: false, at: -Infinity, presses: 0 }; }
  /** Held, and its renewals still arriving within `timeoutMs` (the phone renews every 200 ms). */
  holding(action: string, now: number, timeoutMs = 600): boolean { const hold = this.holds[action]; return !!hold && hold.down && now - hold.at <= timeoutMs; }
  drag(action: string): Readonly<Drag> | undefined { return this.drags[action]; }
  /** How many times the button (a hold or a plain one) has been pressed. Compare counts to see new presses. */
  presses(action: string): number { return this.holds[action]?.presses ?? this.pressCounts[action] ?? 0; }
  /**
   * Where a stick is pushed: its live sample while it is being dragged and the samples keep coming, rest when nobody
   * touches it (or the gateway ended the drag), and undefined when it is touched but its samples stopped for
   * `timeoutMs` (the phone repeats every 50 ms): a dead source, stop at once.
   */
  stick(action: string, now: number, timeoutMs = 250): StickValue | undefined {
    const drag = this.drags[action];
    if (!drag || !drag.live || drag.dropped) return rest();
    if (now - drag.at > timeoutMs) return undefined;
    return isStickInRange(drag.value) ? { x: drag.value.x, y: drag.value.y } : rest();
  }
  /** How old the pose is at `now`; undefined without one. */
  poseAge(now: number): number | undefined { return this.pose?.age(now); }

  copy(): Phone {
    const phone = new Phone(this.id, this.stopAction);
    Object.assign(phone, { name: this.name, color: this.color, connected: this.connected, session: this.session, calibration: this.calibration, epoch: this.epoch, pose: this.pose,
      values: cloneValues(this.values), pressCounts: { ...this.pressCounts },
      holds: Object.fromEntries(Object.entries(this.holds).map(([action, hold]) => [action, { ...hold }])),
      drags: Object.fromEntries(Object.entries(this.drags).map(([action, drag]) => [action, { ...drag, value: clone(drag.value) }])) });
    return phone;
  }

  /** The shape the shared conformance fixtures check (`sdk/conformance/tracker`). */
  toConformance(): ConformancePhone {
    const presses: Record<string, number> = { ...this.pressCounts };
    for (const [action, hold] of Object.entries(this.holds)) presses[action] = hold.presses;
    return {
      id: this.id, connected: this.connected, calibration: this.calibration, epoch: this.epoch, stop: this.stop, values: cloneValues(this.values),
      holds: Object.fromEntries(Object.entries(this.holds).map(([action, hold]) => [action, { down: hold.down, presses: hold.presses }])),
      drags: Object.fromEntries(Object.entries(this.drags).map(([action, drag]) => [action, { live: drag.live, dropped: drag.dropped, value: clone(drag.value) ?? null }])),
      presses,
      pose: this.pose ? { session: this.pose.session, tracking: this.pose.tracking, source: this.pose.source, calibration: this.pose.calibration } : null,
    };
  }
}
export type ConformancePhone = {
  id: string; connected: boolean; calibration: CalibrationStatus; epoch: number; stop: boolean; values: Record<string, ControlValue>;
  holds: Record<string, { down: boolean; presses: number }>; drags: Record<string, { live: boolean; dropped: boolean; value: ControlValue | null }>;
  presses: Record<string, number>; pose: null | { session: string; tracking: string; source: string; calibration: string };
};

type Kind = 'hold' | 'button' | 'toggle' | 'select' | 'slider' | 'joystick';
type Control = { kind: Kind; options?: string[]; min?: number; max?: number; step?: number };

/**
 * Folds the gateway's `config`, `pose` and `input` messages into one `Phone` per id. It decides nothing: read
 * `snapshot()` every control tick and apply your own policy (the `teleop` parts help). Holds, drags and buttons are
 * learned from the layout in the configs, with no actions built in apart from Stop. The rules:
 *
 * - A repeat (`renew`) only extends a hold that is already down; it never starts one.
 * - Press edges are counted, for holds and plain buttons alike.
 * - A drag the gateway ended stays ended (`dropped`) until the operator lets go, whatever samples still arrive: a
 *   stick rests, a slider's value follows the config.
 * - While a drag is live its samples set its value (the config only follows a drag's start and end).
 * - Settings follow the phone's screen: a toggle, select or slider takes its value from the phone's config whoever set
 *   it (a desk mirror, a new screen's defaults, anything while the tracker was away), so the robot never acts on a
 *   value the phone doesn't show. A stick does too, except one the config has dragged by someone the tracker doesn't
 *   hear (a mirror): it stays at rest. The phone's own inputs set values sooner.
 * - Stop acts from the press itself, before the config follows. A config may turn it on, but (unless the mirror
 *   policy is `allow`) never off once it is on, not even the first config after `lostGateway()`: only the phone itself
 *   turns it off, or `clearStaleStops()` while it is offline.
 * - A lost gateway (`lostGateway()`), or a phone dropping, lets go of everything.
 * - A restarted gateway names phones afresh; a phone left with Stop on is kept, offline, as `<id>@<old gateway
 *   session>` until `clearStaleStops()`. A phone that leaves the roster (an app too old to say hello) is forgotten
 *   the same way, kept as `<id>@<gateway session>` if its Stop is on.
 * - The mirror policy governs a desktop mirror's motion. Unless it is `allow`, a mirror's input never presses, renews
 *   or releases a hold, never starts, moves or ends a drag, never counts a press and never turns Stop off; under
 *   `stop-only` its Stop on counts, under `deny` nothing of it does.
 * - The gateway's own inputs only end holds and drags.
 * - `clearStaleStops()` (the desktop clearing Stop) holds for a phone while it stays offline.
 * - Presses and values of actions no control declares are counted and kept too.
 * - Malformed messages are ignored.
 */
export class PhoneTracker {
  readonly mirror: MirrorPolicy;
  readonly stopAction: string;
  /** The gateway's session (it changes when the gateway restarts). */
  gateway?: string;
  private readonly clock: () => number;
  private readonly wall: () => number;
  private offset: () => number | undefined;
  private phones = new Map<string, Phone>();
  private readonly layout = new Map<string, Control>();
  /** Offline phones whose Stop the desktop cleared: a config can't turn it back on until they reconnect. */
  private readonly cleared = new Set<string>();

  constructor(options: TrackerOptions = {}) {
    this.mirror = options.mirror ?? 'stop-only'; this.stopAction = options.stopAction ?? 'safety.estop';
    this.clock = options.clock ?? monotonic; this.wall = options.wallClock ?? wallClock; this.offset = options.offsetMs ?? (() => undefined);
  }

  /** The tracker's clock now (ms): pass it to `holding`, `stick`, `age` and the teleop gates. */
  now(): number { return this.clock(); }

  /** Feeds this tracker from a client: its messages, its losses and its clock offset. Returns a function that stops. */
  attach(client: GatewayClient): () => void {
    this.offset = () => client.offsetMs;
    const offs = [client.on('message', message => this.apply(message)), client.on('lost', () => this.lostGateway())];
    return () => { for (const off of offs) off(); };
  }

  /** A copy of every phone, by id. */
  snapshot(): Map<string, Phone> { return new Map([...this.phones].map(([id, phone]) => [id, phone.copy()])); }
  /** A copy of one phone. */
  get(id: string): Phone | undefined { return this.phones.get(id)?.copy(); }
  /** Whether any phone, connected or not (or kept from before a restart), has Stop on. */
  anyStop(): boolean { return [...this.phones.values()].some(phone => phone.stop); }

  /**
   * The gateway went away: nobody is connected or holding anything. Stop stays on, and the configs that follow a
   * reconnect can't turn it off (the tracker can't tell whether the phone or a mirror did meanwhile).
   */
  lostGateway(): void { for (const phone of this.phones.values()) { phone.connected = false; letGo(phone); } }
  /**
   * Forgets the phones kept for their Stop (from before a gateway restart, or gone from the roster) and turns Stop off
   * on offline phones that have it on, until they reconnect: what a desktop "clear Stop" does.
   */
  clearStaleStops(): void {
    for (const [id, phone] of [...this.phones]) {
      if (phone.stale) this.phones.delete(id);
      else if (!phone.connected && phone.stop) { phone.values[this.stopAction] = false; this.cleared.add(id); }
    }
  }

  /** Folds in one gateway message; anything else, or anything malformed, is ignored. */
  apply(message: unknown): void {
    if (!isObject(message) || (message.version !== undefined && message.version !== 1)) return;
    if (message.type === 'config') this.config(message);
    else if (message.type === 'pose') this.pose(message);
    else if (message.type === 'input') this.input(message);
  }

  private config(m: Json): void {
    const session = m.sessionId;
    if (typeof session === 'string' && session && session !== this.gateway) { if (this.gateway !== undefined) this.restarted(this.gateway); this.gateway = session; }
    if (Array.isArray(m.controls)) this.learn(m.controls);
    if (Array.isArray(m.phones)) {
      for (const info of m.phones) this.info(info);
      if (m.phones.every(info => isObject(info) && typeof info.id === 'string' && info.id)) this.forgetAbsent(new Set([...m.phones.map(info => (info as Json).id as string), ...(isObject(m.phone) && typeof m.phone.id === 'string' ? [m.phone.id] : [])]));
    }
    const phone = this.info(m.phone); if (!phone) return;
    // What the phone's screen shows. Settings follow it, whoever set them (the gateway applies a mirror's changes too);
    // motion and Stop off don't.
    if (Array.isArray(m.controls)) for (const control of m.controls) {
      if (!isObject(control) || typeof control.action !== 'string' || !control.action) continue;
      const action = control.action; const known = this.layout.get(action); if (!known) continue;
      if (known.kind === 'hold') {
        const hold = phone.holds[action] ??= { down: false, at: -Infinity, presses: 0 };
        // The gateway's view ends holds whose renewals stopped; its held: true never starts one (a mirror's hold isn't held here).
        if (control.held === false) hold.down = false;
      } else if (known.kind === 'button') phone.pressCounts[action] ??= 0;
      else if (known.kind === 'slider' || known.kind === 'joystick') {
        const drag = phone.drags[action] ??= { kind: known.kind, live: false, dropped: false, at: -Infinity };
        if (control.live === false && drag.live) { drag.live = false; if (known.kind === 'joystick') setValue(phone, action, rest()); }
        // During a drag here the samples are newer than any config. A stick someone else is dragging (a mirror, or a
        // drag this tracker hasn't heard yet) is motion, not a setting: it stays where it is.
        if (valid(known, control.value) && !drag.live && !(known.kind === 'joystick' && control.live === true)) setValue(phone, action, control.value as ControlValue);
      } else if (valid(known, control.value)) {
        if (action === this.stopAction) {
          // A cleared offline phone stays cleared. Once Stop is on only the phone itself turns it off: the gateway
          // applies a mirror's Stop off too, and after a reconnect the tracker can't tell whose it was.
          if (control.value === true && this.cleared.has(phone.id) && !phone.connected) continue;
          if (control.value === false && phone.stop && this.mirror !== 'allow') continue;
        }
        phone.values[action] = clone(control.value as ControlValue);
      }
    }
    const calibration = m.calibration;
    if (isObject(calibration)) {
      if (typeof calibration.status === 'string' && CALIBRATION.includes(calibration.status)) phone.calibration = calibration.status as CalibrationStatus;
      if (Number.isInteger(calibration.epoch)) phone.epoch = calibration.epoch as number;
    }
  }

  /** The layout: what each action is, from the controls every config carries. */
  private learn(controls: unknown[]): void {
    this.layout.clear();
    for (const control of controls) {
      if (!isObject(control) || typeof control.action !== 'string' || !control.action || this.layout.has(control.action)) continue;
      const type = control.type;
      const kind: Kind | undefined = type === 'button' ? (control.hold === true ? 'hold' : 'button') : type === 'toggle' || type === 'select' || type === 'slider' || type === 'joystick' ? type : undefined;
      if (!kind) continue;
      this.layout.set(control.action, { kind,
        ...(kind === 'select' ? { options: (Array.isArray(control.options) ? control.options : []).filter(isObject).map(option => option.value).filter((value): value is string => typeof value === 'string') } : {}),
        ...(kind === 'slider' && finite(control.min) && finite(control.max) && finite(control.step) && control.step > 0 ? { min: control.min, max: control.max, step: control.step } : {}) });
    }
  }

  private info(info: unknown): Phone | undefined {
    // Kept phones (`…@…`) are out of reach of any gateway.
    if (!isObject(info) || typeof info.id !== 'string' || !info.id || info.id.includes('@')) return undefined;
    let phone = this.phones.get(info.id);
    if (!phone) { phone = new Phone(info.id, this.stopAction); this.phones.set(info.id, phone); }
    if (typeof info.name === 'string') phone.name = info.name;
    if (typeof info.color === 'string') phone.color = info.color;
    const connected = info.connected === true;
    // A phone that drops releases everything it was holding.
    if (!connected) letGo(phone); else this.cleared.delete(phone.id);
    phone.connected = connected;
    phone.session = typeof info.sessionId === 'string' ? info.sessionId : undefined;
    return phone;
  }

  /** Phones gone from a complete roster are forgotten; one with Stop on stays, offline, as `<id>@<gateway session>`. */
  private forgetAbsent(present: Set<string>): void {
    for (const [id, phone] of [...this.phones]) {
      if (phone.stale || present.has(id)) continue;
      this.phones.delete(id); this.cleared.delete(id);
      if (!phone.stop) continue;
      phone.connected = false; letGo(phone); phone.id = `${id}@${this.gateway ?? 'gateway'}`; this.phones.set(phone.id, phone);
    }
  }

  /** A restarted gateway names phones afresh. A phone that left Stop on stays, offline, under its old id and gateway. */
  private restarted(old: string): void {
    this.cleared.clear();
    const kept = new Map<string, Phone>();
    for (const phone of this.phones.values()) {
      if (!phone.stop) continue;
      phone.connected = false; letGo(phone);
      if (!phone.stale) phone.id = `${phone.id}@${old}`;
      kept.set(phone.id, phone);
    }
    this.phones = kept;
  }

  /** A phone the gateway can address (not one kept for its Stop). */
  private addressed(m: Json): Phone | undefined { const phone = typeof m.phoneId === 'string' ? this.phones.get(m.phoneId) : undefined; return phone && !phone.stale ? phone : undefined; }

  private pose(m: Json): void {
    const phone = this.addressed(m); if (!phone) return;
    if (m.heartbeat === false) { phone.pose = null; return; }
    const p = m.position, q = m.rotation;
    if (m.heartbeat !== true || !isObject(p) || !isObject(q) || ![p.x, p.y, p.z, q.x, q.y, q.z, q.w].every(finite)
      || typeof m.trackingState !== 'string' || !TRACKING.includes(m.trackingState)) return;
    const quaternion = { x: q.x as number, y: q.y as number, z: q.z as number, w: q.w as number };
    if (Math.hypot(quaternion.x, quaternion.y, quaternion.z, quaternion.w) < 1e-6) return;
    const at = this.clock(); const offset = this.offset();
    const receivedAt = finite(m.receivedAt) ? m.receivedAt : undefined; const latencyMs = finite(m.latencyMs) ? m.latencyMs : undefined;
    // How old it already is: from the phone to the gateway (latencyMs), then from the gateway to us (its stamp and our offset).
    const transitMs = (latencyMs ?? 0) + (receivedAt !== undefined && offset !== undefined ? Math.max(0, this.wall() - offset - receivedAt) : 0);
    phone.pose = new PhonePose([p.x as number, p.y as number, p.z as number], quaternion, m.trackingState as TrackingState, String(m.source ?? '') as PoseSource,
      String(m.calibrationVersion ?? ''), String(m.sessionId ?? ''), finite(m.seq) ? m.seq : 0, finite(m.monotonicTs) ? m.monotonicTs : at / 1000, at, transitMs,
      finite(m.sentAt) ? m.sentAt : undefined, receivedAt, latencyMs);
  }

  private input(m: Json): void {
    const phone = this.addressed(m); if (!phone) return;
    const action = m.action; if (typeof action !== 'string' || !action) return;
    const source = m.source ?? 'phone'; if (source !== 'phone' && source !== 'mirror' && source !== 'gateway') return;
    const value = m.value; const renew = m.renew === true; const live = m.live === true; const now = this.clock();
    if (source === 'mirror' && this.mirror !== 'allow') {
      // From a desk, only Stop: turning it on, never off. Its settings reach the phone's config, and come from there.
      if (this.mirror === 'stop-only' && action === this.stopAction && value === true) phone.values[action] = true;
      return;
    }
    // Stop acts from the press itself; the config follows.
    if (action === this.stopAction) { if (typeof value === 'boolean') phone.values[action] = value; return; }
    const control = this.layout.get(action);
    // The gateway itself only ends holds and drags; it never presses or sets anything.
    if (source === 'gateway' && control?.kind !== 'hold' && control?.kind !== 'slider' && control?.kind !== 'joystick') return;
    if (!control) {
      // An action no control declares: counted as a press, and its value kept.
      if (!renew) phone.pressCounts[action] = (phone.pressCounts[action] ?? 0) + 1;
      if (isControlValue(value)) phone.values[action] = clone(value);
      return;
    }
    switch (control.kind) {
      case 'hold': {
        const hold = phone.holds[action] ??= { down: false, at: -Infinity, presses: 0 };
        if (source === 'gateway' || value !== true) hold.down = false;
        else if (renew) { if (hold.down) hold.at = now; }
        else { if (!hold.down) hold.presses++; hold.down = true; hold.at = now; }
        return;
      }
      case 'button': if (!renew) phone.pressCounts[action] = (phone.pressCounts[action] ?? 0) + 1; return;
      case 'toggle': case 'select': if (valid(control, value)) phone.values[action] = value as ControlValue; return;
      case 'slider': case 'joystick': {
        const drag = phone.drags[action] ??= { kind: control.kind, live: false, dropped: false, at: -Infinity };
        if (source === 'gateway') {
          // The gateway stopped hearing the drag. It stays ended until the operator lets go, whatever samples still arrive
          // (a drag the tracker never had live, a mirror's, isn't dropped). A stick rests; a slider's value follows the
          // config that comes next.
          drag.dropped = drag.live || drag.dropped; drag.live = false;
          if (control.kind === 'joystick') setValue(phone, action, rest());
          return;
        }
        if (!live) {
          // Let go: the final value (a stick springs back to rest), and samples count again from the next touch.
          drag.live = false; drag.dropped = false;
          if (control.kind === 'joystick') setValue(phone, action, rest()); else if (valid(control, value)) setValue(phone, action, value as ControlValue);
          return;
        }
        if (drag.dropped || !valid(control, value) || (renew && !drag.live)) return;
        setValue(phone, action, value as ControlValue); drag.live = true; drag.at = now;
      }
    }
  }
}

function valid(control: Control, value: unknown): boolean {
  switch (control.kind) {
    case 'toggle': return typeof value === 'boolean';
    case 'select': return typeof value === 'string' && !!control.options?.includes(value);
    case 'slider': {
      // The gateway's rule: within the range and on the step grid.
      const { min, max, step } = control;
      if (!finite(value) || min === undefined || max === undefined || step === undefined || value < min || value > max) return false;
      const steps = (value - min) / step; return Math.abs(steps - Math.round(steps)) < 1e-6;
    }
    case 'joystick': return isStickInRange(value);
    default: return false;
  }
}
function setValue(phone: Phone, action: string, value: ControlValue): void {
  phone.values[action] = clone(value);
  const drag = phone.drags[action]; if (drag) drag.value = clone(value);
}
/** A phone that is gone holds nothing and touches nothing. */
function letGo(phone: Phone): void {
  phone.pose = null;
  for (const hold of Object.values(phone.holds)) hold.down = false;
  for (const [action, drag] of Object.entries(phone.drags)) { drag.live = false; drag.dropped = false; if (drag.kind === 'joystick') setValue(phone, action, rest()); }
}
