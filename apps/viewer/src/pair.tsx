import { type RefObject, useEffect, useRef, useState } from 'react';
import { isPairingInfo, type PairingInfo } from './pairing';

type Loaded = { status: 'loading' } | { status: 'ready'; info: PairingInfo } | { status: 'error'; message: string };

/** The gateway's answer to `/api/pairing`, asked again each time the panel opens (the addresses can change). */
function usePairing(open: boolean, url: string | undefined): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  useEffect(() => {
    if (!open) return;
    if (!url) { setLoaded({ status: 'error', message: 'Connect to a gateway first.' }); return; }
    const controller = new AbortController(); setLoaded({ status: 'loading' });
    fetch(url, { signal: controller.signal }).then(async response => {
      if (response.status === 401) throw new Error('The gateway wants its pairing code for this. Disconnect and connect again with the code.');
      if (response.status === 404) throw new Error('This gateway is too old to pair phones with a QR code. Update it, or type its address on the phone.');
      if (!response.ok) throw new Error(`The gateway answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`);
      const body: unknown = await response.json();
      if (!isPairingInfo(body)) throw new Error('The gateway sent pairing details this viewer does not understand.');
      setLoaded({ status: 'ready', info: body });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoaded({ status: 'error', message: error instanceof TypeError ? 'Couldn’t ask the gateway for its pairing details. Check that it is still running.' : error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [open, url]);
  return loaded;
}

/** Copies text, or selects it for ⌘C where the clipboard is not available (a page not on localhost or https). */
function CopyButton({ text, target, label }: { text: string; target: RefObject<HTMLElement>; label: string }) {
  const [done, setDone] = useState<string>();
  useEffect(() => { if (!done) return; const id = window.setTimeout(() => setDone(undefined), 1800); return () => window.clearTimeout(id); }, [done]);
  const select = () => { const el = target.current; if (!el) return; const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range); setDone('Selected, press ⌘C'); };
  const copy = () => { if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => setDone('Copied'), select); else select(); };
  return <button type="button" className="btn" onClick={copy}>{done ?? label}</button>;
}

/**
 * Pair a phone: the gateway's QR code (its pairing link), its code and its addresses, with how to use them from the
 * iPhone. Gateways with pairing off have no code; the QR code still carries every address.
 */
export function PairDialog({ open, onClose, url }: { open: boolean; onClose: () => void; url: string | undefined }) {
  const dialog = useRef<HTMLDialogElement>(null); const code = useRef<HTMLElement>(null); const link = useRef<HTMLElement>(null);
  const loaded = usePairing(open, url);
  useEffect(() => { const el = dialog.current; if (!el) return; if (open && !el.open) el.showModal(); else if (!open && el.open) el.close(); }, [open]);
  const info = loaded.status === 'ready' ? loaded.info : undefined;
  const qr = info ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(info.qrSvg)}` : undefined;
  return <dialog ref={dialog} className="pair-dialog" aria-labelledby="pair-title" onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="pair">
      <header className="pair-head">
        <h2 id="pair-title">Pair a phone</h2>
        <button type="button" className="btn ghost" onClick={onClose}>Close</button>
      </header>
      {loaded.status === 'loading' && <p className="empty pair-wait">Asking the gateway…</p>}
      {loaded.status === 'error' && <p className="pair-error" role="alert">{loaded.message}</p>}
      {info && <>
        <div className="pair-body">
          {/* An image, never inline markup: the SVG comes from the gateway. */}
          <img className="pair-qr" src={qr} alt={`QR code of the pairing link for ${info.name}`} width={216} height={216} />
          <div className="pair-info">
            <p className="pair-how">Scan it with the iPhone's Camera or with <b>Scan QR code</b> in the app. Or pick <b>{info.name}</b> under <b>Nearby</b> in the app{info.code ? ' and type the code' : ''}.</p>
            {info.code ? <div className="pair-code-row">
              <small>Pairing code</small>
              <div><b ref={code} className="pair-code mono">{info.code}</b><CopyButton text={info.code} target={code} label="Copy" /></div>
              <p className="pair-note">{info.auth === 'strict' ? 'Every client needs it, on this computer too.' : 'Phones need it; clients on the gateway’s own computer don’t.'}</p>
            </div> : <p className="pair-note pair-off">Pairing is off on this gateway: phones connect without a code.</p>}
            <small>Addresses</small>
            <ul className="pair-addresses mono">{info.addresses.map(address => <li key={address}>{address}:{info.port}</li>)}</ul>
          </div>
        </div>
        <div className="pair-link">
          <small>Pairing link</small>
          <div><code ref={link} className="mono">{info.url}</code><CopyButton text={info.url} target={link} label="Copy link" /></div>
        </div>
      </>}
    </div>
  </dialog>;
}
