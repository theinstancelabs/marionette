import { STICK_REST, defaultConfig, isLiveControl, sanitizeConfig, validateCameraFrame, validateHtmlConfig, validateInput, validatePong, validatePose, validateRobotState, validateRtc, validateStatus, type ConfigMessage, type ControlValue, type HtmlConfigMessage, type InputMessage, type PhoneInfo, type PingMessage, type PosePacket, type RobotInfo, type RobotStateMessage, type RtcMessage, type StatusMessage, type UiControl } from '@marionette/protocol';
import { EventJournal, configEvents, inputDraft, phoneEvents, phoneState, robotEvents, rosterEvents, screenDraft, statusDraft, type ConsoleEvent, type EventDraft, type PhoneState, type Tone } from './events';
import { frameKey, trimBefore, type Sample } from './motion';
import { rosterPhones, safeColor, type Phone } from './phones';
import { robotList, stateAge, stateKey, type RobotStateEntry } from './robots';
import { SIM_PHONES, SIM_ROBOT_EVERY_MS, simulatedConfig, simulatedGatewayConfig, simulatedHolds, simulatedRobotState, simulatedRoster, simulatedStick, simulationPose } from './simulation';

/** `id` is unique for the store's lifetime, so lists can key on it. */
export type InputRecord = { id: number; at: number; input: InputMessage };
/** Fast-changing telemetry of one phone. Kept out of React state; views read it in their own frame loops. */
export type PhoneLive = {
  pose?: PosePacket; poseAt: number; trail: Sample[]; history: Sample[];
  /** Maps the phone's monotonic clock onto ours, so bursty delivery does not bunch samples together. */
  clock?: { sessionId: string; offset: number };
  presence: PhoneState;
  /** Wall-clock time of the phone's last input, renewals included. */
  lastInputAt?: number;
  /** Recent presses, releases and changes, oldest first. Renewals are left out. */
  inputs: InputRecord[];
  /** Hold buttons pressed according to the input stream. */
  holding: Set<string>;
  /** Sliders and sticks being dragged according to the input stream, with their latest live value. */
  dragging: Map<string, ControlValue>;
  /** The gateway's latest reply about this phone. */
  reply?: { message: string; tone: Tone; at: number };
  /** The gateway's latency stamps on this phone's poses and inputs (phone send to gateway receipt), last second only. */
  latency: LatencySample[];
};
/** `t` is the viewer's monotonic clock, `ms` the gateway's estimate. */
export type LatencySample = { t: number; ms: number };
export type CameraFrame = { dataUrl: string; at: number };
export type Live = { phones: Map<string, PhoneLive>; cameras: Map<string, CameraFrame>; robotStates: Map<string, RobotStateEntry>; startedAt: number };
type PhoneConfig = ConfigMessage & { phone: PhoneInfo };
type ScreenSource = HtmlConfigMessage['source'];

export const TRAIL_MS = 2_000;
export const HISTORY_MS = 20_000;
export const MAX_INPUTS = 12;
/** The link latency readout is the median of the last second of stamps. */
export const LATENCY_WINDOW_MS = 1_000;
/** How often the viewer pings a gateway that answers pings, for its clock offset. */
export const PING_EVERY_MS = 5_000;
const RENEW_MS = 200;

const emptyPhone = (): PhoneLive => ({ poseAt: -Infinity, trail: [], history: [], presence: { present: false }, inputs: [], holding: new Set(), dragging: new Map(), latency: [] });
const emptyLive = (startedAt: number): Live => ({ phones: new Map(), cameras: new Map(), robotStates: new Map(), startedAt });
export type Clocks = { now: () => number; wall: () => number };
const systemClocks: Clocks = { now: () => performance.now(), wall: () => Date.now() };

/** The median of the samples from the last `windowMs`, and how many there were; undefined without any. */
export function recentMedian(samples: LatencySample[], now: number, windowMs = LATENCY_WINDOW_MS): { ms: number; count: number } | undefined {
  const values = samples.filter(sample => now - sample.t <= windowMs).map(sample => sample.ms).sort((a, b) => a - b);
  if (!values.length) return undefined;
  const mid = values.length >> 1;
  return { ms: values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2, count: values.length };
}

