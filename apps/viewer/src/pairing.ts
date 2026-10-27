import { gatewayLabel, gatewayUrl, normalizePairingCode, parsePairingLink } from '@marionette/protocol';

/**
 * Pairing codes this viewer has connected with. Per gateway id (`config.gatewayId`, stable across restarts): its code
 * and the addresses (WebSocket URLs) that accepted that very code. Per address: the code that last worked there.
 *
 * A saved code only ever goes back to an address that accepted it. Gateway ids are public (Bonjour, `/health`,
 * pairing links), so an id never sends a code anywhere new: a link or host that merely claims a known id is asked
 * for the code.
 */
export type SavedGateway = { code: string; urls: string[] };
export type SavedCodes = { gateways: Record<string, SavedGateway>; addresses: Record<string, string> };
export const CODES_KEY = 'marionette.viewer.codes';
const MAX_CODES = 32;
const MAX_URLS = 8;

const isCode = (value: unknown): value is string => typeof value === 'string' && value.length >= 4 && value.length <= 64 && /^[0-9A-Z]+$/.test(value);
const isKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const fields = (value: unknown): [string, unknown][] => value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
const isSaved = (value: unknown): value is SavedGateway => {
  const g = value as Partial<SavedGateway> | null | undefined;
  return !!g && typeof g === 'object' && isCode(g.code) && Array.isArray(g.urls) && g.urls.length > 0 && g.urls.length <= MAX_URLS && g.urls.every(isKey);
};
/** The map with `key` set to `value` as its newest entry, at most 32 entries. */
const newest = <T>(map: Record<string, T>, key: string, value: T): Record<string, T> => {
  const { [key]: _, ...rest } = map;
  return Object.fromEntries([...Object.entries(rest), [key, value]].slice(-MAX_CODES));
};

export function parseCodes(raw: string | null): SavedCodes {
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : {}; } catch { return { gateways: {}, addresses: {} }; }
  const v = (value ?? {}) as Record<string, unknown>;
  // Codes saved by id alone (before their addresses were kept) are dropped: nothing says where they may go.
  return {
    gateways: Object.fromEntries(fields(v.gateways).filter((entry): entry is [string, SavedGateway] => isKey(entry[0]) && isSaved(entry[1])).slice(-MAX_CODES)),
    addresses: Object.fromEntries(fields(v.addresses).filter((entry): entry is [string, string] => isKey(entry[0]) && isCode(entry[1])).slice(-MAX_CODES)),
  };
}

/** The code to send to an address, if one was accepted there: its gateway's current code, else the address's own. */
export function savedCode(codes: SavedCodes, url: string): string | undefined {
  return Object.values(codes.gateways).find(gateway => gateway.urls.includes(url))?.code ?? codes.addresses[url];
}

/**
 * Keeps a code an address accepted, newest last, at most 32 of each. With the id of the gateway that answered there,
 * the address joins that gateway's addresses if the code is the gateway's current one. A new code starts its
 * addresses afresh, so a code is never sent to an address that hadn't accepted it.
 */
export function rememberCode(codes: SavedCodes, where: { url: string; gatewayId?: string }, code: string): SavedCodes {
  const accepted = normalizePairingCode(code); const { url, gatewayId } = where;
  // An address belongs to one gateway at a time.
  const gateways = Object.fromEntries(Object.entries(codes.gateways)
    .map(([id, saved]): [string, SavedGateway] => [id, { code: saved.code, urls: saved.urls.filter(other => other !== url) }]).filter(([, saved]) => saved.urls.length));
  const addresses = newest(codes.addresses, url, accepted);
  if (!gatewayId) return { gateways, addresses };
  const kept = gateways[gatewayId]?.code === accepted ? gateways[gatewayId].urls : [];
  return { gateways: newest(gateways, gatewayId, { code: accepted, urls: [...kept, url].slice(-MAX_URLS) }), addresses };
}

/** Forgets a code a gateway turned down, wherever it was saved. */
export function forgetCode(codes: SavedCodes, code: string): SavedCodes {
  const wrong = normalizePairingCode(code);
  return { gateways: Object.fromEntries(Object.entries(codes.gateways).filter(([, saved]) => saved.code !== wrong)),
    addresses: Object.fromEntries(Object.entries(codes.addresses).filter(([, saved]) => saved !== wrong)) };
}

