import { z } from 'zod';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { App } from './app';
import { AppError, eventSchema, ruleSchema, providerSchema, querySchema, id } from './schema';
import { catalog, catalogNote } from './catalog';
import { validateRules } from './pricing';
import { resolvePrice } from './preset-pricing';
import { runScript, sync } from './providers/collect';
import { parseRecords } from './providers/parsers';
const empty = z.object({}).strict();
const dryRun = z.boolean().default(false);
const queryFields = querySchema.shape;
const skillPath = existsSync(join(import.meta.dir, 'skill/SKILL.md')) ? join(import.meta.dir, 'skill/SKILL.md') : join(import.meta.dir, '../.agents/skills/token-usage/SKILL.md');
export const serverSchema = z.object({ port: z.number().int().min(0).max(65535).default(4318), interval: z.number().int().min(0).max(86400).default(60), open: z.boolean().default(false) }).strict();
type Command = { name: string; description: string; mutation?: boolean; input: z.ZodType; run: (app: App, input: any) => unknown | Promise<unknown> };
const command = (name: string, description: string, input: z.ZodType, run: Command['run'], mutation = false): Command => ({ name, description, input, run, mutation });
export const commands: Command[] = [
  command('init', 'Initialize local database, built-in providers and automatic model presets', empty, app => ({ dataDir: app.dataDir, providers: app.store.providers(), priceRules: app.store.rules().length, presetRules: catalog().length, note: catalogNote })),
  command('doctor', 'Inspect local source paths and last collection status', empty, app => ({ dataDir: app.dataDir, providers: app.store.providers().map(p => ({ ...p, paths: p.paths.map(path => ({ path, exists: existsSync(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path) })) })), pricing: catalogNote })),
  command('providers list', 'List built-in and external sources', empty, app => app.store.providers()),
  command('providers put', 'Register or replace a provider; dryRun only validates, does not execute', z.object({ provider: providerSchema, dryRun }).strict(), (app, x) => app.store.putProvider(x.provider, !x.dryRun), true),
  command('providers remove', 'Remove provider configuration; retain collected usage', z.object({ id, dryRun }).strict(), (app, x) => app.store.removeProvider(x.id, !x.dryRun), true),
  command('providers test', 'Execute external provider or validate supplied built-in sample records; do not import', z.object({ id, records: z.array(z.unknown()).optional() }).strict(), async (app, x) => {
    const p = app.store.providers().find(p => p.id === x.id); if (!p) throw new AppError('NOT_FOUND', 'Provider not found');
    const result = p.kind === 'script' ? await runScript(p) : x.records ? parseRecords(p, x.records, 'sample.jsonl') : (() => { throw new AppError('VALIDATION_ERROR', 'Built-in provider test requires records; use doctor for path checks'); })();
    return { valid: !('warnings' in result) || result.warnings.length === 0, count: result.events.length, sample: result.events.slice(0, 5), ...('warnings' in result ? { warnings: result.warnings } : {}) };
  }),
  command('sync', 'Collect enabled sources; isolate source failures', z.object({ id: id.optional(), force: z.boolean().default(false) }).strict(), (app, x) => sync(app.store, x), true),
  command('prices list', 'List manual rules and automatic fallback presets separately', z.object({ history: z.boolean().default(false) }).strict(), (app, x) => ({ rules: app.store.rules(x.history), presets: catalog(), fallbackEnabled: true, note: catalogNote })),
  command('prices catalog', 'Inspect the bundled reference prices used automatically when no manual rule matches', empty, () => ({ rules: catalog(), note: catalogNote })),
  command('prices history', 'Full retained pricing and usage revisions for one event', z.object({ source: id, id, limit: z.number().int().min(1).max(1000).default(100) }).strict(), (app, x) => app.store.priceHistory(x.source, x.id, x.limit)),
  command('prices validate', 'Validate supplied rules including same-priority ambiguity', z.object({ rules: z.array(ruleSchema).min(1).max(1000) }).strict(), (_, x) => ({ valid: true, rules: validateRules(x.rules) })),
  command('prices put', 'Add or revise rules; preserve stored costs until explicit reprice', z.object({ rules: z.array(ruleSchema).min(1).max(1000), dryRun }).strict(), (app, x) => app.store.putRules(x.rules, !x.dryRun), true),
  command('prices remove', 'Archive a rule without changing historical costs', z.object({ id, dryRun }).strict(), (app, x) => app.store.removeRule(x.id, !x.dryRun), true),
  command('prices explain', 'Explain a new event or compare saved and current pricing for an event', z.object({ event: eventSchema.optional(), id: id.optional(), source: id.optional() }).strict().refine(x => !!x.event || !!x.id && !!x.source, 'Provide event or source + id'), (app, x) => {
    if (x.event) return { event: x.event, current: resolvePrice(x.event, app.store.rules()) };
    const e = app.store.events({ source: x.source }).find(e => e.id === x.id); if (!e) throw new AppError('NOT_FOUND', 'Usage event not found');
    const { quote, ...event } = e; return { event, stored: quote, current: resolvePrice(event, app.store.rules()) };
  }),
  command('prices reprice', 'Preview cost/coverage differences; apply=true saves new snapshots and audit', z.object({ query: querySchema.default({ timezone: 'UTC', groupBy: 'day' }), apply: z.boolean().default(false) }).strict(), (app, x) => app.store.reprice(x.query, x.apply), true),
  command('prices fill', 'Preview or fill only unpriced usage using manual rules then model presets; preserve existing priced/conflict records', z.object({ query: querySchema.default({ timezone: 'UTC', groupBy: 'day' }), apply: z.boolean().default(false) }).strict(), (app, x) => app.store.reprice(x.query, x.apply, true), true),
  command('usage import', 'Validate and idempotently import normalized records atomically', z.object({ events: z.array(eventSchema).max(50000), dryRun }).strict(), (app, x) => x.dryRun ? { applied: false, valid: true, count: x.events.length } : { applied: true, ...app.store.ingest(x.events) }, true),
  command('usage stats', 'Aggregate time buckets, source, model, session or price rule; currencies stay separate', querySchema, (app, x) => app.store.stats(x)),
  command('usage list', 'Paginated usage details, newest first; includes stored price explanation', z.object({ ...queryFields, limit: z.number().int().min(1).max(1000).default(50), offset: z.number().int().nonnegative().default(0) }).strict(), (app, { limit, offset, ...q }) => app.store.page(q, limit, offset)),
  command('usage dashboard', 'Read a consistent filtered dashboard: trend, source, model, pricing groups and paginated details in one scan', z.object({ ...queryFields, limit: z.number().int().min(1).max(1000).default(25), offset: z.number().int().nonnegative().default(0) }).strict(), (app, { limit, offset, ...q }) => ({ ...app.store.dashboard(q, limit, offset), providers: app.store.providers(), prices: { rules: app.store.rules(), presets: catalog(), fallbackEnabled: true, note: catalogNote } })),
  command('usage export', 'Export filtered usage as JSON records or CSV text; writes only to stdout', z.object({ query: querySchema.default({ timezone: 'UTC', groupBy: 'day' }), format: z.enum(['json', 'csv']).default('json') }).strict(), (app, x) => {
    const records = app.store.events(x.query);
    if (x.format === 'json') return { format: 'json', records };
    const columns = ['source', 'id', 'session', 'timestamp', 'model', 'vendor', 'channel', 'input', 'output', 'cacheRead', 'cacheWrite', 'cacheWriteLong', 'priceStatus', 'amount', 'currency'];
    const escape = (v: unknown) => { const s = String(v ?? ''); return '"' + (/^[=+@\-\t\r]/.test(s) ? "'" : '') + s.replaceAll('"', '""') + '"'; };
    const lines = records.map(e => [e.source, e.id, e.session, e.timestamp, e.model, e.vendor, e.channel, e.tokens.input, e.tokens.output, e.tokens.cacheRead, e.tokens.cacheWrite, e.tokens.cacheWriteLong, e.quote.status, e.quote.amount, e.quote.currency].map(escape).join(','));
    return { format: 'csv', count: records.length, content: [columns.join(','), ...lines].join('\n') + '\n' };
  }),
  command('audit list', 'Last 100 configuration and repricing operations', empty, app => app.store.history()),
  command('skill show', 'Print the portable AI skill shipped with this project', empty, async () => ({ content: await Bun.file(skillPath).text() })),
  command('skill install', 'Install skill into a chosen platform skill directory; refuse overwrite', z.object({ target: z.string().default(join(homedir(), '.codex/skills')), dryRun }).strict(), async (_, x) => {
    const target = resolve(x.target, 'token-usage'); if (existsSync(target)) throw new AppError('ALREADY_EXISTS', `Skill directory already exists: ${target}`);
    const content = await Bun.file(skillPath).text(); if (!x.dryRun) { mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'SKILL.md'), content); }
    return { applied: !x.dryRun, path: target };
  }, true),
];
export function discovery(name?: string) {
  const selected = name ? commands.filter(c => c.name === name || c.name.startsWith(name + ' ')) : commands;
  if (name && !selected.length && name !== 'server' && name !== 'schema') throw new AppError('UNKNOWN_COMMAND', `Unknown command: ${name}`);
  return { version: 1, protocolVersion: 1, globals: { dataDir: 'TOKEN_USAGE_HOME or ~/.token-usage', json: 'Machine-readable stdout', input: 'JSON string, @file or - for stdin', help: 'Show command help', version: '--version or -V; reports app version without opening a database' },
    commands: [...selected.map(c => ({ name: c.name, description: c.description, mutation: !!c.mutation, inputSchema: z.toJSONSchema(c.input, { io: 'input' }) })), ...(!name || name === 'server' ? [{ name: 'server', description: 'Start loopback dashboard server; interval is seconds, 0 disables automatic sync', mutation: true, inputSchema: z.toJSONSchema(serverSchema, { io: 'input' }) }] : []), ...(!name || name === 'schema' ? [{ name: 'schema', description: 'Discover all commands or a command group', mutation: false, inputSchema: z.toJSONSchema(z.object({ command: id.optional() }).strict(), { io: 'input' }) }] : [])],
    schemas: { event: z.toJSONSchema(eventSchema, { io: 'input' }), priceRule: z.toJSONSchema(ruleSchema, { io: 'input' }), provider: z.toJSONSchema(providerSchema, { io: 'input' }), pluginResponse: z.toJSONSchema(z.object({ protocolVersion: z.literal(1), events: z.array(eventSchema.omit({ source: true }).extend({ source: id.optional() })).max(50000), cursor: z.string().max(4096).optional() }).strict(), { io: 'input' }) },
    contracts: { tokens: 'Disjoint categories; output includes reasoning', prices: 'Decimal strings per million tokens; manual rules win, model presets fallback only when no manual match; matching priority wins within each set; ties error; stored quotes pinned; prices fill previews unpriced-only backfill', ranges: '[from,to); local dateTo exclusive; overnight anchored to start weekday', costs: 'costs=rule estimates; reportedCosts=source-reported; sourceEstimates=source estimated', plugins: 'stdin {protocolVersion:1,action:collect,cursor:null|string}; stdout {protocolVersion:1,events:[],cursor?:string}; stable ids; stderr for logs; 16MiB stdout / 64KiB stderr' } };
}
export async function execute(app: App, name: string, input: unknown) {
  const c = commands.find(c => c.name === name); if (!c) throw new AppError('UNKNOWN_COMMAND', `Unknown command: ${name}`);
  return c.run(app, c.input.parse(input));
}
export function errorResult(error: unknown) {
  return { ok: false, error: error instanceof z.ZodError ? { code: 'VALIDATION_ERROR', message: 'Input failed validation', details: error.issues.map(i => ({ path: i.path, message: i.message })) } : error instanceof AppError ? { code: error.code, message: error.message, details: error.details } : { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
}