/**
 * Everything the viewer knows about a gateway and its phones, fed one message
 * at a time. `config` is the gateway's own view (the layout with default
 * values, the camera views, and the roster); `phoneConfigs` holds each phone's
 * own control values, holds and calibration. Both are replaced, never
 * mutated, and `onConfigs` fires when either changes. Telemetry lives in
 * `live` and is mutated in place.
 */
export class ViewerStore {
  live: Live;
  config: ConfigMessage = defaultConfig();
  phoneConfigs: Record<string, ConfigMessage> = {};
  readonly journal: EventJournal;
  /** Every phone this session has named, so log lines keep the name of a phone that has left the roster. */
  readonly seen = new Map<string, { name: string; color: string }>();
  /** Where the phones' screen comes from (`null` until the gateway says), so a change can be logged. */
  screen: ScreenSource | null = null;
  private inputSeq = 1;
  private sim?: { start: number; seq: number; renewedAt: number; stateAt: number };
  /** The gateway's answers to this viewer's pings: round trip and clock offset (gateway minus viewer), newest last. */
  private pings: { next: number; sentAt: number; samples: { rtt: number; offset: number }[] } = { next: 1, sentAt: -Infinity, samples: [] };

  constructor(private readonly listener: { onConfigs?: () => void; onEvents: (batch: ConsoleEvent[]) => void; onRtc?: (message: RtcMessage) => void }, private readonly clocks: Clocks = systemClocks) {
    this.live = emptyLive(clocks.wall());
    this.journal = new EventJournal(batch => listener.onEvents(batch));
  }

  reset() {
    this.live = emptyLive(this.clocks.wall());
    this.journal.clear(); this.sim = undefined; this.seen.clear(); this.screen = null; this.pings = { next: 1, sentAt: -Infinity, samples: [] };
    this.config = defaultConfig(); this.phoneConfigs = {}; this.listener.onConfigs?.();
  }

  /** Robots in roster order (they stay, offline, once they have connected). */
  robots(): RobotInfo[] { return robotList(this.config.robots, this.live.robotStates.values()); }

  /** A robot's latest state for every phone, and for each phone it addressed, in roster order. */
  robotStates(robotId: string): { all?: RobotStateEntry; phones: RobotStateEntry[] } {
    const order = this.phones().map(phone => phone.id);
    const rank = (entry: RobotStateEntry) => { const index = order.indexOf(entry.message.phoneId!); return index < 0 ? order.length : index; };
    const phones = [...this.live.robotStates.values()].filter(entry => entry.message.robotId === robotId && entry.message.phoneId !== undefined).sort((a, b) => rank(a) - rank(b));
    return { all: this.live.robotStates.get(stateKey(robotId)), phones };
  }

  /** How old a robot state is now, on the gateway's clock when this viewer knows it. */
  stateAge(entry: RobotStateEntry): number { return stateAge(entry, this.clocks.wall(), this.gatewayOffset()); }

  /** The gateway's clock minus this viewer's, from the ping with the shortest round trip; undefined until one is answered. */
  gatewayOffset(): number | undefined {
    let best: { rtt: number; offset: number } | undefined;
    for (const sample of this.pings.samples) if (!best || sample.rtt < best.rtt) best = sample;
    return best?.offset;
  }

  /**
   * A ping to send now, if one is due. Its pong gives the gateway's clock, so a robot state's age is right even
   * when the two clocks differ. Only gateways new enough to have an id are pinged (older ones refuse the message).
   */
  ping(): PingMessage | undefined {
    const now = this.clocks.wall();
    if (this.config.gatewayId === undefined || now - this.pings.sentAt < PING_EVERY_MS) return undefined;
    this.pings.sentAt = now;
    return { type: 'ping', version: 1, id: this.pings.next++, sentAt: now };
  }

