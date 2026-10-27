import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CLOSE_CODES, gatewayLabel } from '@marionette/protocol';
import { closeReason } from './address';
import type { ConsoleEvent } from './events';
import { CODES_KEY, connectPlan, forgetCode, httpUrl, parseCodes, rememberCode, savedCode, withToken, type ConnectPlan, type SavedCodes } from './pairing';
import { rosterPhones } from './phones';
import { RtcViewer } from './rtc';
import { ViewerStore } from './store';

export type Phase = 'idle' | 'connecting' | 'live' | 'sim';
/** The gateway turned the viewer away for its pairing code (close 4401): its reason, and whether a code was sent (typed, or saved). */
export type CodeRequest = { reason: string; sent?: 'typed' | 'saved' };

const MAX_EVENTS = 400;
const CONNECT_TIMEOUT_MS = 8_000;
const READOUT_MS = 80;

function readCodes(): SavedCodes { try { return parseCodes(localStorage.getItem(CODES_KEY)); } catch { return parseCodes(null); } }
function writeCodes(codes: SavedCodes) { try { localStorage.setItem(CODES_KEY, JSON.stringify(codes)); } catch { /* private mode */ } }

/**
 * The viewer's connection to a gateway, or to two simulated phones. The viewer
 * watches: apart from its hello, it only sends pings (for the gateway's clock)
 * and the WebRTC signaling of the camera panes it shows.
 */
