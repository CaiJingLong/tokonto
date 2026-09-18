import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import Decimal from 'decimal.js';
import { eventSchema, tokenKeys, type Provider, type UsageEvent } from '../schema';
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 32);
const iso = (x: unknown) => typeof x === 'number' ? new Date(x).toISOString() : x;
const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
type CodexCounts = { input: number; output: number; cacheRead: number; cacheWrite: number };
const countKeys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
function codexCounts(u: any): CodexCounts | undefined {
  if (!u || !isCount(u.input_tokens) || !isCount(u.output_tokens)) return;
  const c = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cached_input_tokens ?? 0, cacheWrite: u.cache_write_input_tokens ?? 0 };
  if (!Object.values(c).every(isCount) || c.cacheRead + c.cacheWrite > c.input) return;
  return c;
}
function validDelta(c: CodexCounts) { return Object.values(c).every(isCount) && c.cacheRead + c.cacheWrite <= c.input; }
export type ParseResult = { events: UsageEvent[]; warnings: string[] };
export function parseRecords(p: Pick<Provider, 'id' | 'kind' | 'name'> & Partial<Provider>, records: any[], file: string): ParseResult {
  let session = basename(file), model = 'unknown', vendor = 'unknown', project: string | undefined;
  let previous: CodexCounts | undefined;
  let fallbackReliable = true;
  const seenTotals = new Set<string>();
  const events = new Map<string, UsageEvent>(), warnings: string[] = [];
  const add = (candidate: any) => {
    try {
      const e = eventSchema.parse({ ...candidate, source: p.id, vendor: p.vendor ?? candidate.vendor ?? 'unknown', channel: p.channel ?? candidate.channel ?? 'unknown' });
      const old = events.get(e.id);
      if (old && p.kind === 'claude') {
        for (const k of tokenKeys) e.tokens[k] = Math.max(old.tokens[k], e.tokens[k]);
        e.timestamp = old.timestamp;
      }
      events.set(e.id, e);
      return true;
    } catch (error) {
      const fields = (error as { issues?: { path: (string | number)[]; message: string }[] }).issues?.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') ?? 'invalid usage';
      if (warnings.length < 30) warnings.push(`Invalid usage record ${String(candidate.id ?? '?')}: ${fields}`);
      return false;
    }
  };
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (p.kind === 'omp') {
      if (r.type === 'session') { session = r.id ?? session; project = r.cwd; }
      const m = r.message, u = m?.usage;
      if (r.type !== 'message' || m?.role !== 'assistant' || !u) continue;
      add({ id: m.responseId ? `${m.provider ?? 'unknown'}:${m.responseId}` : `${session}:${r.id ?? hash([r.timestamp, u])}`, session, project, timestamp: iso(r.timestamp ?? m.timestamp), model: m.model ?? 'unknown', vendor: m.provider,
        tokens: { input: u.input, output: u.output, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 },
        ...(typeof u.cost?.total === 'number' && u.cost.total > 0 ? { reportedCost: { amount: new Decimal(u.cost.total).toFixed(), currency: 'USD', kind: 'estimated' } } : {}) });
    } else if (p.kind === 'claude') {
      const m = r.message, u = m?.usage;
      if (r.type !== 'assistant' || !u || m.model === '<synthetic>') continue;
      const detail = u.cache_creation, total = u.cache_creation_input_tokens;
      const notes: string[] = [];
      let short = detail?.ephemeral_5m_input_tokens, long = detail?.ephemeral_1h_input_tokens;
      // Anthropic input excludes cache. Explicit TTL counters are disjoint;
      // use both when supplied, retaining the aggregate discrepancy as provenance.
      if (short != null && long != null) {
        if (!isCount(short) || !isCount(long)) { warnings.push(`Claude ${m.id ?? r.uuid}: 缓存分项必须为非负整数，已跳过`); continue; }
        if (total != null && total !== short + long) notes.push(`缓存写入总量 ${total} 与分项合计 ${short + long} 不一致；采用明确的 5 分钟和 1 小时分项，费用为估算`);
      } else {
        const aggregate = total ?? (short == null && long == null ? 0 : undefined);
        if (!isCount(aggregate) || short != null && !isCount(short) || long != null && !isCount(long) || aggregate < (short ?? long ?? 0)) {
          warnings.push(`Claude ${m.id ?? r.uuid}: 缓存分项不完整或超过总量，无法可靠推导，已跳过`); continue;
        }
        if (short != null) long = aggregate - short;
        else { long ??= 0; short = aggregate - long; }
      }
      add({ id: m.id ?? r.uuid ?? hash([r.timestamp, u]), session: r.sessionId ?? session, project: r.cwd, timestamp: iso(r.timestamp), model: m.model ?? 'unknown', vendor: 'anthropic',
        tokens: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: short, cacheWriteLong: long },
        ...(notes.length ? { warnings: notes } : {}) });
    } else if (p.kind === 'codex') {
      if (r.type === 'session_meta') { session = r.payload?.id ?? session; vendor = r.payload?.model_provider ?? vendor; project = r.payload?.cwd; }
      if (r.type === 'turn_context') { model = r.payload?.model ?? model; vendor = r.payload?.model_provider ?? vendor; }
      const info = r.type === 'event_msg' && r.payload?.type === 'token_count' ? r.payload.info : null;
      if (!info?.total_token_usage) continue;
      const current = codexCounts(info.total_token_usage);
      if (!current) { warnings.push('Codex 累计用量字段无效或缓存超过输入总量，已跳过'); continue; }
      const fingerprint = hash(current);
      // A replay is not a new response and must not rewind the fallback baseline.
      if (seenTotals.has(fingerprint)) {
        const prior = events.get(`${session}:${fingerprint}`), last = codexCounts(info.last_token_usage);
        // A later complete report may repair an incomplete record in-place.
        // Never let a replay of incomplete usage overwrite the repaired event.
        if (prior?.usageStatus !== 'incomplete' || !last || Object.values(last).every(n => n === 0) && info.last_token_usage.total_tokens > 0) continue;
      }
      const delta = { ...current };
      for (const k of countKeys) delta[k] -= previous?.[k] ?? 0;
      const notes: string[] = [];
      let usage = delta;
      let discontinuity = false;
      if (info.last_token_usage != null) {
        const last = codexCounts(info.last_token_usage);
        if (!last || countKeys.some(k => last[k] > current[k])) { warnings.push('Codex 单次用量字段无效、缓存超过输入或单次超过累计总量，已跳过'); continue; }
        usage = last;
        if (countKeys.some(k => delta[k] !== last[k])) {
          discontinuity = previous !== undefined;
          notes.push('累计快照与相邻差分不一致；采用日志报告的单次用量。缺少请求 ID，按累计快照去重，调用归属为尽力还原');
        }
      } else if (!fallbackReliable) {
        warnings.push('Codex 此前累计快照已不连续，差分基线不可靠且缺少单次用量，已跳过'); continue;
      } else if (!validDelta(delta)) {
        fallbackReliable = false;
        warnings.push('Codex 累计计数回退或缓存增量异常，且缺少单次用量；已跳过，未将负数改为零'); continue;
      } else {
        notes.push('日志缺少单次用量；按累计快照差分还原，用量可能包含多次调用');
      }
      const empty = Object.values(usage).every(n => n === 0);
      if (empty && Object.values(current).every(n => n === 0)) continue;
      const incomplete = empty && info.last_token_usage?.total_tokens > 0;
      if (empty) notes.push(incomplete
        ? '单次输入/输出分类为零，但 total_tokens 非零；可能是上下文占用标记，无法确定计费用量，保留原快照 ID 并标记未定价'
        : '日志报告的单次用量为零；保留快照用于历史对账，不将累计总量计为本次消耗');
      const accepted = add({ id: `${session}:${fingerprint}`, session, project, timestamp: r.timestamp, model, vendor,
        ...(incomplete ? { usageStatus: 'incomplete' } : {}),
        contextTokens: info.last_token_usage?.input_tokens,
        tokens: { input: usage.input - usage.cacheRead - usage.cacheWrite, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
        ...(notes.length ? { warnings: notes } : {}) });
      if (accepted) {
        previous = current;
        seenTotals.add(fingerprint);
        if (discontinuity) fallbackReliable = false;
      }
    } else if (p.kind === 'workbuddy') {
      const t = r.trace ?? r, u = t.modelInfo;
      if (!u || u.totalInputTokens === undefined || !t.traceId) continue;
      if (u.totalInputTokens === 0 && u.totalOutputTokens === 0) continue;
      const models = u.models ?? [];
      add({ id: t.traceId, session: t.sessionId ?? t.traceId, timestamp: iso(t.startedAt), model: models.length === 1 ? models[0] : 'unknown', vendor: 'unknown',
        tokens: { input: u.totalInputTokens - (u.totalCachedTokens ?? 0), output: u.totalOutputTokens, cacheRead: u.totalCachedTokens ?? 0 },
        warnings: ['Trace aggregate priced at start time; channel requires explicit configuration', ...(models.length !== 1 ? ['Multiple or missing models; cannot allocate usage per model'] : [])] });
    } else if (p.kind === 'cherry') {
      if (r.record_kind !== undefined) {
        if (r.input_tokens == null || r.output_tokens == null) { warnings.push('Cherry usage record without token counts skipped'); continue; }
        const read = r.cache_read_tokens ?? 0, write = r.cache_write_tokens ?? 0;
        add({ id: r.request_id ?? r.id, session: r.topic_id ?? r.source_id ?? r.message_id ?? session, timestamp: iso(r.created_at), model: r.model_id ?? 'unknown', vendor: r.provider_id,
          tokens: { input: r.no_cache_tokens ?? r.input_tokens - read - write, output: r.output_tokens, cacheRead: read, cacheWrite: write },
          ...(r.cost != null && r.cost_currency ? { reportedCost: { amount: new Decimal(r.cost).toFixed(), currency: r.cost_currency, kind: 'estimated' } } : {}),
          ...(r.record_kind === 'legacy-aggregate' ? { warnings: ['Legacy aggregate; original request timing may be unavailable'] } : {}) });
      } else {
        if (r.role !== 'assistant' || !r.usage) continue;
        const u = r.usage, read = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0;
        const input = u.prompt_tokens !== undefined ? u.prompt_tokens - read - write : u.input_tokens;
        add({ id: r.id, session: r.topicId ?? session, timestamp: iso(r.createdAt), model: typeof r.model === 'string' ? r.model : r.model?.id ?? r.modelId ?? 'unknown', vendor: r.model?.provider,
          tokens: { input, output: u.completion_tokens ?? u.output_tokens, cacheRead: read, cacheWrite: write } });
      }
    }
  }
  return { events: [...events.values()], warnings: [...new Set(warnings)].slice(0, 30) };
}
