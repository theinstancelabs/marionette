import { describe, expect, it } from 'vitest';
import { validatePose } from '@marionette/protocol';
import { SIM_PHONES, simulatedConfig, simulatedHolds, simulatedRoster, simulationPose } from './simulation';

describe('viewer simulation', () => {
  it('emits valid, attributed poses with distinct motion per phone', () => {
    const one = simulationPose(0, 1.25, 7), two = simulationPose(1, 1.25, 7);
    expect(validatePose(one) && validatePose(two)).toBe(true);
    expect([one.phoneId, two.phoneId]).toEqual(['phone-1', 'phone-2']);
    expect(one.seq).toBe(7);
    expect(Math.hypot(one.position.x - two.position.x, one.position.y - two.position.y, one.position.z - two.position.z)).toBeGreaterThan(0.02);
    for (let t = 0; t < 30; t += 0.37) for (const index of [0, 1]) {
      const { position } = simulationPose(index, t, 0);
      // Small enough that the two stations, 50 cm apart, never overlap.
      expect(Math.abs(position.y)).toBeLessThan(0.1);
    }
  });

  it('puts Phone 1 on the left arm and Phone 2 on the right, in the shared colors', () => {
    const roster = simulatedRoster();
    expect(roster.map(phone => [phone.name, phone.color])).toEqual([['Phone 1', '#c98200'], ['Phone 2', '#b04fc4']]);
    expect([0, 1].map(index => simulatedConfig(index, roster).controls.find(c => c.action === 'arm.select'))).toMatchObject([{ value: 'left' }, { value: 'right' }]);
  });

  it('presses each phone’s hold now and then', () => {
    expect(simulatedHolds(0, 1)).toEqual([]);
    expect(simulatedHolds(0, SIM_PHONES[0].hold.start + 1)).toEqual(['deadman']);
    expect(simulatedHolds(0, SIM_PHONES[0].hold.start + SIM_PHONES[0].hold.length + 0.5)).toEqual([]);
    expect(simulatedHolds(1, SIM_PHONES[1].hold.start + 0.5)).toEqual(['grip']);
  });
});
