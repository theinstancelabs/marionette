import { describe, expect, it } from 'vitest';
import { placeLabel } from './spatial';

type Box = Parameters<typeof placeLabel>[0][number];
const label = (x: number, y: number, cx = 0.5, width = 150) => ({ x, y, cx, width, height: 24 });

describe('station labels', () => {
  it('stacks labels that share an anchor, as in Overlay', () => {
    const placed: Box[] = [];
    expect([0, 1, 2, 3].map(() => placeLabel(placed, label(300, 200), 4))).toEqual([0, 1, 2, 3]);
  });

  it('drops a label a row when it would run into a neighbour, as in the Top view', () => {
    const placed: Box[] = [];
    // Two left-arm stations 80 px apart, both growing to the left.
    expect(placeLabel(placed, label(300, 200, 0.9), 2)).toBe(0);
    expect(placeLabel(placed, label(220, 200, 0.9), 2)).toBe(1);
    // A right-arm station growing the other way is clear.
    expect(placeLabel(placed, label(380, 200, 0.1), 2)).toBe(0);
  });

  it('keeps labels in their own row when they are far apart', () => {
    const placed: Box[] = [];
    expect(placeLabel(placed, label(100, 200), 2)).toBe(0);
    expect(placeLabel(placed, label(500, 200), 2)).toBe(0);
  });
});
