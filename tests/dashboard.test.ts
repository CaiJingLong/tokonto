import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { App } from '../src/app';
import { execute } from '../src/commands';
import { Database } from 'bun:sqlite';
import { eventSchema } from '../src/schema';
const event = (id: string, timestamp: string, extra = {}) => ({ id, source: 'agent', session: 's', model: 'claude-opus-4-8', timestamp, tokens: { input: 100, output: 10 }, ...extra });
test('dashboard date changes update every chart, totals and paginated details together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-dashboard-')), app = new App(dir);
  try {
    app.store.ingest([event('older', '2026-08-01T00:00:00Z'), event('start', '2026-09-17T16:00:00Z'), event('end', '2026-09-18T16:00:00Z')]);
    const all: any = await execute(app, 'usage dashboard', {});
    expect(all.trend.summary.events).toBe(3);
    const q = { from: '2026-09-17T16:00:00Z', to: '2026-09-18T16:00:00Z', timezone: 'Asia/Shanghai' };
    const day: any = await execute(app, 'usage dashboard', q);
    for (const k of ['trend', 'sources', 'models', 'billing']) expect(day[k].summary.events).toBe(1);
    expect(day.trend.groups.map((g: any) => g.key)).toEqual(['2026-09-18']);
    expect(day.activity.total).toBe(1); expect(day.activity.events.map((e: any) => e.id)).toEqual(['start']);
    expect((await execute(app, 'usage dashboard', {}) as any).trend.summary).toEqual(all.trend.summary);
    const none: any = await execute(app, 'usage dashboard', { ...q, model: 'absent' });
    expect(none.trend.summary.events).toBe(0); expect(none.activity.events).toEqual([]);
    expect(none.allModels).toContain('claude-opus-4-8');
  } finally { app.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('dashboard cache observes ingest, reprice and writes from another connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-dashboard-cache-')), app = new App(dir);
  let other: App | undefined;
  try {
    app.store.ingest([event('e', '2026-09-18T00:00:00Z')]);
    const query = async () => (await execute(app, 'usage dashboard', {}) as any).trend.summary;
    expect((await query()).events).toBe(1);
    other = new App(dir); other.store.ingest([event('new', '2026-09-18T01:00:00Z')]);
    expect((await query()).events).toBe(2);
    app.store.putRules([{ id: 'override', model: '*', vendor: '*', channel: '*', currency: 'CNY', rates: { input: '10', output: '20' } }]);
    const before = await query(); app.store.reprice({}, false); expect(await query()).toEqual(before);
    app.store.reprice({}, true); expect((await query()).costs).toEqual({ CNY: '0.0024' });
    app.store.ingest([event('new', '2026-09-18T01:00:00Z', { tokens: { input: 200, output: 10 } })]);
    expect((await query()).costs).toEqual({ CNY: '0.0034' });
  } finally { other?.close(); app.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('usage list does not materialize the complete history to retrieve a page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-page-')), app = new App(dir);
  try {
    app.store.ingest(['a', 'b', 'c'].map(id => event(id, '2026-09-18T00:00:00Z')));
    app.store.events = () => { throw new Error('Full history read'); };
    const page: any = await execute(app, 'usage list', { limit: 1, offset: 1 });
    expect(page.total).toBe(3); expect(page.events.map((e: any) => e.id)).toEqual(['b']);
  } finally { app.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('legacy database gets fast statistics without changing saved records or prices', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-legacy-stats-')), path = join(dir, 'usage.sqlite');
  const legacy = new Database(path);
  const data = JSON.stringify(eventSchema.parse(event('e', '2026-09-18T00:00:00Z', { reportedCost: { amount: '0.000000000000000001', currency: 'CNY', kind: 'reported' } })));
  const quote = JSON.stringify({ status: 'priced', amount: '0.123456789012345678', currency: 'USD', source: 'custom', rule: { id: 'historical-rule' } });
  legacy.exec('CREATE TABLE events (source TEXT NOT NULL,id TEXT NOT NULL,time INTEGER NOT NULL,data TEXT NOT NULL,quote TEXT NOT NULL,PRIMARY KEY(source,id))');
  legacy.query('INSERT INTO events VALUES(?,?,?,?,?)').run('agent', 'e', Date.parse('2026-09-18T00:00:00Z'), data, quote); legacy.close();
  const app = new App(dir);
  try {
    const r: any = await execute(app, 'usage dashboard', {});
    expect(r.trend.summary.costs).toEqual({ USD: '0.123456789012345678' });
    expect(r.trend.summary.reportedCosts).toEqual({ CNY: '0.000000000000000001' });
    expect(r.billing.groups[0].key).toBe('historical-rule');
    expect(app.store.db.query('SELECT data,quote FROM events').get()).toEqual({ data, quote });
    // Simulate an older CLI writing authoritative events without knowing the index.
    const writer = new Database(path);
    writer.query('UPDATE events SET quote=?').run(JSON.stringify({ status: 'unpriced' }));
    expect((await execute(app, 'usage dashboard', {}) as any).trend.summary.unpriced).toBe(1);
    writer.exec('DELETE FROM events'); writer.close();
    expect((await execute(app, 'usage dashboard', {}) as any).activity.total).toBe(0);
  } finally { app.close(); rmSync(dir, { recursive: true, force: true }); }
});
