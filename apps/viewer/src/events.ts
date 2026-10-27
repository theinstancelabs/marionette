import { CALIBRATION_STEPS, describeCheckResult, type CalibrationCheckResult, type CalibrationStep, type ConfigMessage, type InputMessage, type PhoneInfo, type PosePacket, type StatusMessage, type TrackingState, type UiControl } from '@marionette/protocol';
import { TRACKING_WORDS } from './motion';

export const EVENT_KINDS = ['session', 'tracking', 'calibration', 'validation', 'input', 'safety', 'camera', 'settings'] as const;
export type EventKind = typeof EVENT_KINDS[number];
export type Tone = 'normal' | 'pass' | 'fail';
/**
 * A log line before it is logged. `phoneId` names the phone it concerns.
 * `pair` says what happens when the gateway's status of the same kind and phone
 * explains this transition (the gateway sends a phone's config, then the status
 * that explains it): `replace` keeps only the status, `prefix` joins them.
 * Drafts with the same `key` and phone replace each other until one has been
 * quiet for `settleMs`, so dragging a slider logs one line.
 */
export type EventDraft = { kind: EventKind; message: string; tone: Tone; phoneId?: string; pair?: 'replace' | 'prefix'; key?: string; settleMs?: number };
export type ConsoleEvent = { id: number; at: number; kind: EventKind; message: string; tone: Tone; phoneId?: string };
export type Primitive = string | number | boolean;

/** Kind of a change to a control's value, or of a gateway reply to it. */
export function kindForAction(action: string | undefined): EventKind {
  if (!action) return 'session';
  if (action === 'calibration.check') return 'validation';
  if (action.startsWith('calibration.')) return 'calibration';
  if (action.startsWith('safety.')) return 'safety';
  if (action.startsWith('camera.')) return 'camera';
  return 'settings';
}

const TEXT_KINDS: [RegExp, EventKind][] = [[/tracking|relocaliz/i, 'tracking'], [/validat/i, 'validation'], [/calibrat|origin/i, 'calibration'], [/camera/i, 'camera']];
/** Kind of a status message that is not a reply to a control. */
export function kindForText(message: string): EventKind { return TEXT_KINDS.find(([pattern]) => pattern.test(message))?.[1] ?? 'session'; }

export function textTone(message: string): Tone {
  if (/✗|validation failed/i.test(message)) return 'fail';
  if (/✓|^validated/i.test(message)) return 'pass';
  return 'normal';
}

/** Whether a gateway status refuses what the phone asked for. */
export const isRejection = (status: StatusMessage): boolean => status.values?.accepted === false || status.values?.rejected === true;

/** The log entry for a gateway status. `config` is the phone's own config when the status names a phone. */
export function statusDraft(status: StatusMessage, config?: Pick<ConfigMessage, 'controls'>): EventDraft {
  const control = status.controlId ? config?.controls.find(candidate => candidate.id === status.controlId) : undefined;
  const kind = control ? kindForAction(control.action) : kindForText(status.message);
  return { kind, message: status.message, tone: isRejection(status) ? 'fail' : textTone(status.message), phoneId: status.phoneId };
}

const decimals = (step: number) => Math.min(3, String(step).split('.')[1]?.length ?? 0);
export function formatPrimitive(value: Primitive): string {
  if (typeof value === 'number') return String(Number(value.toFixed(3)));
  return String(value);
}
/** A control's current value in words: "on", "Right arm", "1.5×". Buttons have none. */
export function valueText(control: UiControl): string | undefined {
  if (control.type === 'toggle') return control.value ? 'on' : 'off';
  if (control.type === 'select') return control.options.find(option => option.value === control.value)?.label ?? control.value;
  if (control.type === 'slider') return `${control.value.toFixed(decimals(control.step))}${control.unit ?? ''}`;
  return undefined;
}

const STEP_DONE: Record<CalibrationStep, string> = { flat: 'Flat reference captured', forward: 'Forward captured', right: 'Right captured', up: 'Up captured' };
/** The guided step a config is on, if it is one this viewer knows (a newer gateway may send others). */
export const knownStep = (step: unknown): CalibrationStep | undefined => CALIBRATION_STEPS.includes(step as CalibrationStep) ? step as CalibrationStep : undefined;
/** Whether `b` starts with exactly the results in `a`. Each check is a fresh measurement, so a restored older result never matches. */
const extends_ = (a: CalibrationCheckResult[], b: CalibrationCheckResult[]) => a.every((result, index) => {
  const other = b[index]; const d = result.displacement, e = other?.displacement;
  return !!other && result.move === other.move && result.passed === other.passed && d.x === e.x && d.y === e.y && d.z === e.z;
});