  /** The median link latency of a phone over the last second, from the gateway's stamps. */
  latency(phoneId: string, now = this.clocks.now()) { const phone = this.live.phones.get(phoneId); return phone ? recentMedian(phone.latency, now) : undefined; }

  private addLatency(phone: PhoneLive, ms: number | undefined, now: number) {
    if (ms === undefined || !Number.isFinite(ms)) return;
    phone.latency.push({ t: now, ms }); trimBefore(phone.latency, now - LATENCY_WINDOW_MS);
  }

  /** Phones in roster order, each with its own config. */
  phones(): Phone[] { return rosterPhones(this.config.phones, this.phoneConfigs); }

  phone(id: string): PhoneLive {
    let phone = this.live.phones.get(id);
    if (!phone) { phone = emptyPhone(); this.live.phones.set(id, phone); }
    return phone;
  }

  private connected(id: string): boolean {
    return this.config.phones.find(phone => phone.id === id)?.connected ?? this.phoneConfigs[id]?.phone?.connected ?? false;
  }

  /** A control as this phone has it, falling back to the gateway layout. */
  control(phoneId: string | undefined, controlId: string): UiControl | undefined {
    return (phoneId ? this.phoneConfigs[phoneId]?.controls.find(control => control.id === controlId) : undefined) ?? this.config.controls.find(control => control.id === controlId);
  }

  /** Routes one parsed gateway message. Anything that does not validate is ignored. */
  receive(message: unknown) {
    const type = message && typeof message === 'object' ? (message as { type?: unknown }).type : undefined;
    if (type === 'pose') {
      if (!validatePose(message)) return;
      // The gateway names the phone on every pose; an older single-phone gateway's poses belong to its only phone.
      const roster = this.config.phones;
      const id = message.phoneId ?? (roster.length === 1 ? roster[0].id : undefined);
      if (id) this.ingestPose(id, message);
    } else if (type === 'camera_frame') {
      if (validateCameraFrame(message)) this.live.cameras.set(message.cameraId, { dataUrl: message.dataUrl, at: this.clocks.wall() });
    } else if (type === 'input') {
      if (validateInput(message)) this.ingestInput(message);
    } else if (type === 'config') {
      const next = sanitizeConfig(message); if (!next) return;
      if (next.phone) this.applyPhoneConfig(next as PhoneConfig); else this.applyGatewayConfig(next);
    } else if (type === 'status') {
      if (validateStatus(message)) this.applyStatus(message);
    } else if (type === 'robot_state') {
      if (validateRobotState(message) && message.robotId) this.applyRobotState(message);
    } else if (type === 'html_config') {
      // The screen itself is for the phones; the viewer only logs whose it is when it changes.
      if (validateHtmlConfig(message)) this.applyScreen(message.source);
    } else if (type === 'pong') {
      if (!validatePong(message)) return;
      const rtt = this.clocks.wall() - message.sentAt;
      if (rtt < 0 || rtt > 10_000) return;
      this.pings.samples.push({ rtt, offset: message.at - (message.sentAt + rtt / 2) });
      if (this.pings.samples.length > 8) this.pings.samples.shift();
    } else if (type === 'rtc') {
      if (validateRtc(message)) this.listener.onRtc?.(message);
    }
  }

  applyRobotState(message: RobotStateMessage) {
    this.live.robotStates.set(stateKey(message.robotId!, message.phoneId), { message, at: this.clocks.wall() });
  }

  private applyScreen(source: ScreenSource) {
    const next = source ?? { kind: 'default' as const };
    if (this.screen) this.journal.add(screenDraft(this.screen, next, this.robots()), this.clocks.wall());
    this.screen = next;
  }

  private propose(drafts: EventDraft[], phoneId?: string) {
    if (drafts.length) this.journal.propose(phoneId ? drafts.map(draft => ({ ...draft, phoneId })) : drafts, this.clocks.wall());
  }

  private updatePresence(id: string, phone: PhoneLive, now: number) {
    const next = phoneState(phone.pose, phone.poseAt, now);
    const drafts = phoneEvents(phone.presence, next, this.connected(id)); phone.presence = next;
    this.propose(drafts, id);
  }

