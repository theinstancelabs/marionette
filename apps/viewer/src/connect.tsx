import { useEffect, useRef, useState } from 'react';
import { gatewayLabel } from '@marionette/protocol';
import { LAST_ADDRESS_KEY, relativeTime, type RecentGateway } from './address';
import type { Gateway } from './gateway';
import { Mark } from './ui';

function storedAddress(): string | undefined { try { return localStorage.getItem(LAST_ADDRESS_KEY) ?? undefined; } catch { return undefined; } }

export function ConnectPage({ gw, recent }: { gw: Gateway; recent: RecentGateway[] }) {
  const [address, setAddress] = useState(() => storedAddress() || (recent[0] ? gatewayLabel(recent[0].url) : 'localhost'));
  const input = useRef<HTMLInputElement>(null);
  const connecting = gw.phase === 'connecting';
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => { if (gw.error) input.current?.focus(); }, [gw.error]);
  const connect = (value: string) => {
    setAddress(value);
    try { localStorage.setItem(LAST_ADDRESS_KEY, value.trim()); } catch { /* private mode */ }
    gw.connect(value);
  };
  const now = Date.now();
  return <main className="connect-page">
    <div className="connect">
      <div className="brand"><Mark size={26} />Marionette</div>
      <h1>Connect to your robot's gateway</h1>
      <p className="help">Use the address the gateway prints when it starts.</p>
      <form noValidate onSubmit={event => { event.preventDefault(); if (!connecting) connect(address); }}>
        <label className="sr-only" htmlFor="address">Gateway address</label>
        <input id="address" ref={input} className={`address mono ${gw.error ? 'invalid' : ''}`} value={address} readOnly={connecting}
          onChange={event => { setAddress(event.target.value); if (gw.error) gw.setError(undefined); }}
          placeholder="192.168.1.20" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          aria-invalid={!!gw.error} aria-describedby={gw.error ? 'address-error address-note' : 'address-note'} />
        {gw.error && <p id="address-error" className="error" role="alert">{gw.error}</p>}
        <p id="address-note" className="hand-note">port 8787 unless you type one</p>
        <button type="submit" className="connect-button" disabled={connecting}>{connecting ? 'Connecting…' : 'Connect'}</button>
        {connecting && <button type="button" className="link cancel" onClick={gw.disconnect}>Cancel</button>}
      </form>
      {recent.length > 0 && <section className="recent" aria-labelledby="recent-title">
        <h2 id="recent-title">Recent</h2>
        <ul>{recent.map(entry => {
          const label = gatewayLabel(entry.url);
          return <li key={entry.url}><button type="button" disabled={connecting} onClick={() => connect(label)}><span className="mono">{label}</span><span className="when">{relativeTime(entry.usedAt, now)}</span></button></li>;
        })}</ul>
      </section>}
      <button type="button" className="link sim-link" onClick={gw.simulate} disabled={connecting}>Watch two simulated phones</button>
    </div>
  </main>;
}