/** Calibration and validation progress, from one of a phone's configs to the next. */
export function calibrationEvents(a: ConfigMessage['calibration'], b: ConfigMessage['calibration']): EventDraft[] {
  const out: EventDraft[] = []; const stepA = knownStep(a.step), stepB = knownStep(b.step);
  const frameName = b.reference?.mode === 'quick' ? 'Quick origin' : 'Guided frame';
  if (a.status !== 'capturing' && b.status === 'capturing') out.push({ kind: 'calibration', message: 'Guided calibration started', tone: 'normal', pair: 'prefix' });
  else if (a.status === 'capturing' && b.status === 'capturing' && stepA !== stepB && stepA && stepB) {
    out.push(CALIBRATION_STEPS.indexOf(stepB) > CALIBRATION_STEPS.indexOf(stepA)
      ? { kind: 'calibration', message: STEP_DONE[stepA], tone: 'normal', pair: 'replace' }
      : { kind: 'calibration', message: 'Guided calibration restarted at the flat step', tone: 'normal', pair: 'prefix' });
  }
  if (b.status === 'captured' && (a.status !== 'captured' || a.epoch !== b.epoch)) {
    if (a.status === 'capturing' && a.epoch === b.epoch) out.push({ kind: 'calibration', message: 'Calibration cancelled; previous frame kept', tone: 'normal', pair: 'replace' });
    else if (a.status === 'capturing' && b.reference?.mode !== 'quick') out.push({ kind: 'calibration', message: `Up captured; guided frame is live (epoch ${b.epoch})`, tone: 'normal', pair: 'prefix' });
    else out.push({ kind: 'calibration', message: `${frameName} is live (epoch ${b.epoch})`, tone: 'normal', pair: 'prefix' });
  }
  if (a.status !== 'uncalibrated' && b.status === 'uncalibrated') out.push({ kind: 'calibration', message: a.status === 'capturing' ? 'Calibration cancelled' : 'Calibration cleared', tone: 'normal', pair: 'replace' });

  // Results only count when they continue a validation that was running; a cancel restores an older result, which is not news.
  const before = a.status === 'captured' && b.status === 'captured' && a.epoch === b.epoch ? a.check : undefined, after = b.check;
  if (after?.step && !after.results.length && (!before?.step || before.results.length)) out.push({ kind: 'validation', message: 'Validation started', tone: 'normal', pair: 'prefix' });
  if (!before?.step) return out;
  if (after && after.step === before.step && after.results.length === before.results.length && extends_(before.results, after.results)) return out;
  const continued = !!after && after.results.length > before.results.length && extends_(before.results, after.results);
  if (!continued) {
    // A restart reads as "Validation started" above; anything else ended the run early.
    if (!(after?.step && !after.results.length)) out.push({ kind: 'validation', message: 'Validation cancelled', tone: 'normal', pair: 'replace' });
    return out;
  }
  for (const result of after.results.slice(before.results.length)) out.push({ kind: 'validation', message: describeCheckResult(result), tone: result.passed ? 'pass' : 'fail' });
  if (after.passed !== undefined) out.push(after.passed
    ? { kind: 'validation', message: 'Validated: forward +X, right −Y, up +Z', tone: 'pass', pair: 'replace' }
    : { kind: 'validation', message: 'Validation failed', tone: 'fail', pair: 'replace' });
  return out;
}

/**
 * Value changes worth a log line, from one of a phone's configs to the next:
 * Stop on and off, arm and camera choices, and any other toggle, select or
 * slider. Holds are logged from the input stream instead.
 */
export function controlEvents(prev: ConfigMessage, next: ConfigMessage): EventDraft[] {
  const out: EventDraft[] = [];
  for (const after of next.controls) {
    if (after.type === 'button') continue;
    const before = prev.controls.find(candidate => candidate.id === after.id);
    if (!before || before.type !== after.type || before.value === after.value) continue;
    const kind = kindForAction(after.action);
    if (after.type === 'toggle') out.push({ kind, message: `${after.label} ${after.value ? 'on' : 'off'}`, tone: after.action === 'safety.estop' && after.value ? 'fail' : 'normal' });
    else if (after.type === 'select') out.push({ kind, message: `${after.label}: ${valueText(after)}`, tone: 'normal' });
    else out.push({ kind, message: `${after.label}: ${valueText(after)}`, tone: 'normal', key: `control:${after.id}`, settleMs: 600 });
  }
  return out;
}

