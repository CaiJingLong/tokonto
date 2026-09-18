import { expect, test } from 'bun:test';
import { Store } from '../src/store';
import { App } from '../src/app';
import { legacyCatalog } from '../src/catalog';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const event = (extra: any = {}) => ({ id: 'e', source: 'tool', session: 's', model: 'claude-opus-4-8', timestamp: '2026-07-01T00:00:00Z', tokens: { input: 1_000_000, output: 0 }, ...extra });
test('metadata corrections keep original price snapshots until explicit repricing', () => {
  const s = new Store(':memory:');
  try {
    s.putRules([{ id: 'original', model: 'm', vendor: 'v', channel: 'api', currency: 'USD', timezone: 'UTC', dateTo: '2026-08-01', rates: { input: '1', output: '2' } }]);
    s.ingest([event({ model: 'm', vendor: 'v', channel: 'api' })]);
    const snapshot = s.events()[0].quote.rule;
    const corrected = event({ model: 'other', vendor: 'proxy', channel: 'subscription', timestamp: '2026-09-18T20:00:00Z', tokens: { input: 2_000_000, output: 0 } });
    s.ingest([corrected]);
    expect(s.events()[0].quote.amount).toBe('2'); expect(s.events()[0].quote.rule).toEqual(snapshot);
    s.ingest([{ ...corrected, usageStatus: 'incomplete' }]);
    expect(s.events()[0].quote.status).toBe('unpriced'); expect(s.events()[0].quote.rule).toEqual(snapshot);
    s.ingest([corrected]); expect(s.events()[0].quote.amount).toBe('2');
    expect(s.reprice({}, false).changed).toBe(1); expect(s.events()[0].quote.amount).toBe('2');
    s.reprice({}, true); expect(s.events()[0].quote.status).toBe('unpriced');
    expect(s.priceHistory('tool', 'e').length).toBeGreaterThanOrEqual(4);
  } finally { s.close(); }
});
test('new usage automatically receives model preset estimates across unknown channels and historical dates', () => {
  const s = new Store(':memory:');
  try { s.ingest([event()]); const e = s.events()[0]; expect(e.quote.status).toBe('priced'); expect(e.quote.amount).toBe('5'); expect(e.quote.source).toBe('preset'); expect(e.quote.assumptions?.length).toBeGreaterThan(0); expect(e.channel).toBe('unknown'); } finally { s.close(); }
});
test('matching manual rule wins regardless of preset peak priority, and missing rates never bypass it', () => {
  const s = new Store(':memory:');
  try {
    s.putRules([{ id: 'mine', model: 'deepseek-flash', vendor: '*', channel: '*', priority: -100, currency: 'CNY', rates: { input: '7', output: '8' } }]);
    s.ingest([event({ model: 'deepseek-flash', timestamp: '2026-09-18T02:00:00Z' })]);
    expect(s.events()[0].quote.amount).toBe('7'); expect(s.events()[0].quote.source).toBe('custom');
    s.ingest([event({ id: 'missing', model: 'deepseek-flash', tokens: { input: 10, output: 0, cacheRead: 20 } })]);
    expect(s.events().find(e => e.id === 'missing')!.quote.status).toBe('unpriced');
  } finally { s.close(); }
});
test('known aliases use presets while unknown models and incomplete usage stay unpriced', () => {
  const s = new Store(':memory:');
  try {
    s.ingest([event({ model: 'claude-opus-4.8' }), event({ id: 'unknown', model: 'my-secret-model' }), event({ id: 'incomplete', usageStatus: 'incomplete' })]);
    expect(s.events().find(e => e.id === 'e')!.quote.amount).toBe('5');
    expect(s.events().filter(e => e.quote.status === 'unpriced')).toHaveLength(2);
  } finally { s.close(); }
});
test('preset estimates honor peak windows and preserve provenance on streaming updates', () => {
  const s = new Store(':memory:');
  try {
    s.ingest([event({ model: 'deepseek-flash', timestamp: '2026-09-18T02:00:00Z' }), event({ id: 'off', model: 'deepseek-flash', timestamp: '2026-09-18T05:00:00Z' })]);
    expect(s.events().find(e => e.id === 'e')!.quote.amount).toBe('0.3'); expect(s.events().find(e => e.id === 'off')!.quote.amount).toBe('0.15');
    s.ingest([event({ model: 'deepseek-flash', timestamp: '2026-09-18T02:00:00Z', tokens: { input: 2_000_000, output: 0 } })]);
    expect(s.events().find(e => e.id === 'e')!.quote.source).toBe('preset');
    expect(s.stats().summary.presetPriced).toBe(2);
  } finally { s.close(); }
});
test('preset long-context boundary prices input, output and caches without double counting', () => {
  const s = new Store(':memory:');
  try {
    const base = { model: 'gpt-5.6-sol', tokens: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 } };
    s.ingest([event({ ...base, id: 'short', contextTokens: 272000 }), event({ ...base, id: 'long', contextTokens: 272001 })]);
    expect(s.events().find(e => e.id === 'short')!.quote.amount).toBe('0.00294');
    expect(s.events().find(e => e.id === 'long')!.quote.amount).toBe('0.00488');
  } finally { s.close(); }
});
test('fill preview is read-only and applying fills only unpriced records with full history', () => {
  const s = new Store(':memory:');
  try {
    s.ingest([event(), event({ id: 'pinned' }), event({ id: 'incomplete', usageStatus: 'incomplete' })]);
    s.db.query('UPDATE events SET quote=? WHERE id=?').run(JSON.stringify({ status: 'unpriced', reason: 'legacy' }), 'e');
    const pinned = s.events().find(e => e.id === 'pinned')!.quote; expect(pinned.status).toBe('priced');
    expect(s.reprice({}, false, true).changed).toBe(1); expect(s.events().find(e => e.id === 'e')!.quote.status).toBe('unpriced');
    expect(s.reprice({}, true, true).changed).toBe(1); expect(s.events().find(e => e.id === 'pinned')!.quote).toEqual(pinned);
    expect(s.priceHistory('tool', 'e')).toHaveLength(1); expect(s.reprice({}, true, true).changed).toBe(0);
  } finally { s.close(); }
});
test('legacy seeded defaults migrate out of manual rules without archiving user revisions or changing quotes', () => {
  const root = mkdtempSync(join(tmpdir(), 'token-preset-migrate-'));
  try {
    const old = new Store(join(root, 'usage.sqlite')), seed = legacyCatalog();
    old.putRules(seed); old.audit('init', { version: 1 });
    old.putRules([{ ...seed[0], rates: { input: '99', output: '99' } }]);
    old.ingest([event()]); const quote = old.events()[0].quote; old.close();
    const app = new App(root);
    try { expect(app.store.rules()).toHaveLength(1); expect(app.store.rules()[0].rates.input).toBe('99'); expect(app.store.events()[0].quote).toEqual(quote); } finally { app.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