  ingestPose(id: string, pose: PosePacket, now = this.clocks.now()) {
    const phone = this.phone(id); phone.pose = pose; phone.poseAt = now;
    this.addLatency(phone, pose.latencyMs, now);
    if (pose.heartbeat) {
      // Stamp samples with the phone's own clock, offset by the smallest delivery delay seen this session.
      const phoneMs = pose.monotonicTs * 1000;
      if (!phone.clock || phone.clock.sessionId !== pose.sessionId || phoneMs + phone.clock.offset > now + 1000) phone.clock = { sessionId: pose.sessionId, offset: now - phoneMs };
      else phone.clock.offset = Math.min(phone.clock.offset, now - phoneMs);
      const previous = phone.history.at(-1)?.t ?? -Infinity;
      const sample = { t: Math.max(previous, phoneMs + phone.clock.offset), p: pose.position, key: frameKey(pose) };
      phone.trail.push(sample); phone.history.push(sample);
      trimBefore(phone.trail, now - TRAIL_MS); trimBefore(phone.history, now - HISTORY_MS);
    }
    this.updatePresence(id, phone, now);
  }

  ingestInput(input: InputMessage) {
    const phone = this.phone(input.phoneId); const at = this.clocks.wall();
    phone.lastInputAt = at;
    if (input.source !== 'gateway') this.addLatency(phone, input.latencyMs, this.clocks.now());
    if (input.renew) return;
    const control = this.control(input.phoneId, input.controlId);
    // The gateway relays an input before acting on it, so its config still shows a hold this input ends.
    // That also covers a hold that was already on when this viewer connected.
    const wasHeld = phone.holding.has(input.controlId) || (control?.type === 'button' && !!control.held);
    if (control?.type === 'button' && control.hold) { if (input.value === false) phone.holding.delete(input.controlId); else phone.holding.add(input.controlId); }
    // Like a hold, a drag already under way when this viewer connected shows in the config.
    const wasLive = phone.dragging.has(input.controlId) || (isLiveControl(control) && !!control.live);
    if (input.live && input.value !== undefined && input.source !== 'gateway') phone.dragging.set(input.controlId, input.value); else phone.dragging.delete(input.controlId);
    // A slider or stick being dragged is one entry that keeps its latest value, through to where it was let go.
    const last = phone.inputs.at(-1);
    const sameDrag = !!last && last.input.controlId === input.controlId && (last.input.live || (typeof input.value === 'number' && typeof last.input.value === 'number')) && at - last.at < 1000;
    if (sameDrag) phone.inputs[phone.inputs.length - 1] = { id: last.id, at, input };
    else { phone.inputs.push({ id: this.inputSeq++, at, input }); if (phone.inputs.length > MAX_INPUTS) phone.inputs.shift(); }
    const draft = inputDraft(input, control, wasHeld, wasLive);
    if (draft) this.propose([draft]);
  }

  applyGatewayConfig(next: ConfigMessage) {
    const at = this.clocks.wall();
    for (const draft of rosterEvents(this.config.phones, next.phones)) this.journal.explain(draft, at);
    this.propose(robotEvents(this.config.robots, next.robots));
    // A phone that left the roster is gone for good, and the gateway may hand its id to the next phone.
    const listed = new Set(next.phones.map(phone => phone.id));
    const gone = this.config.phones.filter(phone => !listed.has(phone.id)).map(phone => phone.id);
    for (const id of gone) this.live.phones.delete(id);
    // The gateway forgets robot state addressed to a phone that left; so does the viewer.
    for (const [key, entry] of this.live.robotStates) if (entry.message.phoneId && gone.includes(entry.message.phoneId)) this.live.robotStates.delete(key);
    if (gone.some(id => id in this.phoneConfigs)) this.phoneConfigs = Object.fromEntries(Object.entries(this.phoneConfigs).filter(([id]) => !gone.includes(id)));
    this.remember(next.phones);
    this.config = next; this.listener.onConfigs?.();
  }