/** Everything worth logging between two configs of one phone. */
export function configEvents(prev: ConfigMessage, next: ConfigMessage): EventDraft[] {
  return [...controlEvents(prev, next), ...calibrationEvents(prev.calibration, next.calibration)];
}

/**
 * Phones joining, leaving and coming back, from one roster to the next. A
 * connected phone whose session the gateway cleared was taken over by a new
 * connection from the same device (only a new connection clears it).
 */
export function rosterEvents(prev: PhoneInfo[], next: PhoneInfo[]): EventDraft[] {
  const out: EventDraft[] = [];
  for (const phone of next) {
    const before = prev.find(candidate => candidate.id === phone.id);
    if (phone.connected && !before?.connected) out.push({ kind: 'session', message: before ? 'Reconnected' : 'Connected', tone: 'normal', phoneId: phone.id });
    else if (!phone.connected && before?.connected) out.push({ kind: 'session', message: 'Disconnected', tone: 'normal', phoneId: phone.id });
    else if (phone.connected && before?.sessionId && !phone.sessionId) out.push({ kind: 'session', message: 'Reconnected, replacing its previous connection', tone: 'normal', phoneId: phone.id });
  }
  for (const phone of prev) if (phone.connected && !next.some(candidate => candidate.id === phone.id)) out.push({ kind: 'session', message: 'Disconnected', tone: 'normal', phoneId: phone.id });
  return out;
}

const via = (input: InputMessage) => input.source === 'mirror' ? ' (desktop mirror)' : '';
/**
 * How one input reads in a phone's recent inputs: "pressed", "released by the
 * gateway (hold not renewed)", "→ Right arm".
 */
export function inputText(input: InputMessage, control?: UiControl): string {
  if (control?.type === 'button') {
    if (control.hold && input.value === false) return input.source === 'gateway' ? `released by the gateway${input.reason ? ` (${input.reason})` : ''}` : `released${via(input)}`;
    return `pressed${typeof input.value === 'string' ? ` (${input.value})` : ''}${via(input)}`;
  }
  if (input.value === undefined) return `sent${via(input)}`;
  if (control?.type === 'toggle' && typeof input.value === 'boolean') return `${input.value ? 'on' : 'off'}${via(input)}`;
  if (control?.type === 'select') return `→ ${control.options.find(option => option.value === input.value)?.label ?? formatPrimitive(input.value)}${via(input)}`;
  if (control?.type === 'slider' && typeof input.value === 'number') return `→ ${input.value.toFixed(decimals(control.step))}${control.unit ?? ''}${via(input)}`;
  return `${formatPrimitive(input.value)}${via(input)}`;
}

/**
 * The log line for one input, if it gets one. Renewals of a hold never do,
 * and neither does a second press of a hold already pressed (`wasHeld`), nor
 * the release of a hold that had already ended (the phone letting go after
 * the gateway released it for missed renewals).
 * Toggles, selects and sliders are logged from the phone's config when the
 * value changes, and calibration buttons from the calibration progress.
 */
export function inputDraft(input: InputMessage, control: UiControl | undefined, wasHeld: boolean): EventDraft | undefined {
  if (input.renew) return undefined;
  const kind: EventKind = input.action.startsWith('safety.') ? 'safety' : 'input';
  const base = { kind, tone: 'normal' as const, phoneId: input.phoneId };
  if (control?.type === 'button') {
    const release = input.value === false;
    if (control.hold && (release ? !wasHeld : wasHeld)) return undefined;
    if (!control.hold && control.action.startsWith('calibration.')) return undefined;
    return { ...base, message: `${control.label} ${inputText(input, control)}` };
  }
  if (control) return undefined;
  // An action the layout does not declare, such as a custom screen's own button.
  return { ...base, kind: 'input', message: `${input.action}${input.value === undefined ? '' : `: ${formatPrimitive(input.value)}`}${via(input)}`, key: `input:${input.controlId}`, settleMs: typeof input.value === 'number' ? 600 : undefined };
}

/** Whether a phone is streaming, from its latest pose and how long ago it arrived. */
export type PhoneState = { present: boolean; sessionId?: string; tracking?: TrackingState };
export const PHONE_TIMEOUT_MS = 1500;
export function phoneState(pose: PosePacket | undefined, poseAt: number, now: number): PhoneState {
  if (!pose || !pose.heartbeat || now - poseAt > PHONE_TIMEOUT_MS) return { present: false };
  return { present: true, sessionId: pose.sessionId, tracking: pose.trackingState };
}
/**
 * Pose stream changes for one phone. A stream that stops because the phone
 * disconnected (`connected` false) is left to the roster's "Disconnected".
 */
