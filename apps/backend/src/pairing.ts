import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Bonjour from 'bonjour-service';
import QRCode from 'qrcode';
import { PAIRING_ALPHABET, formatPairingCode, normalizePairingCode, pairingLink } from '@marionette/protocol';

/** `on`: clients on this computer need no code, everyone else does. `strict`: everyone does. `off`: nobody does. */
export type AuthMode = 'off' | 'on' | 'strict';
export function authMode(value: string | undefined): AuthMode {
  const mode = (value ?? 'on').trim().toLowerCase();
  if (mode === 'off' || mode === 'on' || mode === 'strict') return mode;
  throw new Error(`MARIONETTE_AUTH must be off, on or strict, not "${value}"`);
}

/** The gateway's stable id and its pairing code, kept in `<home>/gateway.json` so phones can remember both across restarts. */
export type Identity = { id: string; token: string };
const pick = (alphabet: string, length: number) => Array.from({ length }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
export function loadIdentity(home: string, warn: (message: string) => void): Identity {
  const file = path.join(home, 'gateway.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Identity>;
    const token = typeof saved.token === 'string' ? normalizePairingCode(saved.token) : '';
    if (typeof saved.id === 'string' && /^gw-[a-z0-9-]{1,61}$/.test(saved.id) && token.length >= 4 && token.length <= 64) return { id: saved.id, token };
  } catch { /* missing or unreadable: make a new one */ }
  const identity = { id: `gw-${pick(PAIRING_ALPHABET.toLowerCase(), 10)}`, token: pick(PAIRING_ALPHABET, 8) };
  try { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 }); }
  catch (error) { warn(`could not save ${file} (${(error as Error).message}); this gateway gets a new id and pairing code each start`); }
  return identity;
}
/** A code as typed (any case, dashes, spaces) against the gateway's, in constant time. */
export function sameCode(given: string | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(normalizePairingCode(given)); const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const isLoopback = (address: string | undefined) => !!address && (address === '::1' || /^(::ffff:)?127\./.test(address));

/** Five wrong codes in a minute from one address shut it out for a minute. */
export function createLimiter(limit = 5, windowMs = 60_000) {
  const misses = new Map<string, number[]>(); const shut = new Map<string, number>();
  return {
    blocked(address: string): boolean { const until = shut.get(address); if (until === undefined) return false; if (Date.now() < until) return true; shut.delete(address); return false; },
    /** Counts a wrong code; true when it shuts the address out. */
    miss(address: string): boolean {
      const now = Date.now(); const recent = (misses.get(address) ?? []).filter(at => now - at < windowMs); recent.push(now);
      if (misses.size > 1024) for (const [other, times] of misses) if (times.every(at => now - at >= windowMs)) misses.delete(other);
      if (recent.length < limit) { misses.set(address, recent); return false; }
      misses.delete(address); shut.set(address, now + windowMs); return true;
    },
  };
}

/**
 * Where phones can reach this computer: its IPv4 addresses that are not loopback or link-local, on the LAN first
 * and the tailnet (100.64/10) next. `MARIONETTE_ADDRESSES` (comma-separated) replaces the list.
 */
export function advertisedAddresses(override = process.env.MARIONETTE_ADDRESSES): string[] {
  if (override?.trim()) return override.split(',').map(host => host.trim()).filter(Boolean);
  const rank = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? 0 : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ? 1 : 2;
  const all = Object.values(os.networkInterfaces()).flat().filter(entry => !!entry && (entry.family === 'IPv4' || (entry.family as unknown) === 4) && !entry.internal && !entry.address.startsWith('169.254.'));
  return [...new Set(all.map(entry => entry!.address))].sort((a, b) => rank(a) - rank(b));
}

export type Pairing = { gatewayId: string; name: string; auth: AuthMode; code?: string; addresses: string[]; port: number; url: string };
export function pairing(identity: Identity, name: string, auth: AuthMode, addresses: string[], port: number): Pairing {
  const hosts = addresses.length ? addresses : [`${os.hostname().replace(/\.local$/i, '')}.local`];
  const code = auth === 'off' ? undefined : identity.token;
  return { gatewayId: identity.id, name, auth, ...(code ? { code: formatPairingCode(code) } : {}), addresses: hosts, port, url: pairingLink({ hosts, port, code, gatewayId: identity.id, name }) };
}
export const qrSvg = (url: string) => QRCode.toString(url, { type: 'svg', margin: 1 });
/** What the gateway prints on start: the code, the link and a QR code a phone's camera can scan. */
export async function pairingBanner(info: Pairing): Promise<string> {
  const how = info.auth === 'off' ? 'Pairing is off (MARIONETTE_AUTH=off): anyone who can reach this computer can connect.'
    : `Pairing code: ${info.code}  (${info.auth === 'strict' ? 'every client needs it' : 'phones need it; clients on this computer do not'})`;
  return `${how}\nPairing link: ${info.url}\n${await QRCode.toString(info.url, { type: 'terminal', small: true })}`;
}

/** Advertises `_marionette._tcp` over Bonjour so the app can list the gateway under Nearby. Returns the stop function. */
export function advertise(info: { name: string; port: number; gatewayId: string; auth: boolean }, warn: (message: string) => void): () => void {
  try {
    const bonjour = new Bonjour(undefined, (error: Error) => warn(`Bonjour: ${error.message}`));
    const name = info.name.slice(0, 63);
    // The service points at `<host>.local`, which this advertiser answers for itself: a bare host name doesn't resolve over mDNS.
    const host = `${os.hostname().split('.')[0] || 'marionette'}.local`;
    const service = bonjour.publish({ name, type: 'marionette', protocol: 'tcp', port: info.port, host, txt: { id: info.gatewayId, name, v: '1', auth: info.auth ? '1' : '0' } });
    service.on('error', (error: Error) => warn(`Bonjour: ${error.message}`));
    return () => bonjour.unpublishAll(() => bonjour.destroy());
  } catch (error) { warn(`Bonjour advertisement failed: ${(error as Error).message}`); return () => {}; }
}
