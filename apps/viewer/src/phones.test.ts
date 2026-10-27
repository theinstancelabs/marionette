import { describe, expect, it } from 'vitest';
import { defaultConfig, type ConfigMessage, type PhoneInfo, type UiControl } from '@marionette/protocol';
import { armOf, heldControls, phoneDetail, rosterPhones, safeColor, stationName, stationOffsets, stopOn, type Phone } from './phones';

const info = (n: number, over: Partial<PhoneInfo> = {}): PhoneInfo => ({ id: `phone-${n}`, name: `Phone ${n}`, color: n === 1 ? '#c98200' : '#b04fc4', connected: true, ...over });
const withValue = (id: string, value: string | boolean, config: ConfigMessage = defaultConfig()): ConfigMessage => ({ ...config, controls: config.controls.map(c => c.id === id ? { ...c, value } as UiControl : c) });
const holding = (config: ConfigMessage = defaultConfig()): ConfigMessage => ({ ...config, controls: config.controls.map(c => c.id === 'deadman' ? { ...c, held: true } as UiControl : c) });
const phone = (over: Partial<Phone> = {}): Phone => ({ id: 'phone-1', name: 'Phone 1', color: '#c98200', connected: true, config: defaultConfig(), ...over });
const offsets = (phones: { id: string; arm?: string }[], layout: 'side' | 'overlay' = 'side') => Object.fromEntries(stationOffsets(phones, layout));

describe('stations', () => {
  it('puts the left arm 25 cm to the left and the right arm 25 cm to the right', () => {
    expect(offsets([{ id: 'a', arm: 'left' }, { id: 'b', arm: 'right' }])).toEqual({ a: 0.25, b: -0.25 });
    expect(offsets([{ id: 'a', arm: 'right' }, { id: 'b', arm: 'left' }])).toEqual({ a: -0.25, b: 0.25 });
    expect(offsets([{ id: 'a', arm: 'left' }])).toEqual({ a: 0.25 });
  });

  it('moves a second phone on the same arm one more place out', () => {
    expect(offsets([{ id: 'a', arm: 'left' }, { id: 'b', arm: 'left' }])).toEqual({ a: 0.25, b: 0.75 });
    expect(offsets([{ id: 'a', arm: 'right' }, { id: 'b', arm: 'right' }, { id: 'c', arm: 'right' }])).toEqual({ a: -0.25, b: -0.75, c: -1.25 });
  });

  it('gives phones without an arm the free places nearest the centre, in roster order', () => {
    expect(offsets([{ id: 'a' }, { id: 'b', arm: 'left' }])).toEqual({ a: -0.25, b: 0.25 });
    expect(offsets([{ id: 'a', arm: 'left' }, { id: 'b' }, { id: 'c' }])).toEqual({ a: 0.25, b: -0.25, c: 0.75 });
    expect(offsets([{ id: 'a', arm: 'both' }, { id: 'b', arm: 'right' }])).toEqual({ a: 0.25, b: -0.25 });
  });

  it('spreads phones evenly about the centre when none has an arm', () => {
    expect(offsets([{ id: 'a' }])).toEqual({ a: 0 });
    expect(offsets([{ id: 'a' }, { id: 'b' }])).toEqual({ a: 0.25, b: -0.25 });
    expect(offsets([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toEqual({ a: 0.5, b: 0, c: -0.5 });
  });

  it('draws every origin at the centre in Overlay', () => {
    expect(offsets([{ id: 'a', arm: 'left' }, { id: 'b', arm: 'right' }], 'overlay')).toEqual({ a: 0, b: 0 });
  });

  it('labels a station with the phone and its arm', () => {
    expect(stationName(phone())).toBe('Phone 1, left arm');
    expect(stationName(phone({ config: withValue('arm', 'right') }))).toBe('Phone 1, right arm');
    expect(stationName(phone({ config: undefined }))).toBe('Phone 1');
  });
});

describe('roster', () => {
  it('keeps the gateway order and appends phones known only from their own config', () => {
    const late: ConfigMessage = { ...defaultConfig(), phone: info(3) };
    const phones = rosterPhones([info(2), info(1, { connected: false })], { 'phone-1': withValue('arm', 'right'), 'phone-3': late });
    expect(phones.map(p => [p.id, p.connected, armOf(p.config)?.value])).toEqual([['phone-2', true, undefined], ['phone-1', false, 'right'], ['phone-3', true, 'left']]);
  });

  it('only trusts hex colors', () => {
    expect(safeColor('#b04fc4')).toBe('#b04fc4');
    expect(safeColor('url(javascript:alert(1))')).toBe('#6b6f73');
    expect(rosterPhones([info(1, { color: 'red; background: url(x)' })], {})[0].color).toBe('#6b6f73');
  });
});

describe('per-phone state', () => {
  it('reads Stop, holds and the arm from the phone config', () => {
    expect(stopOn(defaultConfig())).toBe(false);
    expect(stopOn(withValue('estop', true))).toBe(true);
    expect(heldControls(holding()).map(c => c.id)).toEqual(['deadman']);
    expect(armOf(defaultConfig())).toEqual({ value: 'left', label: 'left arm' });
  });

  it('says the most important state after the arm, and Stop separately', () => {
    const present = { present: true, tracking: 'normal' as const };
    expect(phoneDetail(phone(), present)).toEqual({ arm: 'left arm', warn: false, stop: false });
    expect(phoneDetail(phone({ config: holding() }), present)).toMatchObject({ state: 'holding' });
    expect(phoneDetail(phone({ config: holding() }), { present: true, tracking: 'limited' })).toMatchObject({ state: 'tracking limited', warn: true });
    expect(phoneDetail(phone(), { present: false })).toMatchObject({ state: 'no pose', warn: true });
    expect(phoneDetail(phone({ connected: false, config: withValue('estop', true) }), { present: false })).toEqual({ arm: 'left arm', state: 'disconnected', warn: false, stop: true });
    expect(phoneDetail(phone({ config: { ...defaultConfig(), calibration: { status: 'capturing', epoch: 0, step: 'forward' } } }), present)).toMatchObject({ state: 'calibrating' });
  });
});
