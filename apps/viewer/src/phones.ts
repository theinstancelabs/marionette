import { EXTRA_PHONE_COLOR, type ConfigMessage, type PhoneInfo, type UiControl } from '@marionette/protocol';
import type { PhoneState } from './events';
import { TRACKING_WORDS } from './motion';

/** A phone as the viewer shows it: its roster entry, plus its own config once the gateway sent it. */
export type Phone = { id: string; name: string; color: string; connected: boolean; config?: ConfigMessage };

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** A phone's identity color, or graphite when the gateway sent something that is not a hex color. */
export function safeColor(color: string | undefined): string { return color && HEX.test(color) ? color : EXTRA_PHONE_COLOR; }

/** Roster order comes from the gateway config; a phone known only from its own config goes last. */
export function rosterPhones(roster: PhoneInfo[], configs: Record<string, ConfigMessage>): Phone[] {
  const out: Phone[] = []; const seen = new Set<string>();
  const add = (info: PhoneInfo) => { if (seen.has(info.id)) return; seen.add(info.id); out.push({ id: info.id, name: info.name, color: safeColor(info.color), connected: info.connected, config: configs[info.id] }); };
  roster.forEach(add);
  for (const config of Object.values(configs)) if (config.phone) add(config.phone);
  return out;
}

export const controlFor = (config: Pick<ConfigMessage, 'controls'> | undefined, action: string): UiControl | undefined => config?.controls.find(control => control.action === action);
const lowerFirst = (text: string) => text ? text[0].toLowerCase() + text.slice(1) : text;

/** The arm a phone has selected (`left`, `right`, or a custom value) and how to say it ("left arm"). */
export function armOf(config?: Pick<ConfigMessage, 'controls'>): { value: string; label: string } | undefined {
  const control = controlFor(config, 'arm.select');
  if (control?.type !== 'select') return undefined;
  const option = control.options.find(candidate => candidate.value === control.value);
  return { value: control.value, label: lowerFirst(option?.label ?? control.value) };
}

/** Whether this phone's Stop is on. It is that phone's signal only; the consumer decides what it means. */
export function stopOn(config?: Pick<ConfigMessage, 'controls'>): boolean {
  const control = controlFor(config, 'safety.estop');
  return control?.type === 'toggle' && control.value;
}

/** Hold buttons the gateway says this phone is holding. */
export function heldControls(config?: Pick<ConfigMessage, 'controls'>): UiControl[] {
  return config?.controls.filter(control => control.type === 'button' && control.hold && control.held) ?? [];
}

/** "Phone 1, left arm" */
export function stationName(phone: Pick<Phone, 'name' | 'config'>): string {
  const arm = armOf(phone.config);
  return arm ? `${phone.name}, ${arm.label}` : phone.name;
}

export type PhoneDetail = { arm?: string; state?: string; warn: boolean; stop: boolean };
/**
 * The muted detail after a phone's name in the top bar: its arm, then the one
 * state that matters most right now. Stop is reported separately so it can be red.
 */
export function phoneDetail(phone: Phone, presence: PhoneState): PhoneDetail {
  const stop = stopOn(phone.config); const arm = armOf(phone.config)?.label;
  if (!phone.connected) return { arm, state: 'disconnected', warn: false, stop };
  if (!presence.present) return { arm, state: 'no pose', warn: true, stop };
  if (presence.tracking && presence.tracking !== 'normal') return { arm, state: lowerFirst(TRACKING_WORDS[presence.tracking]), warn: true, stop };
  if (heldControls(phone.config).length) return { arm, state: 'holding', warn: false, stop };
  const c = phone.config?.calibration;
  if (c?.status === 'capturing') return { arm, state: 'calibrating', warn: false, stop };
  if (c?.status === 'captured' && c.check?.step) return { arm, state: 'validating', warn: false, stop };
  return { arm, warn: false, stop };
}

/** How far apart the left- and right-arm stations are drawn from the centre, metres. */
export const STATION_OFFSET_M = 0.25;
/** Spacing between neighbouring stations, metres. */
export const STATION_SPACING_M = 2 * STATION_OFFSET_M;
export type Layout = 'side' | 'overlay';

/**
 * Where each phone's origin is drawn, as a +Y (left) offset in metres. Side by
 * side, a left-arm phone sits 25 cm to the left and a right-arm phone 25 cm to
 * the right; a second phone on the same arm goes one more spacing out. Phones
 * without a left/right arm take the free places nearest the centre in roster
 * order, or, when no phone has an arm, spread evenly about the centre. Overlay
 * draws every origin at the centre.
 */
export function stationOffsets(phones: { id: string; arm?: string }[], layout: Layout): Map<string, number> {
  const out = new Map<string, number>();
  if (layout === 'overlay') { for (const phone of phones) out.set(phone.id, 0); return out; }
  const sided = phones.filter(phone => phone.arm === 'left' || phone.arm === 'right');
  if (!sided.length) {
    phones.forEach((phone, index) => out.set(phone.id, ((phones.length - 1) / 2 - index) * STATION_SPACING_M));
    return out;
  }
  // Slot k > 0 is the k-th place to the left, k < 0 the k-th to the right.
  const taken = new Set<number>();
  const claim = (id: string, order: (n: number) => number) => {
    let k = 0; for (let n = 0; ; n++) { k = order(n); if (!taken.has(k)) break; }
    taken.add(k); out.set(id, Math.sign(k) * (Math.abs(k) * STATION_SPACING_M - STATION_OFFSET_M));
  };
  for (const phone of sided) claim(phone.id, phone.arm === 'left' ? n => n + 1 : n => -(n + 1));
  for (const phone of phones) if (!out.has(phone.id)) claim(phone.id, n => n % 2 === 0 ? n / 2 + 1 : -((n + 1) / 2));
  return out;
}