export function useGateway(onConnected: (url: string) => void) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [url, setUrl] = useState<string>();
  /** The pairing code of the live connection, for the gateway's HTTP API. */
  const [code, setCode] = useState<string>();
  const [codeRequest, setCodeRequest] = useState<CodeRequest>();
  const [error, setError] = useState<string>();
  const [events, setEvents] = useState<ConsoleEvent[]>([]);
  const [, setReadout] = useState(0);
  const [, setConfigVersion] = useState(0);
  const socket = useRef<WebSocket>();
  const send = useCallback((message: object) => { const ws = socket.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }, []);
  const rtc = useMemo(() => new RtcViewer({ send: message => send({ type: 'rtc', version: 1, ...message }) }), [send]);
  const storeRef = useRef<ViewerStore>();
  // The store replaces its configs on every change, so reading them during render is enough once React re-renders.
  if (!storeRef.current) storeRef.current = new ViewerStore({
    onConfigs: () => setConfigVersion(n => n + 1),
    // Held events can come out a little after newer ones; keep the log in time order.
    onEvents: batch => setEvents(old => [...old, ...batch].sort((a, b) => a.at - b.at || a.id - b.id).slice(-MAX_EVENTS)),
    onRtc: message => rtc.receive(message),
  });
  const store = storeRef.current;
  const { config, phoneConfigs } = store;
  /** Every connect gets the next number; whatever an older one's sockets do afterwards is ignored. */
  const run = useRef(0);
  const attempts = useRef<WebSocket[]>([]);
  const simFrame = useRef<number>();
  const connectedRef = useRef(onConnected); connectedRef.current = onConnected;

  const reset = useCallback(() => { store.reset(); setEvents([]); }, [store]);
  const stop = useCallback(() => {
    run.current++;
    for (const ws of attempts.current) ws.close(); attempts.current = [];
    const ws = socket.current; socket.current = undefined; ws?.close();
    rtc.reset();
    if (simFrame.current !== undefined) cancelAnimationFrame(simFrame.current); simFrame.current = undefined;
  }, [rtc]);

  /**
   * Opens every address of the plan at once; the first that delivers a message is the connection and the others
   * close. When all of them are turned away for the pairing code (4401), the connect page asks for it, unless a code
   * saved for this gateway under another address can be tried first.
   */
  const attempt = useCallback((plan: ConnectPlan, retried: boolean) => {
    const id = ++run.current; const current = () => run.current === id;
    const tries = plan.urls.map(url => {
      let ws: WebSocket | undefined; try { ws = new WebSocket(withToken(url, plan.code)); } catch { /* not a URL this browser opens */ }
      const closed: { code: number; reason: string } | undefined = ws ? undefined : { code: 1006, reason: '' };
      return { url, ws, closed };
    });
    attempts.current = tries.flatMap(t => t.ws ? [t.ws] : []);
    let won = false; let savedUnderId = false;
    const timer = window.setTimeout(() => {
      if (!current() || won) return;
      stop(); setPhase('idle');
      setError(`No answer from ${plan.label} after ${CONNECT_TIMEOUT_MS / 1000} seconds. Check the address and that the gateway is running.`);
    }, CONNECT_TIMEOUT_MS);
    const askForCode = (reason: string) => {
      setPhase('idle'); setError(undefined);
      setCodeRequest({ reason: reason || 'Pairing code required', ...(plan.code ? { sent: plan.saved ? 'saved' : 'typed' } : {}) });
    };
    const settle = () => {
      window.clearTimeout(timer); attempts.current = [];
      const refused = tries.find(t => t.closed?.code === CLOSE_CODES.pairingRequired);
      if (!refused) { setPhase('idle'); setError(`Couldn't reach ${plan.label}. Check the address, the port, and that the gateway is running.`); return; }
      const reason = refused.closed!.reason;
      if (plan.code) {
        // A code turned down is forgotten; one sent while the address is shut out for too many wrong codes may be right.
        if (/^wrong/i.test(reason)) writeCodes(forgetCode(readCodes(), plan.code));
        askForCode(reason); return;
      }
      if (retried) { askForCode(reason); return; }
      // A code saved for this gateway under another address: its open /health says which gateway it is.
      fetch(httpUrl(refused.url, '/health')).then(response => response.json()).then((health: { gatewayId?: unknown }) => typeof health.gatewayId === 'string' ? health.gatewayId : undefined, () => undefined)
        .then(gatewayId => {
          if (!current()) return;
          const saved = savedCode(readCodes(), { gatewayId });
          if (saved) attempt({ ...plan, urls: [refused.url], code: saved, saved: true, gatewayId }, true); else askForCode(reason);
        });
    };
    const win = (t: typeof tries[number], ws: WebSocket) => {
      won = true; window.clearTimeout(timer);
      for (const other of tries) if (other !== t) other.ws?.close();
      attempts.current = []; socket.current = ws;
      reset(); setUrl(t.url); setCode(plan.code); setCodeRequest(undefined); setError(undefined); setPhase('live');
      connectedRef.current(t.url);
      if (plan.code) writeCodes(rememberCode(readCodes(), { url: t.url, gatewayId: plan.gatewayId }, plan.code));
    };
    for (const t of tries) {
      const ws = t.ws; if (!ws) continue;
      // A console that follows no phone sees every phone.
      ws.onopen = () => { if (current()) ws.send(JSON.stringify({ type: 'hello', version: 1, role: 'console' })); };
      ws.onmessage = event => {
        if (!current()) return;
        if (!won) win(t, ws); else if (socket.current !== ws) return;
        let message: unknown; try { message = JSON.parse(String(event.data)); } catch { return; }
        store.receive(message);
        // Once the gateway says who it is, the code is saved under its id too, so its other addresses find it.
        if (plan.code && !savedUnderId && store.config.gatewayId) { savedUnderId = true; writeCodes(rememberCode(readCodes(), { url: t.url, gatewayId: store.config.gatewayId }, plan.code)); }
      };
      ws.onclose = event => {
        if (!current()) return;
        if (won) {
          if (socket.current !== ws) return;
          socket.current = undefined; rtc.reset(); setPhase('idle');
          if (event.code === CLOSE_CODES.pairingRequired) askForCode(event.reason);
          else setError(`Lost connection to ${gatewayLabel(t.url)}: ${closeReason(event.code, event.reason)}.`);
          return;
        }
        t.closed = event;
        if (tries.every(other => other.closed)) settle();
      };
    }
    if (tries.every(t => t.closed)) settle();
  }, [reset, rtc, stop, store]);

  /** Connects to what was typed or pasted (an address or a pairing link), with a typed pairing code if there is one. */
  const connect = useCallback((input: string, typedCode?: string) => {
    const plan = connectPlan(input, typedCode, readCodes());
    if ('error' in plan) { setError(plan.error); return; }
    stop(); setError(undefined); setUrl(plan.urls[0]); setPhase('connecting');
    attempt(plan, false);
  }, [attempt, stop]);

  const simulate = useCallback(() => {
    stop(); setEvents([]); setUrl(undefined); setCode(undefined); setError(undefined); setCodeRequest(undefined);
    store.simulate(); setPhase('sim');
    const loop = () => { store.simulateFrame(); simFrame.current = requestAnimationFrame(loop); };
    simFrame.current = requestAnimationFrame(loop);
  }, [stop, store]);

  const disconnect = useCallback(() => { stop(); setPhase('idle'); setError(undefined); }, [stop]);

  // Readouts refresh at ~12 Hz; this is also where a silent phone times out, held events are logged and pings go out.
  useEffect(() => {
    if (phase !== 'live' && phase !== 'sim') return;
    const id = window.setInterval(() => {
      store.tick(); setReadout(n => n + 1);
      if (phase === 'live') { const ping = store.ping(); if (ping) send(ping); }
    }, READOUT_MS);
    return () => window.clearInterval(id);
  }, [phase, send, store]);
  useEffect(() => stop, [stop]);

  /** A URL on the connected gateway's HTTP API, with the pairing code. */
  const api = useCallback((path: string) => url ? httpUrl(url, path, code) : undefined, [url, code]);
  const phones = useMemo(() => rosterPhones(config.phones, phoneConfigs), [config.phones, phoneConfigs]);
  return { phase, url, error, codeRequest, config, phones, events, store, rtc, api, connect, simulate, disconnect, setError };
}
export type Gateway = ReturnType<typeof useGateway>;
