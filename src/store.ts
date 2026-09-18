import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { DateTime } from 'luxon';
import { AppError, eventSchema, providerSchema, querySchema, tokenKeys, type UsageEvent, type PriceRule, type Provider, type Query } from './schema';
import { validateRules, type Quote } from './pricing';
import { resolvePrice, updatePinnedPrice } from './preset-pricing';
import { ensureStatisticsIndex } from './statistics-index';

export type StoredEvent = UsageEvent & { quote: Quote };
const emptySummary = () => ({ events: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWriteLong: 0 }, totalTokens: 0, priced: 0, presetPriced: 0, unpriced: 0, conflicts: 0, costs: {} as Record<string, string>, reportedCosts: {} as Record<string, string>, sourceEstimates: {} as Record<string, string> });
export type Summary = ReturnType<typeof emptySummary>;
type Stats = { query: Query; summary: Summary; groups: (Summary & { key: string })[] };
function selection(input: unknown, projected = false) {
  const q = querySchema.parse(input), clauses: string[] = [], args: (string | number)[] = [];
  if (q.from) { clauses.push('time>=?'); args.push(Date.parse(q.from)); }
  if (q.to) { clauses.push('time<?'); args.push(Date.parse(q.to)); }
  for (const k of ['source', 'model', 'vendor', 'channel', 'session'] as const) if (q[k]) { clauses.push(projected || k === 'source' ? `${k}=?` : `json_extract(data,'$.${k}')=?`); args.push(q[k]!); }
  return { q, where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', args };
}
function addMoney(map: Record<string, string>, c: string, n: string) { map[c] = new Decimal(map[c] ?? 0).plus(n).toFixed(); }
function accumulate(s: Summary, e: StoredEvent) {
  s.events++;
  for (const k of tokenKeys) { s.tokens[k] += e.tokens[k]; s.totalTokens += e.tokens[k]; }
  if (e.quote.status === 'priced') { s.priced++; if (e.quote.source === 'preset') s.presetPriced++; addMoney(s.costs, e.quote.currency!, e.quote.amount!); }
  else if (e.quote.status === 'conflict') s.conflicts++; else s.unpriced++;
  if (e.reportedCost) addMoney(e.reportedCost.kind === 'reported' ? s.reportedCosts : s.sourceEstimates, e.reportedCost.currency, e.reportedCost.amount);
}
export class Store {
  db: Database;
  private cacheVersion = '';
  private statsCache = new Map<string, Record<string, Stats>>();
  private modelCache: string[] | undefined;
  private refreshCache() {
    // Includes writes from both this connection and another CLI/server process.
    const version = JSON.stringify([this.db.query('PRAGMA data_version').get(), this.db.query('SELECT total_changes() AS n').get()]);
    if (version !== this.cacheVersion) { this.cacheVersion = version; this.statsCache.clear(); this.modelCache = undefined; }
  }
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (source TEXT NOT NULL, id TEXT NOT NULL, time INTEGER NOT NULL, data TEXT NOT NULL, quote TEXT NOT NULL, PRIMARY KEY(source,id));
      CREATE INDEX IF NOT EXISTS events_time ON events(time);
      CREATE TABLE IF NOT EXISTS rules (id TEXT NOT NULL, revision INTEGER NOT NULL, active INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, time TEXT NOT NULL, source TEXT NOT NULL, event_id TEXT NOT NULL, reason TEXT NOT NULL, before_data TEXT NOT NULL, after_data TEXT NOT NULL, before_quote TEXT NOT NULL, after_quote TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS price_history_event ON price_history(source,event_id);
      CREATE TABLE IF NOT EXISTS files (provider TEXT NOT NULL, path TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(provider,path));
      PRAGMA user_version=1;`);
    ensureStatisticsIndex(this.db);
  }
  close() { this.db.close(); }
  audit(action: string, data: unknown) { this.db.query('INSERT INTO audit(time,action,data) VALUES(?,?,?)').run(new Date().toISOString(), action, JSON.stringify(data)); }
  history() { return this.db.query('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all().map((r: any) => ({ ...r, data: JSON.parse(r.data) })); }
  priceHistory(source: string, id: string, limit = 100) {
    return this.db.query('SELECT * FROM price_history WHERE source=? AND event_id=? ORDER BY id DESC LIMIT ?').all(source, id, limit).map((r: any) => ({ ...r, before_data: JSON.parse(r.before_data), after_data: JSON.parse(r.after_data), before_quote: JSON.parse(r.before_quote), after_quote: JSON.parse(r.after_quote) }));
  }
  private savePriceChange(operationId: string, source: string, id: string, reason: string, beforeData: string, afterData: string, beforeQuote: string, afterQuote: string) {
    this.db.query('INSERT INTO price_history(operation_id,time,source,event_id,reason,before_data,after_data,before_quote,after_quote) VALUES(?,?,?,?,?,?,?,?,?)').run(operationId, new Date().toISOString(), source, id, reason, beforeData, afterData, beforeQuote, afterQuote);
  }
  rules(history = false): PriceRule[] { return this.db.query(`SELECT data FROM rules ${history ? '' : 'WHERE active=1'} ORDER BY id,revision`).all().map((r: any) => JSON.parse(r.data)); }
  putRules(input: unknown[], apply = true) {
    return this.db.transaction(() => {
      const incoming = input.map(x => { const r = { ...(x as object) } as any; delete r.revision; return r; });
      const ids = new Set(incoming.map(r => r.id));
      const next = validateRules([...this.rules().filter(r => !ids.has(r.id)), ...incoming]);
      const changes = next.filter(r => ids.has(r.id)).map(r => {
        const last = this.db.query('SELECT MAX(revision) AS n FROM rules WHERE id=?').get(r.id) as { n: number | null };
        return { ...r, revision: (last.n ?? 0) + 1 };
      });
      if (apply) {
        for (const r of changes) {
          this.db.query('UPDATE rules SET active=0 WHERE id=?').run(r.id);
          this.db.query('INSERT INTO rules VALUES(?,?,1,?)').run(r.id, r.revision, JSON.stringify(r));
        }
        this.audit('prices.put', changes);
      }
      return { applied: apply, rules: changes };
    }).immediate();
  }
  removeRule(id: string, apply = true) {
    if (!this.rules().some(r => r.id === id)) throw new AppError('NOT_FOUND', `Rule not found: ${id}`);
    if (apply) this.db.transaction(() => { this.db.query('UPDATE rules SET active=0 WHERE id=?').run(id); this.audit('prices.remove', { id }); }).immediate();
    return { applied: apply, id };
  }
  ingest(input: unknown[], mergeMonotonic = false) {
    const events = input.map(x => { const e = eventSchema.parse(x); e.timestamp = new Date(e.timestamp).toISOString(); return e; });
    return this.db.transaction(() => {
      const rules = this.rules(), operationId = randomUUID(); let inserted = 0, updated = 0, unchanged = 0;
      const get = this.db.query('SELECT data,quote FROM events WHERE source=? AND id=?');
      const upsert = this.db.query('INSERT INTO events VALUES(?,?,?,?,?) ON CONFLICT(source,id) DO UPDATE SET time=excluded.time,data=excluded.data,quote=excluded.quote');
      for (const e of events) {
        const old = get.get(e.source, e.id) as { data: string; quote: string } | null;
        if (old && mergeMonotonic) {
          const prior = JSON.parse(old.data) as UsageEvent;
          for (const key of tokenKeys) e.tokens[key] = Math.max(prior.tokens[key], e.tokens[key]);
          e.timestamp = Date.parse(prior.timestamp) <= Date.parse(e.timestamp) ? prior.timestamp : e.timestamp;
          e.session = prior.session; e.project = prior.project;
        }
        const json = JSON.stringify(e);
        if (old?.data === json) { unchanged++; continue; }
        const oldQuote: Quote | undefined = old ? JSON.parse(old.quote) : undefined;
        // A streaming correction uses its original rate snapshot; new catalog revisions require reprice.
        const nextQuote = oldQuote ? updatePinnedPrice(e, oldQuote) : resolvePrice(e, rules);
        const quote = JSON.stringify(nextQuote);
        if (old) this.savePriceChange(operationId, e.source, e.id, 'usage.update', old.data, json, old.quote, quote);
        upsert.run(e.source, e.id, Date.parse(e.timestamp), json, quote);
        if (old) updated++; else inserted++;
      }
      return { inserted, updated, unchanged };
    }).immediate();
  }
  events(input: unknown = {}): StoredEvent[] {
    const { where, args } = selection(input);
    return this.db.query(`SELECT data,quote FROM events ${where} ORDER BY time,source,id`).all(...args).map((r: any) => ({ ...JSON.parse(r.data), quote: JSON.parse(r.quote) }));
  }
  page(input: unknown = {}, limit = 50, offset = 0) {
    return this.db.transaction(() => {
      const { where, args } = selection(input, true);
      const total = (this.db.query(`SELECT count(*) AS n FROM event_stats_v1 ${where}`).get(...args) as { n: number }).n;
      const rows = this.db.query(`SELECT e.data,e.quote FROM (SELECT source,id,time FROM event_stats_v1 ${where} ORDER BY time DESC,source DESC,id DESC LIMIT ? OFFSET ?) p
        JOIN events e ON e.source=p.source AND e.id=p.id ORDER BY p.time DESC,p.source DESC,p.id DESC`).all(...args, limit, offset) as { data: string; quote: string }[];
      return { total, offset, limit, events: rows.map(r => ({ ...JSON.parse(r.data), quote: JSON.parse(r.quote) } as StoredEvent)) };
    }).deferred();
  }
  stats(input: unknown = {}) {
    const q = querySchema.parse(input);
    return this.statsMany(q, [q.groupBy])[q.groupBy];
  }
  private statsMany(input: unknown, dimensions: Query['groupBy'][]): Record<string, Stats> {
    const { q, where, args } = selection(input, true), kinds = [...new Set(dimensions)];
    this.refreshCache();
    const cacheKey = JSON.stringify([q, kinds]), cached = this.statsCache.get(cacheKey);
    if (cached) return structuredClone(cached);
    const summary = emptySummary(), groups = new Map(kinds.map(k => [k, new Map<string, Summary>()]));
    const buckets = new Map<string, { start: number; end: number; key: string }>();
    // Statistics read the compact projection, never the large pricing snapshots.
    const rows = this.db.query(`SELECT * FROM event_stats_v1 ${where} ORDER BY time`).iterate(...args);
    for (const row of rows as Iterable<any>) {
      const { ruleId } = row;
      const e: StoredEvent = { id: row.id, source: row.source, session: row.session, model: row.model, vendor: row.vendor, channel: row.channel, timestamp: '',
        tokens: { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, cacheWriteLong: row.cacheWriteLong },
        quote: { status: row.priceStatus, source: row.priceSource, amount: row.amount, currency: row.currency },
        ...(row.reportedAmount !== null ? { reportedCost: { amount: row.reportedAmount, currency: row.reportedCurrency, kind: row.reportedKind } } : {}) };
      accumulate(summary, e);
      for (const kind of kinds) {
        let key: string;
        if (kind === 'hour' || kind === 'day' || kind === 'month') {
          let bucket = buckets.get(kind);
          if (!bucket || row.time < bucket.start || row.time >= bucket.end) {
            const local = DateTime.fromMillis(row.time, { zone: q.timezone });
            bucket = { start: local.startOf(kind).toMillis(), end: local.endOf(kind).toMillis() + 1,
              key: kind === 'hour' ? local.toFormat("yyyy-MM-dd'T'HH:00ZZ") : kind === 'day' ? local.toISODate()! : local.toFormat('yyyy-MM') };
            // A repeated partial hour can contain two UTC offsets (Lord Howe).
            // Clip the cached interval at the transition instead of combining them.
            if (kind === 'hour' && local.zone.offset(bucket.end - 1) !== local.offset) {
              let lo = row.time, hi = bucket.end - 1;
              while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (local.zone.offset(mid) === local.offset) lo = mid; else hi = mid; }
              bucket.end = hi;
            }
            buckets.set(kind, bucket);
          }
          key = bucket.key;
        } else key = kind === 'rule' ? ruleId ?? e.quote.status : kind === 'session' ? `${e.source}/${e.session}` : e[kind];
        const map = groups.get(kind)!, group = map.get(key) ?? emptySummary(); accumulate(group, e); map.set(key, group);
      }
    }
    const result = Object.fromEntries(kinds.map(kind => [kind, { query: { ...q, groupBy: kind }, summary,
      groups: [...groups.get(kind)!].map(([key, value]) => ({ key, ...value })).sort((a, b) => a.key.localeCompare(b.key)) }]));
    // Bound cache size, including callers grouping by a high-cardinality session.
    if (Object.values(result).reduce((n, r) => n + r.groups.length, 0) <= 10000) {
      if (this.statsCache.size >= 8) this.statsCache.delete(this.statsCache.keys().next().value!);
      this.statsCache.set(cacheKey, result);
    }
    return structuredClone(result);
  }
  dashboard(input: unknown = {}, limit = 25, offset = 0) {
    return this.db.transaction(() => {
      const q = querySchema.parse(input), stats = this.statsMany(q, [q.groupBy, 'source', 'model', 'rule']);
      this.modelCache ??= (this.db.query('SELECT DISTINCT model FROM event_stats_v1 ORDER BY model').all() as { model: string }[]).map(r => r.model);
      return { trend: stats[q.groupBy], sources: stats.source, models: stats.model, billing: stats.rule,
        activity: this.page(q, limit, offset), allModels: [...this.modelCache] };
    }).deferred();
  }
  reprice(input: unknown = {}, apply = false, onlyUnpriced = false) {
    return this.db.transaction(() => {
      const rules = this.rules(), before = emptySummary(), after = emptySummary(), operationId = randomUUID(); let changed = 0;
      const sample: unknown[] = [];
      for (const e of this.events(input)) {
        const { quote: old, ...event } = e;
        const resolved = !onlyUnpriced || old.status === 'unpriced' ? resolvePrice(event, rules) : old;
        const next = onlyUnpriced && resolved.status !== 'priced' ? old : resolved;
        accumulate(before, e); accumulate(after, { ...event, quote: next });
        if (JSON.stringify(old) !== JSON.stringify(next)) {
          changed++; if (sample.length < 20) sample.push({ source: e.source, id: e.id, before: old, after: next });
          if (apply) {
            this.savePriceChange(operationId, e.source, e.id, onlyUnpriced ? 'prices.fill' : 'prices.reprice', JSON.stringify(event), JSON.stringify(event), JSON.stringify(old), JSON.stringify(next));
            this.db.query('UPDATE events SET quote=? WHERE source=? AND id=?').run(JSON.stringify(next), e.source, e.id);
          }
        }
      }
      const delta: Record<string, string> = {};
      for (const c of new Set([...Object.keys(before.costs), ...Object.keys(after.costs)])) delta[c] = new Decimal(after.costs[c] ?? 0).minus(before.costs[c] ?? 0).toFixed();
      const result = { applied: apply, operationId: apply ? operationId : undefined, changed, before, after, delta, sample };
      if (apply) this.audit(onlyUnpriced ? 'prices.fill' : 'prices.reprice', { query: input, ...result });
      return result;
    }).immediate();
  }
  providers(): (Provider & { status?: any })[] { return this.db.query('SELECT data,status FROM providers ORDER BY id').all().map((r: any) => ({ ...JSON.parse(r.data), status: r.status ? JSON.parse(r.status) : undefined })); }
  putProvider(input: unknown, apply = true) {
    const p = providerSchema.parse(input);
    if (apply) this.db.transaction(() => {
      this.db.query('INSERT INTO providers(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(p.id, JSON.stringify(p));
      this.db.query('DELETE FROM files WHERE provider=?').run(p.id); this.audit('providers.put', p);
    }).immediate();
    return { applied: apply, provider: p };
  }
  removeProvider(id: string, apply = true) {
    if (!this.providers().some(p => p.id === id)) throw new AppError('NOT_FOUND', `Provider not found: ${id}`);
    if (apply) this.db.transaction(() => { this.db.query('DELETE FROM providers WHERE id=?').run(id); this.db.query('DELETE FROM files WHERE provider=?').run(id); this.audit('providers.remove', { id }); }).immediate();
    return { applied: apply, id, usageRetained: true };
  }
  status(id: string, value: unknown) { this.db.query('UPDATE providers SET status=? WHERE id=?').run(JSON.stringify(value), id); }
  fileSignature(provider: string, path: string): string | undefined { return (this.db.query('SELECT signature FROM files WHERE provider=? AND path=?').get(provider, path) as any)?.signature; }
  setFileSignature(provider: string, path: string, signature: string) { this.db.query('INSERT INTO files VALUES(?,?,?) ON CONFLICT(provider,path) DO UPDATE SET signature=excluded.signature').run(provider, path, signature); }
}
