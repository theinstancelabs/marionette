import { PROTOCOL_VERSION, type PingMessage, type PongMessage } from '@marionette/protocol';

const now = () => globalThis.performance?.now?.() ?? Date.now();
let origin = (globalThis.performance?.timeOrigin ?? Date.now()) || Date.now() - now();
/**
 * Wall-clock milliseconds with sub-millisecond resolution, the way the gateway stamps: the monotonic clock anchored
 * to the system clock, re-anchored when the two part by more than 5 ms (the computer slept, or its clock was set).
 */
export function wallClock(): number {
  const elapsed = now(); const drift = Date.now() - (origin + elapsed);
  if (drift > 5 || drift < -5) origin += drift;
  return origin + elapsed;
}
/** A monotonic clock in milliseconds, for timeouts. */
export const monotonic = (): number => now();

const SAMPLES = 16;
/**
 * Measures the round trip to the gateway and our clock's offset from it, from our pings and its pongs (NTP style,
 * like the gateway does for phones): of the last 16 round trips the fastest gives the offset.
 */
export class ClockSync {
  private nextId = 0;
  private readonly inFlight = new Map<number, number>();
  private samples: { rttMs: number; offsetMs: number }[] = [];
  /** The last round trip measured, in ms. */
  rttMs?: number;

  /** The next ping to send. */
  ping(): PingMessage {
    const id = ++this.nextId; const sentAt = wallClock(); this.inFlight.set(id, sentAt);
    if (this.inFlight.size > SAMPLES) this.inFlight.delete(this.inFlight.keys().next().value as number);
    return { type: 'ping', version: PROTOCOL_VERSION, id, sentAt };
  }
  /** Records the gateway's answer to one of our pings; false if it answers none in flight. */
  pong(message: PongMessage, receivedAt = wallClock()): boolean {
    const sentAt = this.inFlight.get(message.id); if (sentAt === undefined) return false;
    this.inFlight.delete(message.id); const rttMs = receivedAt - sentAt;
    this.rttMs = rttMs; this.samples.push({ rttMs, offsetMs: sentAt + rttMs / 2 - message.at });
    if (this.samples.length > SAMPLES) this.samples.shift();
    return true;
  }
  /** Our clock minus the gateway's, in ms (the gateway's convention); undefined until the first pong. */
  get offsetMs(): number | undefined {
    return this.samples.length ? this.samples.reduce((best, sample) => sample.rttMs < best.rttMs ? sample : best).offsetMs : undefined;
  }
  reset(): void { this.inFlight.clear(); this.samples = []; this.rttMs = undefined; }
}