/** A pairing code as it is being typed: upper case, O/I/L read as 0/1/1, and the dash after four characters of an eight-character code. */
export function typedCode(value: string): string {
  const code = normalizePairingCode(value).replace(/[^0-9A-Z]/g, '').slice(0, 64);
  return code.length > 4 && code.length <= 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * What to connect to for what the operator typed or pasted: one address, or every host of a pairing link (tried
 * at once, the first gateway to answer wins). A code typed, else the link's, goes to every address (`code`).
 * Otherwise each address gets the code saved for it, if any (`saved`): a code saved for another address, or for the
 * gateway the link names, isn't sent. A link's `gatewayId` is checked against the gateway that answers (`answeredBy`).
 */
export type ConnectPlan = { urls: string[]; code?: string; saved?: Record<string, string>; gatewayId?: string; label: string };
export function connectPlan(input: string, typed: string | undefined, codes: SavedCodes): ConnectPlan | { error: string } {
  const text = input.trim();
  const own = normalizePairingCode(typed ?? '') || undefined;
  const pick = (given: string | undefined, urls: string[]) => {
    if (given) return { code: given };
    const saved = Object.fromEntries(urls.flatMap(url => { const code = savedCode(codes, url); return code ? [[url, code] as const] : []; }));
    return Object.keys(saved).length ? { saved } : {};
  };
  if (/^marionette:/i.test(text)) {
    const link = parsePairingLink(text);
    if (!link) return { error: 'That pairing link is incomplete. Copy the whole marionette://pair?… link the gateway printed.' };
    const urls = [...new Set(link.hosts.map(host => gatewayUrl(`${host}:${link.port}`)).filter((url): url is string => !!url))];
    if (!urls.length) return { error: 'That pairing link has no address this viewer can use.' };
    return { urls, ...pick(own ?? link.code, urls), ...(link.gatewayId ? { gatewayId: link.gatewayId } : {}), label: link.name ?? urls.map(gatewayLabel).join(', ') };
  }
  const url = gatewayUrl(text);
  if (!url) return { error: text ? `“${text}” is not an address. Type an IP such as 192.168.1.20, a host:port, a ws:// URL, or paste a pairing link.` : 'Type the gateway address first.' };
  return { urls: [url], ...pick(own, [url]), label: gatewayLabel(url) };
}

/** The code a plan sends to one of its addresses, and whether it is a saved one. */
export function planCode(plan: ConnectPlan, url: string): { code?: string; saved?: boolean } {
  if (plan.code) return { code: plan.code };
  const saved = plan.saved?.[url];
  return saved ? { code: saved, saved: true } : {};
}

/** For a config from a gateway, the id it gives (if a sensible one); undefined for any other message. */
export function configFrom(message: unknown): { gatewayId?: string } | undefined {
  if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'config') return undefined;
  const id = (message as { gatewayId?: unknown }).gatewayId;
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? { gatewayId: id } : {};
}

/**
 * Whether the gateway that answered at `url` (its config's `gatewayId`) is the one a pairing link names. A host that
 * answers as another gateway, or as none, isn't used and no code is saved for it. The error to show, or undefined.
 */
export function answeredBy(plan: ConnectPlan, url: string, gatewayId: string | undefined): string | undefined {
  if (!plan.gatewayId || gatewayId === plan.gatewayId) return undefined;
  return `${gatewayLabel(url)} answered as ${gatewayId ? `another gateway (${gatewayId})` : 'a gateway without an id'}, not the one in the pairing link (${plan.gatewayId}). Check the link, or type that address to connect to it anyway.`;
}

/** The WebSocket URL with the pairing code as `?token=`. */
export function withToken(url: string, code: string | undefined): string {
  return code ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(normalizePairingCode(code))}` : url;
}

/** An HTTP URL on the gateway a WebSocket URL points at (`ws://h:p/ws` → `http://h:p/api/pairing`), with the code as `?token=`. */
export function httpUrl(wsUrl: string, path: string, code?: string): string {
  const match = /^(wss?):\/\/([^/?#]+)/i.exec(wsUrl);
  const base = match ? `${match[1].toLowerCase() === 'wss' ? 'https' : 'http'}://${match[2]}` : '';
  return code ? `${base}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(normalizePairingCode(code))}` : `${base}${path}`;
}

/** What `GET /api/pairing` answers. `code` is absent when pairing is off. */
export type PairingInfo = { gatewayId: string; name: string; auth: 'off' | 'on' | 'strict'; code?: string; addresses: string[]; port: number; url: string; qrSvg: string };
export function isPairingInfo(value: unknown): value is PairingInfo {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<PairingInfo>;
  return typeof p.gatewayId === 'string' && typeof p.name === 'string' && (p.code === undefined || typeof p.code === 'string')
    && Array.isArray(p.addresses) && p.addresses.every(address => typeof address === 'string') && Number.isInteger(p.port)
    && typeof p.url === 'string' && typeof p.qrSvg === 'string' && p.qrSvg.trimStart().startsWith('<');
}
