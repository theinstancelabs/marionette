export function Mark({ size = 26 }: { size?: number }) {
  return <svg className="mark-icon" width={size} height={size} viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M3 6h20M13 2v9" /><path d="M5 6v8M21 6v10M13 11v6" strokeDasharray="1.5 2.5" /><circle cx="13" cy="20" r="3" />
  </svg>;
}

export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** "just now", "12 s ago", "3 min ago", then the clock time. */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : clock(at);
}

/** A phone's identity color. Always next to its name, never on its own. */
export function PhoneDot({ color, muted = false }: { color: string; muted?: boolean }) {
  return <i className={`pdot ${muted ? 'muted' : ''}`} style={{ background: color }} aria-hidden="true" />;
}
