import { gatewayLabel, gatewayUrl, normalizePairingCode, parsePairingLink } from '@marionette/protocol';

/**
 * Pairing codes this viewer has connected with, by gateway id (`config.gatewayId`, stable across restarts) and by
 * WebSocket URL, so it asks once per gateway, and again only when the gateway's code changes.
 */
export type SavedCodes = { gateways: Record<string, string>; addresses: Record<string, string> };
export const CODES_KEY = 'marionette.viewer.codes';
const MAX_CODES = 32;

const isCode = (value: unknown): value is string => typeof value === 'string' && value.length >= 4 && value.length <= 64 && /^[0-9A-Z]+$/.test(value);
const entries = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([key, code]) => key.length <= 256 && isCode(code)).slice(-MAX_CODES)) : {};

export function parseCodes(raw: string | null): SavedCodes {
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : {}; } catch { return { gateways: {}, addresses: {} }; }
  const v = (value ?? {}) as Partial<SavedCodes>;
  return { gateways: entries(v.gateways), addresses: entries(v.addresses) };
}

/** The code to try for an address: the one that worked there, else the one that worked for that gateway. */
export function savedCode(codes: SavedCodes, where: { url?: string; gatewayId?: string }): string | undefined {
  return (where.url ? codes.addresses[where.url] : undefined) ?? (where.gatewayId ? codes.gateways[where.gatewayId] : undefined);
}

/** Keeps a code that worked, newest last, at most 32 of each. */
export function rememberCode(codes: SavedCodes, where: { url?: string; gatewayId?: string }, code: string): SavedCodes {
  const put = (map: Record<string, string>, key: string | undefined) => {
    if (!key) return map;
    const { [key]: _, ...rest } = map;
    return Object.fromEntries([...Object.entries(rest), [key, normalizePairingCode(code)]].slice(-MAX_CODES));
  };
  return { gateways: put(codes.gateways, where.gatewayId), addresses: put(codes.addresses, where.url) };
}

/** Forgets a code a gateway turned down, wherever it was saved. */
export function forgetCode(codes: SavedCodes, code: string): SavedCodes {
  const wrong = normalizePairingCode(code);
  const drop = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).filter(([, saved]) => saved !== wrong));
  return { gateways: drop(codes.gateways), addresses: drop(codes.addresses) };
}

/** A pairing code as it is being typed: upper case, O/I/L read as 0/1/1, and the dash after four characters of an eight-character code. */
export function typedCode(value: string): string {
  const code = normalizePairingCode(value).replace(/[^0-9A-Z]/g, '').slice(0, 64);
  return code.length > 4 && code.length <= 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * What to connect to for what the operator typed or pasted: one address, or every host of a pairing link (tried
 * at once, the first that answers wins). The code is the one typed, else the link's, else one saved for the address
 * or the link's gateway.
 */
export type ConnectPlan = { urls: string[]; code?: string; saved?: boolean; gatewayId?: string; label: string };
export function connectPlan(input: string, typed: string | undefined, codes: SavedCodes): ConnectPlan | { error: string } {
  const text = input.trim();
  const own = normalizePairingCode(typed ?? '') || undefined;
  const pick = (given: string | undefined, urls: string[], gatewayId?: string) => {
    if (given) return { code: given };
    const saved = urls.map(url => savedCode(codes, { url })).find(Boolean) ?? savedCode(codes, { gatewayId });
    return saved ? { code: saved, saved: true } : {};
  };
  if (/^marionette:/i.test(text)) {
    const link = parsePairingLink(text);
    if (!link) return { error: 'That pairing link is incomplete. Copy the whole marionette://pair?… link the gateway printed.' };
    const urls = [...new Set(link.hosts.map(host => gatewayUrl(`${host}:${link.port}`)).filter((url): url is string => !!url))];
    if (!urls.length) return { error: 'That pairing link has no address this viewer can use.' };
    return { urls, ...pick(own ?? link.code, urls, link.gatewayId), gatewayId: link.gatewayId, label: link.name ?? urls.map(gatewayLabel).join(', ') };
  }
  const url = gatewayUrl(text);
  if (!url) return { error: text ? `“${text}” is not an address. Type an IP such as 192.168.1.20, a host:port, a ws:// URL, or paste a pairing link.` : 'Type the gateway address first.' };
  return { urls: [url], ...pick(own, [url]), label: gatewayLabel(url) };
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
