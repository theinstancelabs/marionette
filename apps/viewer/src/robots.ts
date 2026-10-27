import { staleAfterMs, type JsonValue, type RobotInfo, type RobotStateMessage } from '@marionette/protocol';

/** A robot state as the viewer keeps it: the message, and when it arrived (the viewer's wall clock). */
export type RobotStateEntry = { message: RobotStateMessage; at: number };
/** Retained per robot and phone, like the gateway: `''` is the state for every phone. */
export const stateKey = (robotId: string, phoneId?: string) => `${robotId} ${phoneId ?? ''}`;

/**
 * How old a state is, in ms. With the gateway's clock offset known, from the gateway's `receivedAt`, so a state the
 * gateway replays on connect shows its real age; otherwise from when it reached the viewer.
 */
export function stateAge(entry: RobotStateEntry, wallNow: number, gatewayOffset?: number): number {
  const age = gatewayOffset !== undefined && entry.message.receivedAt !== undefined ? wallNow + gatewayOffset - entry.message.receivedAt : wallNow - entry.at;
  return Math.max(0, age);
}

export type Freshness = 'fresh' | 'stale' | 'offline';
/** Offline when the roster says the robot is gone; stale after `staleAfterMs(everyMs)` without a new state. */
export function freshness(entry: RobotStateEntry, connected: boolean, ageMs: number): Freshness {
  if (!connected) return 'offline';
  return ageMs > staleAfterMs(entry.message.everyMs) ? 'stale' : 'fresh';
}

/** Robots in roster order, then any robot known only from its state (an older roster). */
export function robotList(roster: RobotInfo[] | undefined, states: Iterable<RobotStateEntry>): RobotInfo[] {
  const out = [...roster ?? []]; const known = new Set(out.map(robot => robot.id));
  for (const { message } of states) if (message.robotId && !known.has(message.robotId)) { known.add(message.robotId); out.push({ id: message.robotId, name: message.robotId, connected: false }); }
  return out;
}

/** "head, arm-left" */
export const streamList = (streams: string[] | undefined) => streams?.length ? streams.join(', ') : undefined;

/** A JSON leaf as the inspector prints it: strings quoted, numbers to at most 4 decimals, null as null. */
export function leafText(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}
export type LeafKind = 'null' | 'boolean' | 'number' | 'string';
export const leafKind = (value: JsonValue): LeafKind => value === null ? 'null' : typeof value as LeafKind;
export const isBranch = (value: JsonValue): value is JsonValue[] | { [key: string]: JsonValue } => !!value && typeof value === 'object';

/** A short list of plain values that reads fine on one line, such as joint angles: `[0.12, −0.5, 1.2]`. */
export function inlineArray(value: JsonValue): string | undefined {
  if (!Array.isArray(value) || value.length > 6 || value.some(isBranch)) return undefined;
  const text = `[${value.map(leafText).join(', ')}]`;
  return text.length <= 40 ? text : undefined;
}

/** What a collapsed branch says about itself: "3 keys", "24 items", "empty". */
export function branchSummary(value: JsonValue[] | { [key: string]: JsonValue }): string {
  const n = Array.isArray(value) ? value.length : Object.keys(value).length;
  if (!n) return Array.isArray(value) ? '[ ]' : '{ }';
  return Array.isArray(value) ? `${n} item${n === 1 ? '' : 's'}` : `${n} key${n === 1 ? '' : 's'}`;
}

/** Branches open by default: the top two levels, unless they are long. */
export const openByDefault = (value: JsonValue[] | { [key: string]: JsonValue }, depth: number) => depth < 2 && (Array.isArray(value) ? value.length : Object.keys(value).length) <= 12;
