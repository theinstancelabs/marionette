import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gatewayLabel, gatewayUrl } from '@marionette/protocol';
import { closeReason } from './address';
import type { ConsoleEvent } from './events';
import { rosterPhones } from './phones';
import { ViewerStore } from './store';

export type Phase = 'idle' | 'connecting' | 'live' | 'sim';

const MAX_EVENTS = 400;
const CONNECT_TIMEOUT_MS = 8_000;
const READOUT_MS = 80;

/**
 * The viewer's connection to a gateway, or to two simulated phones. The viewer
 * only listens: apart from its hello, it never sends the gateway anything.
 */
export function useGateway(onConnected: (url: string) => void) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [events, setEvents] = useState<ConsoleEvent[]>([]);
  const [, setReadout] = useState(0);
  const [, setConfigVersion] = useState(0);
  const storeRef = useRef<ViewerStore>();
  // The store replaces its configs on every change, so reading them during render is enough once React re-renders.
  if (!storeRef.current) storeRef.current = new ViewerStore({
    onConfigs: () => setConfigVersion(n => n + 1),
    // Held events can come out a little after newer ones; keep the log in time order.
    onEvents: batch => setEvents(old => [...old, ...batch].sort((a, b) => a.at - b.at || a.id - b.id).slice(-MAX_EVENTS)),
  });
  const store = storeRef.current;
  const { config, phoneConfigs } = store;
  const socket = useRef<WebSocket>();
  const simFrame = useRef<number>();
  const connectedRef = useRef(onConnected); connectedRef.current = onConnected;

  const reset = useCallback(() => { store.reset(); setEvents([]); }, [store]);
  const stop = useCallback(() => {
    const ws = socket.current; socket.current = undefined; ws?.close();
    if (simFrame.current !== undefined) cancelAnimationFrame(simFrame.current); simFrame.current = undefined;
  }, []);

  const connect = useCallback((input: string) => {
    const target = gatewayUrl(input);
    if (!target) { setError(input.trim() ? `“${input.trim()}” is not an address. Type an IP such as 192.168.1.20, a host:port, or a ws:// URL.` : 'Type the gateway address first.'); return; }
    stop(); setUrl(target); setError(undefined); setPhase('connecting');
    const label = gatewayLabel(target);
    let ws: WebSocket;
    try { ws = new WebSocket(target); } catch { setPhase('idle'); setError(`Can't open ${label}. Check the address.`); return; }
    socket.current = ws; let opened = false;
    const timer = window.setTimeout(() => {
      if (socket.current !== ws || opened) return;
      socket.current = undefined; ws.close(); setPhase('idle');
      setError(`No answer from ${label} after ${CONNECT_TIMEOUT_MS / 1000} seconds. Check the address and that the gateway is running.`);
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (socket.current !== ws) return;
      opened = true; window.clearTimeout(timer); reset(); setPhase('live'); connectedRef.current(target);
      // A console that follows no phone sees every phone.
      ws.send(JSON.stringify({ type: 'hello', version: 1, role: 'console' }));
    };
    ws.onclose = event => {
      window.clearTimeout(timer);
      if (socket.current !== ws) return;
      socket.current = undefined; setPhase('idle');
      setError(opened ? `Lost connection to ${label}: ${closeReason(event.code, event.reason)}.` : `Couldn't reach ${label}. Check the address, the port, and that the gateway is running.`);
    };
    ws.onmessage = event => {
      if (socket.current !== ws) return;
      let message: unknown; try { message = JSON.parse(String(event.data)); } catch { return; }
      store.receive(message);
    };
  }, [reset, stop, store]);

  const simulate = useCallback(() => {
    stop(); setEvents([]); setUrl(undefined); setError(undefined);
    store.simulate(); setPhase('sim');
    const loop = () => { store.simulateFrame(); simFrame.current = requestAnimationFrame(loop); };
    simFrame.current = requestAnimationFrame(loop);
  }, [stop, store]);

  const disconnect = useCallback(() => { stop(); setPhase('idle'); setError(undefined); }, [stop]);

  // Readouts refresh at ~12 Hz; this is also where a silent phone times out and held events are logged.
  useEffect(() => {
    if (phase !== 'live' && phase !== 'sim') return;
    const id = window.setInterval(() => { store.tick(); setReadout(n => n + 1); }, READOUT_MS);
    return () => window.clearInterval(id);
  }, [phase, store]);
  useEffect(() => stop, [stop]);

  const phones = useMemo(() => rosterPhones(config.phones, phoneConfigs), [config.phones, phoneConfigs]);
  return { phase, url, error, config, phones, events, store, connect, simulate, disconnect, setError };
}
export type Gateway = ReturnType<typeof useGateway>;
