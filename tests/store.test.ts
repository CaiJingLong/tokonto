import { afterEach, expect, test } from 'bun:test';
import { Store } from '../src/store';
const event = (extra: any = {}) => ({ id: 'one', source: 'omp', session: 's', model: 'm', vendor: 'v', channel: 'api', timestamp: '2026-09-18T01:00:00Z', tokens: { input: 1_000_000, output: 0 }, ...extra });
const rule = (extra: any = {}) => ({ id: 'r', model: 'm', vendor: 'v', currency: 'USD', rates: { input: '1', output: '2' }, ...extra });
const stores: Store[] = [];
const db = () => { const s = new Store(':memory:'); stores.push(s); return s; };
afterEach(() => stores.splice(0).forEach(s => s.close()));
test('repeated collection is idempotent, revised usage updates instead of adding', () => {
  const s = db(); s.putRules([rule()]); s.ingest([event()]); s.ingest([event()]);
  expect(s.stats().summary.events).toBe(1);
  s.ingest([event({ tokens: { input: 2_000_000, output: 0 } })]);
  expect(s.stats().summary.costs).toEqual({ USD: '2' });
});
test('rule revisions preserve prices until explicit reprice, preview does not mutate', () => {
  const s = db(); s.putRules([rule()]); s.ingest([event()]); s.putRules([rule({ rates: { input: '3', output: '2' } })]);
  expect(s.stats().summary.costs).toEqual({ USD: '1' });
  expect(s.reprice({}, false).changed).toBe(1);
  expect(s.stats().summary.costs).toEqual({ USD: '1' });
  s.reprice({}, true); expect(s.stats().summary.costs).toEqual({ USD: '3' });
  expect(s.events()[0].quote.rule!.revision).toBe(2);
});
test('mixed currencies, unknown records and reported expenses stay separate', () => {
  const s = db(); s.putRules([rule(), rule({ id: 'cny', model: 'cn', currency: 'CNY' })]);
  s.ingest([event(), event({ id: 'two', model: 'cn' }), event({ id: 'three', model: 'unknown', reportedCost: { amount: '8', currency: 'USD', kind: 'reported' } })]);
  const x = s.stats().summary; expect(x.costs).toEqual({ USD: '1', CNY: '1' }); expect(x.unpriced).toBe(1); expect(x.reportedCosts).toEqual({ USD: '8' });
});
test('grouping honors timezone and half-open ranges', () => {
  const s = db(); s.ingest([event({ timestamp: '2026-09-17T16:00:00Z' }), event({ id: 'two', timestamp: '2026-09-18T16:00:00Z' })]);
  const x = s.stats({ from: '2026-09-17T16:00:00Z', to: '2026-09-18T16:00:00Z', timezone: 'Asia/Shanghai', groupBy: 'day' });
  expect(x.groups[0].key).toBe('2026-09-18'); expect(x.summary.events).toBe(1);
});
test('invalid event rejects entire batch', () => {
  const s = db(); expect(() => s.ingest([event(), event({ id: 'bad', tokens: { input: -1, output: 0 } })])).toThrow();
  expect(s.stats().summary.events).toBe(0);
});
test('metadata and streaming updates retain the original price revision until explicit reprice', () => {
  const s = db(); s.putRules([rule()]); s.ingest([event()]); s.putRules([rule({ rates: { input: '3', output: '2' } })]);
  s.ingest([event({ project: '/new/path' })]); expect(s.stats().summary.costs).toEqual({ USD: '1' });
  s.ingest([event({ project: '/new/path', tokens: { input: 2_000_000, output: 0 } })]); expect(s.stats().summary.costs).toEqual({ USD: '2' });
});
test('every repriced record retains its previous price and event snapshot beyond preview sample size', () => {
  const s = db(); s.putRules([rule()]); s.ingest(Array.from({ length: 25 }, (_, i) => event({ id: `e${i}` })));
  s.putRules([rule({ rates: { input: '3', output: '2' } })]); s.reprice({}, true);
  const entries = s.db.query('SELECT before_quote,after_quote,before_data FROM price_history').all() as any[];
  expect(entries).toHaveLength(25); expect(entries.every(e => JSON.parse(e.before_quote).amount === '1' && JSON.parse(e.after_quote).amount === '3' && JSON.parse(e.before_data).tokens.input === 1000000)).toBe(true);
});
test('hourly aggregation keeps repeated DST hours distinct by UTC offset', () => {
  const s = db(); s.ingest([event({ timestamp: '2026-11-01T05:30:00Z' }), event({ id: 'two', timestamp: '2026-11-01T06:30:00Z' })]);
  const groups = s.stats({ timezone: 'America/New_York', groupBy: 'hour' }).groups;
  expect(groups.map(g => g.key).sort()).toEqual(['2026-11-01T01:00-04:00', '2026-11-01T01:00-05:00']);
});
test('hourly aggregation separates the repeated half hour in Lord Howe', () => {
  const s = db(); s.ingest([event({ timestamp: '2026-04-04T14:45:00Z' }), event({ id: 'two', timestamp: '2026-04-04T15:15:00Z' })]);
  expect(s.stats({ timezone: 'Australia/Lord_Howe', groupBy: 'hour' }).groups.map(g => g.key).sort()).toEqual(['2026-04-05T01:00+10:30', '2026-04-05T01:00+11:00']);
});
test('incomplete usage stays unpriced and recovers with its original rate snapshot and audit', () => {
  const s = db(); s.putRules([rule()]); s.ingest([event()]);
  s.putRules([rule({ rates: { input: '3', output: '2' } })]);
  s.ingest([event({ usageStatus: 'incomplete', tokens: { input: 0, output: 0 } })]);
  expect(s.events()[0].quote.status).toBe('unpriced'); expect(s.events()[0].quote.amount).toBeUndefined();
  expect(s.events()[0].quote.rule?.revision).toBe(1);
  expect(s.reprice({}, false).after.unpriced).toBe(1);
  s.ingest([event({ tokens: { input: 2_000_000, output: 0 } })]);
  expect(s.events()[0].quote.amount).toBe('2'); expect(s.events()[0].quote.rule?.revision).toBe(1);
  expect(s.priceHistory('omp', 'one')).toHaveLength(2);
});
