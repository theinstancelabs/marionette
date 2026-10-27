import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PhoneTracker, type MirrorPolicy } from '../src/index.js';

/**
 * Runs every tracker fixture in `sdk/conformance/tracker` (the Python SDK's `py-*` and ours, `ts-*`): the same
 * messages, time steps and expectations must give the same phones in both SDKs. Clocks start at 1000.0 s.
 */
const folder = fileURLToPath(new URL('../../../sdk/conformance/tracker/', import.meta.url));
const files = fs.readdirSync(folder).filter(file => file.endsWith('.json')).sort();

type Step = { message?: unknown; advance?: number; lost?: boolean; clear_stale_stops?: boolean; expect?: { phones?: Record<string, unknown>; absent?: string[]; any_stop?: boolean } };
type Fixture = { name: string; description?: string; options?: { mirror?: MirrorPolicy; stop_action?: string }; steps: Step[] };

/** Where `actual` differs from the partial `expected`: objects match key by key (recursively), arrays and values exactly. */
function differences(expected: unknown, actual: unknown, at: string): string[] {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return [`${at}: expected an object, got ${JSON.stringify(actual)}`];
    return Object.entries(expected).flatMap(([key, value]) => differences(value, (actual as Record<string, unknown>)[key], `${at}.${key}`));
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
    return expected.flatMap((value, i) => differences(value, actual[i], `${at}[${i}]`));
  }
  if (typeof expected === 'number' && typeof actual === 'number') return Math.abs(expected - actual) <= 1e-9 * Math.max(1, Math.abs(expected)) ? [] : [`${at}: expected ${expected}, got ${actual}`];
  return expected === actual ? [] : [`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

describe('tracker conformance fixtures', () => {
  it('finds fixtures, ours among them', () => { expect(files.filter(file => file.startsWith('ts-')).length).toBeGreaterThanOrEqual(10); });
  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')) as Fixture;
    it(`${file}: ${fixture.name}`, () => {
      let now = 1000.0;
      const tracker = new PhoneTracker({ mirror: fixture.options?.mirror ?? 'stop-only', stopAction: fixture.options?.stop_action ?? 'safety.estop', clock: () => now * 1000 });
      fixture.steps.forEach((step, index) => {
        if ('message' in step) tracker.apply(step.message);
        if (step.advance !== undefined) now += step.advance;
        if (step.lost) tracker.lostGateway();
        if (step.clear_stale_stops) tracker.clearStaleStops();
        if (!step.expect) return;
        const phones = tracker.snapshot(); const problems: string[] = [];
        for (const [id, partial] of Object.entries(step.expect.phones ?? {})) {
          const phone = phones.get(id);
          problems.push(...(phone ? differences(partial, phone.toConformance(), id) : [`${id}: missing (phones: ${[...phones.keys()].join(', ') || 'none'})`]));
        }
        for (const id of step.expect.absent ?? []) if (phones.has(id)) problems.push(`${id}: expected absent`);
        if (step.expect.any_stop !== undefined && tracker.anyStop() !== step.expect.any_stop) problems.push(`any_stop: expected ${step.expect.any_stop}`);
        expect(problems, `step ${index + 1} of ${file}`).toEqual([]);
      });
    });
  }
});
