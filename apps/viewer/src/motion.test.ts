import { describe, expect, it } from 'vitest';
import type { PosePacket } from '@marionette/protocol';
import { frameKey, niceRange, recentMotion, signed, stepProgressMm, tiltDegrees, trackingValue, trimBefore, type Sample } from './motion';

const at = (t: number, x: number, y = 0, z = 0, key = 'a'): Sample => ({ t, p: { x, y, z }, key });

describe('motion summaries', () => {
  it('says how a phone is tracking and where its pose comes from', () => {
    expect(trackingValue('normal', 'arkit')).toBe('Good, ARKit');
    expect(trackingValue('limited', 'synthetic')).toBe('Limited, synthetic');
    expect(trackingValue('unavailable', 'arkit')).toBe('None');
  });

  it('formats signed numbers with a real minus and no negative zero', () => {
    expect(signed(12.44, 1)).toBe('+12.4');
    expect(signed(-3.06, 1)).toBe('−3.1');
    expect(signed(-0.04, 1)).toBe('0.0');
  });

  it('reads the dominant direction of the last half second', () => {
    const samples = [at(0, 0), at(250, 0.01, 0.002), at(500, 0.04, 0.005)];
    expect(recentMotion(samples, 500)).toMatchObject({ state: 'moving', axis: '+X', words: 'forward' });
    expect(recentMotion([at(0, 0, 0), at(500, 0, -0.03)], 500)).toMatchObject({ axis: '-Y', words: 'right' });
    expect(recentMotion([at(0, 0), at(500, 0.005)], 500)).toEqual({ state: 'still' });
  });

  it('does not join samples across frames or report stale motion', () => {
    expect(recentMotion([at(0, 0, 0, 0, 'old'), at(500, 0.2, 0, 0, 'new')], 500)).toEqual({ state: 'unknown' });
    expect(recentMotion([at(0, 0), at(500, 0.1)], 3000)).toEqual({ state: 'unknown' });
  });

  it('trims old samples in place', () => {
    const samples = [at(0, 0), at(100, 0), at(200, 0)];
    trimBefore(samples, 150);
    expect(samples.map(sample => sample.t)).toEqual([200]);
  });


  it('measures calibration progress from the flat reference', () => {
    const anchor = { x: 0.1, y: 0.2, z: 0.05 };
    expect(stepProgressMm('flat', { x: 1, y: 1, z: 1 }, anchor)).toBeUndefined();
    expect(stepProgressMm('forward', { x: 0.13, y: 0.24, z: 0.5 }, anchor)).toBeCloseTo(50);
    expect(stepProgressMm('right', { x: 0.1, y: 0.2, z: 0.05 })).toBeUndefined();
    expect(stepProgressMm('up', { x: 0.3, y: 0.2, z: 0.08 }, anchor)).toBeCloseTo(30);
  });

  it('measures tilt from flat', () => {
    expect(tiltDegrees({ x: 0, y: 0, z: 0, w: 1 })).toBeCloseTo(0);
    const half = Math.SQRT1_2;
    expect(tiltDegrees({ x: half, y: 0, z: 0, w: half })).toBeCloseTo(90);
  });

  it('keys samples by session and calibration, ignoring the stale marker', () => {
    const pose = { sessionId: 's1', calibrationVersion: 'guided-v2:2' } as PosePacket;
    expect(frameKey(pose)).toBe('s1|guided-v2:2');
    expect(frameKey({ ...pose, calibrationVersion: 'guided-v2:2-stale' })).toBe(frameKey(pose));
  });

  it('picks clean plot ranges that include zero', () => {
    expect(niceRange(-3, 4)).toEqual({ lo: -10, hi: 10, step: 5 });
    expect(niceRange(12, 87)).toEqual({ lo: 0, hi: 100, step: 25 });
    expect(niceRange(-140, 30)).toEqual({ lo: -150, hi: 50, step: 50 });
  });
});
