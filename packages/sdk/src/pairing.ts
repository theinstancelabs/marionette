import { normalizePairingCode, parsePairingLink } from '@marionette/protocol';
import { resolveAddress } from './client.js';

/** What a gateway's `GET /api/pairing` answers: its id and name, its pairing mode, its code (`K7Q2-M9XD`; absent when pairing is off), the addresses and port its link lists, the pairing link, and the link's QR code as SVG. */
export type Pairing = { gatewayId: string; name: string; auth: 'off' | 'on' | 'strict'; code?: string; addresses: string[]; port: number; url: string; qrSvg: string };

/** The pairing details couldn't be read. The message is a sentence for an operator; `status` is the gateway's HTTP status (401: it needs the code, or refused it; 404: it is too old to pair phones), or undefined when no host answered or the answer wasn't understood. */
export class PairingError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'PairingError'; }
}

/** The gateway's answer, checked: the link must be a pairing link and the QR code an SVG (a page can then show it as an image). */
export function parsePairing(body: unknown): Pairing {
  const p = (body && typeof body === 'object' ? body : {}) as Partial<Record<keyof Pairing, unknown>>;
  if (typeof p.gatewayId !== 'string' || typeof p.name !== 'string' || !['off', 'on', 'strict'].includes(p.auth as string)
    || (p.code !== undefined && typeof p.code !== 'string') || !Array.isArray(p.addresses) || !p.addresses.every(a => typeof a === 'string')
    || !Number.isInteger(p.port) || typeof p.url !== 'string' || !parsePairingLink(p.url) || typeof p.qrSvg !== 'string' || !p.qrSvg.trimStart().startsWith('<svg'))
    throw new PairingError("The gateway's pairing details weren't understood.");
  return { gatewayId: p.gatewayId, name: p.name, auth: p.auth as Pairing['auth'], ...(p.code ? { code: p.code } : {}), addresses: p.addresses, port: p.port as number, url: p.url, qrSvg: p.qrSvg };
}

/**
 * The pairing details of the gateway at `address`, for a robot or page that shows the gateway's QR code. The address takes the same forms as
 * `GatewayClient`; a pairing link's hosts are tried in turn and its code is sent unless `token` is given. The gateway answers its own computer
 * without the code unless pairing is strict. `timeoutMs` (2000) is per host. Rejects with a `PairingError`.
 */
export async function fetchPairing(address: string, options: { token?: string; timeoutMs?: number } = {}): Promise<Pairing> {
  let target: ReturnType<typeof resolveAddress>;
  try { target = resolveAddress(address); } catch (error) { throw new PairingError((error as Error).message); }
  const code = options.token ?? target.token;
  let failure = new PairingError(`Can't reach the gateway at ${address}.`);
  for (const url of target.urls) {
    const http = url.replace(/^ws(s?):\/\/([^/?#]+).*$/i, (_, secure: string, host: string) => `http${secure}://${host}/api/pairing`);
    let response: Response;
    try {
      response = await fetch(http, { headers: { Accept: 'application/json', ...(code ? { Authorization: `Bearer ${normalizePairingCode(code)}` } : {}) }, signal: AbortSignal.timeout(options.timeoutMs ?? 2000) });
    } catch { continue; } // the next of a pairing link's hosts, if any
    if (response.status === 401) throw new PairingError(code ? `The gateway at ${address} refused the pairing code: check it, or wait a minute after several wrong ones.`
      : `The gateway at ${address} needs its pairing code: give its pairing link, which carries it.`, 401);
    if (response.status === 404) throw new PairingError(`The gateway at ${address} is too old to pair phones: update Marionette.`, 404);
    if (!response.ok) { failure = new PairingError(`The gateway at ${address} answered with an error (${response.status}).`, response.status); continue; }
    let body: unknown;
    try { body = await response.json(); } catch { continue; }
    return parsePairing(body);
  }
  throw failure;
}
