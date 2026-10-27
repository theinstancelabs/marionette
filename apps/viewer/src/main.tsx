import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { gatewayLabel } from '@marionette/protocol';
import { RECENT_KEY, parseRecent, rememberGateway } from './address';
import { ConnectPage } from './connect';
import { Console } from './console';
import { useGateway } from './gateway';
import './styles.css';

function readRecent() { try { return parseRecent(localStorage.getItem(RECENT_KEY)); } catch { return []; } }

/** Connect page first; the console once a gateway answers, or for two simulated phones. */
function App() {
  const [recent, setRecent] = useState(readRecent);
  const remember = useCallback((url: string) => setRecent(list => {
    const next = rememberGateway(list, url, Date.now());
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  }), []);
  const gw = useGateway(remember);
  const inConsole = gw.phase === 'live' || gw.phase === 'sim';
  useEffect(() => { document.title = gw.phase === 'live' && gw.url ? `${gatewayLabel(gw.url)} · Marionette` : gw.phase === 'sim' ? 'Simulated phones · Marionette' : 'Connect · Marionette'; }, [gw.phase, gw.url]);
  return inConsole ? <Console gw={gw} /> : <ConnectPage gw={gw} recent={recent} />;
}

createRoot(document.getElementById('root')!).render(<App />);
