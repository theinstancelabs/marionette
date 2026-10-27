import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createServer, type GatewayOptions } from '@marionette/backend/server';

export type StartGatewayOptions = GatewayOptions & {
  /** The port to listen on (default: a free one). */
  port?: number;
  /** The address to listen on (default 127.0.0.1). */
  host?: string;
};
export type TestGateway = {
  /** `ws://127.0.0.1:<port>/ws`, for clients. */
  readonly url: string;
  readonly port: number;
  /** `http://127.0.0.1:<port>`, for the HTTP API. */
  readonly http: string;
  /** The gateway's home (its identity file), a temporary directory unless given. */
  readonly home: string;
  /** The running gateway (`createServer`'s result): its state, its HTTP server. */
  readonly gateway: ReturnType<typeof createServer>;
  /** `GET /api/state`. */
  state(): Promise<any>;
  /** Stops the gateway and starts a new one on the same port and home: the same gateway id, a new session, new phone ids. */
  restart(): Promise<void>;
  close(): Promise<void>;
};

async function listen(gateway: ReturnType<typeof createServer>, port: number, host: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { gateway.server.off('listening', listening); reject(error); };
        const listening = () => { gateway.server.off('error', failed); resolve(); };
        gateway.server.once('error', failed); gateway.server.once('listening', listening); gateway.server.listen(port, host);
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 20) { await gateway.close(); throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

/**
 * Runs the real gateway in this process for tests: pairing off, no Bonjour, a temporary home, a free port. Options
 * are the gateway's own (`createServer`), so a test can turn pairing on (`auth: 'strict', token`) or shorten timeouts.
 */
export async function startGateway(options: StartGatewayOptions = {}): Promise<TestGateway> {
  const { port: wanted = 0, host = '127.0.0.1', ...gatewayOptions } = options;
  const ownHome = options.home === undefined;
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'marionette-gateway-'));
  const make = async (port: number) => { const created = createServer(port, { auth: 'off', mdns: false, ...gatewayOptions, home }); await listen(created, port, host); return created; };
  let current = await make(wanted);
  const port = (current.server.address() as AddressInfo).port;
  const http = `http://${host}:${port}`;
  let closed = false;
  return {
    url: `ws://${host}:${port}/ws`, port, http, home,
    get gateway() { return current; },
    state: () => fetch(`${http}/api/state`).then(response => response.json()),
    restart: async () => { await current.close(); current = await make(port); },
    close: async () => { if (closed) return; closed = true; await current.close(); if (ownHome) fs.rmSync(home, { recursive: true, force: true }); },
  };
}
