/** A gateway this viewer connected to, newest first. `url` is the WebSocket URL from `gatewayUrl`. */
export type RecentGateway = { url: string; usedAt: number };

export const RECENT_KEY = 'marionette.viewer.recent';
export const LAST_ADDRESS_KEY = 'marionette.viewer.address';
export const MAX_RECENT = 5;

/** Reads the stored list, ignoring anything malformed. */
export function parseRecent(raw: string | null): RecentGateway[] {
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : []; } catch { return []; }
  if (!Array.isArray(value)) return [];
  const entries = value.filter((entry): entry is RecentGateway => !!entry && typeof entry === 'object'
    && typeof (entry as RecentGateway).url === 'string' && /^wss?:\/\/\S+$/i.test((entry as RecentGateway).url)
    && typeof (entry as RecentGateway).usedAt === 'number' && Number.isFinite((entry as RecentGateway).usedAt));
  return entries.sort((a, b) => b.usedAt - a.usedAt).filter((entry, index, list) => list.findIndex(other => other.url === entry.url) === index).slice(0, MAX_RECENT);
}

/** Moves `url` to the top, keeping at most five. */
export function rememberGateway(list: RecentGateway[], url: string, now: number): RecentGateway[] {
  return [{ url, usedAt: now }, ...list.filter(entry => entry.url !== url)].slice(0, MAX_RECENT);
}

export function relativeTime(then: number, now: number): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Why a WebSocket closed, in words an operator can act on. */
export function closeReason(code: number, reason?: string): string {
  if (reason && reason.trim()) return `${reason.trim()} (code ${code})`;
  if (code === 1000) return 'the gateway closed the connection';
  if (code === 1001) return 'the gateway shut down (code 1001)';
  if (code === 1006) return 'the connection dropped (code 1006)';
  if (code === 1009) return 'a message was too large (code 1009)';
  if (code === 1011) return 'the gateway hit an error (code 1011)';
  return `the connection closed (code ${code})`;
}
