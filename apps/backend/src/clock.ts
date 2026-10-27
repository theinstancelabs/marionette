import { PROTOCOL_VERSION, linkQuality, type PingMessage, type PongMessage } from '@marionette/protocol';

let origin = performance.timeOrigin;
/**
 * Wall-clock milliseconds with sub-millisecond resolution: the monotonic clock, anchored to the system clock. It
 * re-anchors when the two part by more than a few milliseconds (the computer slept, or its clock was set), so the
 * stamps stay comparable with other machines' wall clocks.
 */
export function wallClock(): number {
  const elapsed = performance.now(); const drift = Date.now() - (origin + elapsed);
  if (drift > 5 || drift < -5) origin += drift;
  return origin + elapsed;
}
const round = (ms: number) => Math.round(ms * 100) / 100;
/** The gateway's receive stamp, to 0.01 ms. */
export const stamp = () => round(wallClock());

const SAMPLES = 16;
/** The gateway's measurements of one client: pings in flight, and the last 16 round trips with the clock offset each implies. */
export type Link = { nextId: number; inFlight: Map<number, number>; samples: { rttMs: number; offsetMs: number }[]; rttMs?: number };
export const newLink = (): Link => ({ nextId: 0, inFlight: new Map(), samples: [] });

/** The next ping to this client, carrying the round trip last measured to it. */
export function ping(link: Link): PingMessage {
  const id = ++link.nextId; const sentAt = wallClock(); link.inFlight.set(id, sentAt);
  if (link.inFlight.size > SAMPLES) link.inFlight.delete(link.inFlight.keys().next().value as number);
  return { type: 'ping', version: PROTOCOL_VERSION, id, sentAt, ...(link.rttMs !== undefined ? { rttMs: round(link.rttMs) } : {}) };
}
/** Records the answer to one of our pings. The client's `at` is its clock at about the middle of the round trip (NTP style). */
export function pong(link: Link, message: PongMessage, receivedAt = wallClock()): void {
  const sentAt = link.inFlight.get(message.id); if (sentAt === undefined) return;
  link.inFlight.delete(message.id); const rttMs = receivedAt - sentAt;
  link.rttMs = rttMs; link.samples.push({ rttMs, offsetMs: message.at - (sentAt + rttMs / 2) });
  if (link.samples.length > SAMPLES) link.samples.shift();
}
/** The client's clock minus the gateway's, from the sample with the lowest round trip; undefined until a pong. */
export function offset(link: Link): number | undefined {
  return link.samples.length ? link.samples.reduce((best, sample) => sample.rttMs < best.rttMs ? sample : best).offsetMs : undefined;
}
/** From the client sending (`sentAt`, its clock) to the gateway receiving (`receivedAt`, the gateway's), once the offset is known. */
export function latency(link: Link, sentAt: number | undefined, receivedAt: number): number | undefined {
  const known = offset(link); if (known === undefined || sentAt === undefined) return undefined;
  return Math.max(0, round(receivedAt - (sentAt - known)));
}
/** What `/api/state` shows of a client's link. */
export function describeLink(link?: Link) {
  const known = link ? offset(link) : undefined;
  return { rttMs: link?.rttMs === undefined ? undefined : round(link.rttMs), quality: linkQuality(link?.rttMs), offsetKnown: known !== undefined, offsetMs: known === undefined ? undefined : round(known), samples: link?.samples.length ?? 0 };
}
