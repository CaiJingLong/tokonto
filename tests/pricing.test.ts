import { describe, expect, test } from 'bun:test';
import { price, validateRules } from '../src/pricing';

export const event = (extra: any = {}) => ({ id: 'e1', source: 'omp', session: 's1', model: 'm1', vendor: 'deepseek', channel: 'api', timestamp: '2026-09-18T01:00:00Z', tokens: { input: 1_000_000, output: 100_000, cacheRead: 500_000, cacheWrite: 0, cacheWriteLong: 0 }, ...extra });
export const rule = (extra: any = {}) => ({ id: 'base', model: 'm1', vendor: 'deepseek', channel: 'api', currency: 'USD', priority: 0, timezone: 'UTC', rates: { input: '2', output: '8', cacheRead: '0.2', cacheWrite: '3', cacheWriteLong: '4' }, ...extra });

describe('time-aware pricing contract', () => {
  test('charges disjoint token classes with exact decimal arithmetic', () => {
    const p = price(event(), [rule()]);
    expect(p.status).toBe('priced'); expect(p.amount).toBe('2.9');
    expect(p.breakdown!.input).toBe('2'); expect(p.rule!.id).toBe('base');
  });
  test('unknown model is unpriced, never free', () => expect(price(event({ model: 'other' }), [rule()]).status).toBe('unpriced'));
  test('peak windows are start inclusive and end exclusive in rule timezone', () => {
    const peak = rule({ id: 'peak', priority: 10, timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], windows: [{ start: '09:00', end: '12:00' }], rates: { input: '4', output: '16', cacheRead: '0.4' } });
    expect(price(event(), [rule(), peak]).amount).toBe('5.8');
    expect(price(event({ timestamp: '2026-09-18T04:00:00Z' }), [rule(), peak]).amount).toBe('2.9');
    expect(price(event({ timestamp: '2026-09-19T01:00:00Z' }), [rule(), peak]).amount).toBe('2.9');
  });
  test('overnight windows use their starting weekday, DST uses IANA timezone', () => {
    const night = rule({ id: 'night', priority: 5, timezone: 'America/New_York', weekdays: [5], windows: [{ start: '22:00', end: '02:00' }] });
    expect(price(event({ timestamp: '2026-09-19T05:00:00Z' }), [night]).status).toBe('priced');
    expect(price(event({ timestamp: '2026-09-19T06:00:00Z' }), [night]).status).toBe('unpriced');
  });
  test('date promotions expire and historical periods never use current rates', () => {
    const promo = rule({ effectiveFrom: '2026-09-01T00:00:00Z', effectiveTo: '2026-09-18T01:00:00Z' });
    expect(price(event(), [promo]).status).toBe('unpriced');
    expect(price(event({ timestamp: '2026-09-17T23:00:00Z' }), [promo]).status).toBe('priced');
  });
  test('same-priority conflicts do not pick arbitrary rules', () => {
    const p = price(event(), [rule(), rule({ id: 'collision' })]);
    expect(p.status).toBe('conflict'); expect(p.candidates).toEqual(['base', 'collision']);
  });
  test('all request tokens switch to the matching context tier', () => {
    const r = rule({ tiers: [{ from: 200_000, rates: { input: '4', output: '16', cacheRead: '0.4' } }] });
    expect(price(event(), [r]).amount).toBe('5.8');
  });
  test('cache write without a rate stays unpriced', () => {
    expect(price(event({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 10, cacheWriteLong: 0 } }), [rule({ rates: { input: '2', output: '8' } })]).status).toBe('unpriced');
  });
  test('validation rejects negative rates, invalid times and ambiguous rules', () => {
    expect(() => validateRules([rule({ rates: { input: '-1', output: '0' } })])).toThrow();
    expect(() => validateRules([rule({ windows: [{ start: '25:00', end: '01:00' }] })])).toThrow();
    expect(() => validateRules([rule(), rule({ id: 'duplicate' })])).toThrow();
  });
  test('validation allows nonoverlapping historical versions', () => {
    expect(validateRules([rule({ effectiveTo: '2026-09-01T00:00:00Z' }), rule({ id: 'new', effectiveFrom: '2026-09-01T00:00:00Z' })])).toHaveLength(2);
  });
  test('wrong channel must not accidentally inherit official prices', () => {
    expect(price(event({ channel: 'subscription' }), [rule()]).status).toBe('unpriced');
  });
});
test('adjacent local date ranges are valid unless an overnight window spills across the boundary', () => {
  expect(validateRules([rule({ dateFrom: '2026-09-01', dateTo: '2026-10-01' }), rule({ id: 'next', dateFrom: '2026-10-01', dateTo: '2026-11-01' })])).toHaveLength(2);
  expect(() => validateRules([rule({ dateFrom: '2026-09-01', dateTo: '2026-10-01', windows: [{ start: '22:00', end: '02:00' }] }), rule({ id: 'next', dateFrom: '2026-10-01', dateTo: '2026-11-01' })])).toThrow();
});
test('DST repeated local hour matches the same wall-clock window twice', () => {
  const r = rule({ timezone: 'America/New_York', windows: [{ start: '01:00', end: '02:00' }] });
  expect(price(event({ timestamp: '2026-11-01T05:30:00Z' }), [r]).status).toBe('priced');
  expect(price(event({ timestamp: '2026-11-01T06:30:00Z' }), [r]).status).toBe('priced');
  expect(price(event({ timestamp: '2026-11-01T07:00:00Z' }), [r]).status).toBe('unpriced');
});
