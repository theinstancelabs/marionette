import { describe, expect, it } from 'vitest';
import { closeReason, parseRecent, relativeTime, rememberGateway } from './address';

describe('recent gateways', () => {
  it('keeps the five most recent, newest first, without duplicates', () => {
    let list = parseRecent(null);
    for (let i = 1; i <= 6; i++) list = rememberGateway(list, `ws://10.0.0.${i}:8787/ws`, i);
    list = rememberGateway(list, 'ws://10.0.0.3:8787/ws', 10);
    expect(list.map(entry => entry.url)).toEqual(['ws://10.0.0.3:8787/ws', 'ws://10.0.0.6:8787/ws', 'ws://10.0.0.5:8787/ws', 'ws://10.0.0.4:8787/ws', 'ws://10.0.0.2:8787/ws']);
  });

  it('ignores malformed storage', () => {
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent('{"url":"ws://a:1/ws"}')).toEqual([]);
    expect(parseRecent(JSON.stringify([{ url: 'http://evil', usedAt: 1 }, { url: 'ws://ok:8787/ws', usedAt: 2 }, { url: 'ws://ok:8787/ws', usedAt: 1 }, { url: 'ws://x:1/ws', usedAt: 'soon' }])))
      .toEqual([{ url: 'ws://ok:8787/ws', usedAt: 2 }]);
  });

  it('says when a gateway was used', () => {
    const now = Date.UTC(2026, 9, 26, 12);
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 30 * 3_600_000, now)).toBe('yesterday');
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe('4 days ago');
  });

  it('explains why a connection closed', () => {
    expect(closeReason(1006)).toBe('the connection dropped (code 1006)');
    expect(closeReason(1000)).toBe('the gateway closed the connection');
    expect(closeReason(4001, 'replaced by another console')).toBe('replaced by another console (code 4001)');
  });
});