export function phoneEvents(prev: PhoneState, next: PhoneState, connected = true): EventDraft[] {
  if (!prev.present && next.present) return [{ kind: 'session', message: `Streaming poses, ${TRACKING_WORDS[next.tracking ?? 'unavailable'].toLowerCase()}`, tone: 'normal' }];
  if (prev.present && !next.present) return connected ? [{ kind: 'session', message: 'Pose stream stopped', tone: 'normal', pair: 'replace' }] : [];
  if (prev.present && next.present && prev.sessionId !== next.sessionId) return [{ kind: 'session', message: 'New tracking session', tone: 'normal' }];
  if (prev.present && next.present && prev.tracking !== next.tracking) return [{ kind: 'tracking', message: TRACKING_WORDS[next.tracking ?? 'unavailable'], tone: 'normal' }];
  return [];
}

/** `reply` marks a gateway reply: the config change it explains arrives after it, but belongs before it. */
type Pending = { draft: EventDraft; at: number; due: number; explains: boolean; reply?: boolean };
/**
 * Collects log events. Everything is held briefly, so a transition the viewer
 * detects and the gateway's own explanation of it on the same phone (a status,
 * or a roster change) become one line, whichever of the two arrives first.
 */
export class EventJournal {
  private pending: Pending[] = [];
  private nextId = 1;
  constructor(private readonly emit: (events: ConsoleEvent[]) => void, private readonly holdMs = 250) {}
  private event(draft: EventDraft, at: number): ConsoleEvent { return { id: this.nextId++, at, kind: draft.kind, message: draft.message, tone: draft.tone, phoneId: draft.phoneId }; }
  private keyOf(draft: EventDraft) { return draft.key === undefined ? undefined : `${draft.phoneId ?? ''}|${draft.key}`; }

  /**
   * Merges transition `draft` into explanation `status` of the same phone and kind.
   * Returns the explanation to keep, or undefined when they do not pair.
   */
  private pair(draft: EventDraft, status: EventDraft): EventDraft | undefined {
    if (draft.phoneId !== status.phoneId || draft.kind !== status.kind || draft.key !== undefined) return undefined;
    if (status.message.includes(draft.message) || draft.pair === 'replace') return status;
    if (draft.pair === 'prefix') return { ...status, message: `${draft.message}. ${status.message}`, tone: status.tone === 'normal' ? draft.tone : status.tone };
    return undefined;
  }

  /** Holds transitions the viewer detected. */
  propose(drafts: EventDraft[], at: number) {
    for (const draft of drafts) {
      // The explanation may already be waiting.
      const explanation = [...this.pending].reverse().find(entry => entry.explains && this.pair(draft, entry.draft));
      if (explanation) { explanation.draft = this.pair(draft, explanation.draft)!; continue; }
      const key = this.keyOf(draft);
      if (key !== undefined) this.pending = this.pending.filter(entry => this.keyOf(entry.draft) !== key);
      // A change a waiting reply does not cover still came first (a validation result before "Validated").
      const before = key === undefined ? this.pending.findIndex(entry => entry.reply && entry.draft.phoneId === draft.phoneId && entry.draft.kind === draft.kind) : -1;
      if (before >= 0) this.pending.splice(before, 0, { draft, at: this.pending[before].at, due: this.pending[before].due, explains: false });
      else this.pending.push({ draft, at, due: at + (draft.settleMs ?? this.holdMs), explains: false });
    }
  }

  /**
   * Holds an explanation, merged with the held transitions of the same phone it
   * explains. `reply` is a gateway reply to an action, rather than a roster change.
   */
  explain(draft: EventDraft, at: number, reply = false) {
    let status = draft;
    this.pending = this.pending.filter(entry => {
      if (entry.explains) return true;
      const merged = this.pair(entry.draft, status); if (!merged) return true;
      status = merged; return false;
    });
    this.pending.push({ draft: status, at, due: at + this.holdMs, explains: true, reply });
  }

  /** Logs `draft` now, after everything held. */
  add(draft: EventDraft, at: number) { this.flush(); this.emit([this.event(draft, at)]); }

  /** Logs held events that are due by `now` (all of them by default). */
  flush(now = Infinity) {
    if (!this.pending.length) return;
    const ready = this.pending.filter(entry => entry.due <= now);
    if (!ready.length) return;
    this.pending = this.pending.filter(entry => entry.due > now);
    this.emit(ready.map(entry => this.event(entry.draft, entry.at)));
  }

  clear() { this.pending = []; }
}
