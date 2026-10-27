import { describe, expect, it } from 'vitest';
import type { RobotStateMessage } from '@marionette/protocol';
import { branchSummary, freshness, inlineArray, leafText, openByDefault, robotList, stateAge, type RobotStateEntry } from './robots';

const entry = (over: Partial<RobotStateMessage> = {}, at = 10_000): RobotStateEntry => ({ message: { type: 'robot_state', version: 1, robotId: 'axol', state: {}, ...over }, at });

describe('robot state freshness', () => {
  it('ages from arrival, or from the gateway’s stamp on its clock', () => {
    expect(stateAge(entry({ receivedAt: 50_000 }), 12_000)).toBe(2000);
    expect(stateAge(entry({ receivedAt: 50_000 }), 12_000, 40_000)).toBe(2000);
    expect(stateAge(entry({ receivedAt: 50_000 }), 12_000, 30_000)).toBe(0);
  });

  it('is stale after max(1.5 s, 3 × everyMs), offline whenever the robot is', () => {
    expect(freshness(entry(), true, 1500)).toBe('fresh');
    expect(freshness(entry(), true, 1501)).toBe('stale');
    expect(freshness(entry({ everyMs: 2000 }), true, 5999)).toBe('fresh');
    expect(freshness(entry({ everyMs: 2000 }), true, 6001)).toBe('stale');
    expect(freshness(entry(), false, 0)).toBe('offline');
  });

  it('lists robots known only from their state after the roster', () => {
    expect(robotList([{ id: 'axol', name: 'Axol', connected: true }], [entry(), entry({ robotId: 'arm-2' })]).map(robot => [robot.id, robot.connected]))
      .toEqual([['axol', true], ['arm-2', false]]);
  });
});

describe('robot state as a tree', () => {
  it('prints values plainly', () => {
    expect([null, true, 3, 0.123456789, -2.5, 'ok'].map(value => leafText(value))).toEqual(['null', 'true', '3', '0.1235', '-2.5', '"ok"']);
  });

  it('keeps short lists of plain values on one line and folds the rest', () => {
    expect(inlineArray([0.1, -0.5, 1.2])).toBe('[0.1, -0.5, 1.2]');
    expect(inlineArray([1, 2, 3, 4, 5, 6, 7])).toBeUndefined();
    expect(inlineArray([{ a: 1 }])).toBeUndefined();
    expect(inlineArray(['a very long string value', 'and another one here'])).toBeUndefined();
    expect([branchSummary([1, 2]), branchSummary([7]), branchSummary({ a: 1, b: 2, c: 3 }), branchSummary([]), branchSummary({})]).toEqual(['2 items', '1 item', '3 keys', '[ ]', '{ }']);
    expect([openByDefault({ a: 1 }, 0), openByDefault({ a: 1 }, 1), openByDefault({ a: 1 }, 2), openByDefault(Array(13).fill(0), 0)]).toEqual([true, true, false, false]);
  });
});