  private remember(phones: PhoneInfo[]) { for (const phone of phones) this.seen.set(phone.id, { name: phone.name, color: safeColor(phone.color) }); }

  applyPhoneConfig(next: PhoneConfig) {
    const id = next.phone.id; const prev = this.phoneConfigs[id];
    if (prev) this.propose(configEvents(prev, next), id);
    this.remember([next.phone]);
    this.phoneConfigs = { ...this.phoneConfigs, [id]: next }; this.listener.onConfigs?.();
  }

  applyStatus(status: StatusMessage) {
    const at = this.clocks.wall(); const id = status.phoneId;
    const draft = statusDraft(status, id ? this.phoneConfigs[id] ?? this.config : this.config);
    if (id) this.phone(id).reply = { message: draft.message, tone: draft.tone, at };
    this.journal.explain(draft, at, true);
  }

  /** Called ~12 times a second: a silent phone times out, and held events that are due are logged. */
  tick(now = this.clocks.now()) {
    for (const [id, phone] of this.live.phones) this.updatePresence(id, phone, now);
    this.journal.flush(this.clocks.wall());
  }

  /** Starts two simulated phones; call `simulateFrame` on every animation frame. */
  simulate() {
    this.reset();
    this.journal.add({ kind: 'session', message: 'Simulated phones started. Nothing is sent to a gateway or robot', tone: 'normal' }, this.clocks.wall());
    const roster = simulatedRoster();
    this.applyGatewayConfig(simulatedGatewayConfig(roster));
    roster.forEach((_, index) => this.applyPhoneConfig(simulatedConfig(index, roster) as PhoneConfig));
    this.sim = { start: this.clocks.now(), seq: 0, renewedAt: -Infinity, stateAt: -Infinity };
  }

  /** One simulated frame: a pose from each phone, the presses, renewals and releases of their holds, Phone 1's stick, and the robot's state when due. */
  simulateFrame(now = this.clocks.now()) {
    const sim = this.sim; if (!sim) return;
    const t = (now - sim.start) / 1000; const renew = now - sim.renewedAt >= RENEW_MS;
    if (renew) sim.renewedAt = now;
    if (now - sim.stateAt >= SIM_ROBOT_EVERY_MS) {
      sim.stateAt = now; const receivedAt = this.clocks.wall();
      for (const index of [undefined, ...SIM_PHONES.keys()]) this.applyRobotState({ ...simulatedRobotState(t, index), receivedAt });
    }
    SIM_PHONES.forEach((phone, index) => {
      this.ingestPose(phone.id, simulationPose(index, t, sim.seq), now);
      const config = this.phoneConfigs[phone.id]; if (!config?.phone) return;
      const want = simulatedHolds(index, t); const push = simulatedStick(index, t); let changed = false;
      const controls = config.controls.map(control => {
        if (control.type === 'joystick') {
          // A pushed stick streams a live sample every frame; letting go sends it back to rest.
          const sample: InputMessage = { type: 'input', version: 1, phoneId: phone.id, sessionId: config.sessionId, controlId: control.id, action: control.action, value: push ?? { ...STICK_REST }, source: 'phone', receivedAt: this.clocks.wall() };
          if (push) { this.ingestInput({ ...sample, live: true }); if (control.live) return control; changed = true; return { ...control, value: push, live: true }; }
          if (!control.live) return control;
          changed = true; this.ingestInput(sample); return { ...control, value: { ...STICK_REST }, live: false };
        }
        if (control.type !== 'button' || !control.hold) return control;
        const held = want.includes(control.id);
        const input: InputMessage = { type: 'input', version: 1, phoneId: phone.id, sessionId: config.sessionId, controlId: control.id, action: control.action, value: held, source: 'phone', receivedAt: this.clocks.wall() };
        if (held === !!control.held) { if (held && renew) this.ingestInput({ ...input, renew: true }); return control; }
        changed = true; this.ingestInput(input);
        return { ...control, held };
      });
      if (changed) this.applyPhoneConfig({ ...config, phone: config.phone, controls });
    });
    sim.seq++;
  }
}
