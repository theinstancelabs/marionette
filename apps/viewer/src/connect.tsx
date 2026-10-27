import { useEffect, useRef, useState } from 'react';
import { gatewayLabel } from '@marionette/protocol';
import { LAST_ADDRESS_KEY, relativeTime, type RecentGateway } from './address';
import type { Gateway } from './gateway';
import { typedCode } from './pairing';
import { Mark } from './ui';

function storedAddress(): string | undefined { try { return localStorage.getItem(LAST_ADDRESS_KEY) ?? undefined; } catch { return undefined; } }
const isLink = (text: string) => /^\s*marionette:/i.test(text);

export function ConnectPage({ gw, recent }: { gw: Gateway; recent: RecentGateway[] }) {
  const [address, setAddress] = useState(() => storedAddress() || (recent[0] ? gatewayLabel(recent[0].url) : 'localhost'));
  const [code, setCode] = useState('');
  const input = useRef<HTMLInputElement>(null); const codeInput = useRef<HTMLInputElement>(null);
  const connecting = gw.phase === 'connecting';
  const asked = gw.codeRequest;
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => { if (gw.error) input.current?.focus(); }, [gw.error]);
  // The gateway asked for its code: that field is where the operator goes next.
  useEffect(() => { if (asked) { codeInput.current?.focus(); codeInput.current?.select(); } }, [asked]);
  const connect = (value: string, withCode = true) => {
    setAddress(value);
    try { localStorage.setItem(LAST_ADDRESS_KEY, value.trim()); } catch { /* private mode */ }
    gw.connect(value, withCode && asked ? code : undefined);
  };
  const codeError = !asked?.sent ? undefined : asked.sent === 'saved' && /^wrong/i.test(asked.reason) ? 'The code saved for this gateway no longer works. Type its current code.' : `${asked.reason}.`;
  const now = Date.now();
  return <main className="connect-page">
    <div className="connect">
      <div className="brand"><Mark size={26} />Marionette</div>
      <h1>Connect to your robot's gateway</h1>
      <p className="help">Use the address the gateway prints when it starts, or paste its pairing link.</p>
      <form noValidate onSubmit={event => { event.preventDefault(); if (!connecting) connect(address); }}>
        <label className="sr-only" htmlFor="address">Gateway address or pairing link</label>
        <input id="address" ref={input} className={`address mono ${gw.error ? 'invalid' : ''}`} value={address} readOnly={connecting}
          onChange={event => { setAddress(event.target.value); if (gw.error) gw.setError(undefined); }}
          placeholder="192.168.1.20" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          aria-invalid={!!gw.error} aria-describedby={gw.error ? 'address-error address-note' : 'address-note'} />
        {gw.error && <p id="address-error" className="error" role="alert">{gw.error}</p>}
        <p id="address-note" className="hand-note">{isLink(address) ? 'every address in the link is tried' : 'port 8787 unless you type one'}</p>
        {asked && <div className="code-field">
          <label htmlFor="code">Pairing code</label>
          <input id="code" ref={codeInput} className={`address mono code ${codeError ? 'invalid' : ''}`} value={code} readOnly={connecting}
            onChange={event => setCode(typedCode(event.target.value))} placeholder="K7Q2-M9XD" maxLength={64}
            autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
            aria-invalid={!!codeError} aria-describedby={codeError ? 'code-error code-help' : 'code-help'} />
          {codeError && <p id="code-error" className="error" role="alert">{codeError}</p>}
          <p id="code-help" className="code-help">This gateway asks for its pairing code. It prints the code when it starts, and the viewer on its computer shows it under <b>Pair a phone</b>. On the gateway's own computer no code is needed: connect to <span className="mono">localhost</span> there.</p>
        </div>}
        <button type="submit" className="connect-button" disabled={connecting}>{connecting ? 'Connecting…' : 'Connect'}</button>
        {connecting && <button type="button" className="link cancel" onClick={gw.disconnect}>Cancel</button>}
      </form>
      {recent.length > 0 && <section className="recent" aria-labelledby="recent-title">
        <h2 id="recent-title">Recent</h2>
        <ul>{recent.map(entry => {
          const label = gatewayLabel(entry.url);
          return <li key={entry.url}><button type="button" disabled={connecting} onClick={() => connect(label, false)}><span className="mono">{label}</span><span className="when">{relativeTime(entry.usedAt, now)}</span></button></li>;
        })}</ul>
      </section>}
      <button type="button" className="link sim-link" onClick={gw.simulate} disabled={connecting}>Watch two simulated phones and a robot</button>
    </div>
  </main>;
}
