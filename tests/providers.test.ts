import { expect, test } from 'bun:test';
import { parseRecords } from '../src/providers/parsers';
const time = '2026-09-18T00:00:00Z';
const parse = (kind: 'omp' | 'codex' | 'claude' | 'workbuddy' | 'cherry', records: any[]) => parseRecords({ id: kind, kind, name: kind }, records, 'file.jsonl');
test('OMP preserves disjoint input and cache counts, cost is a source estimate', () => {
  const result = parse('omp', [{ type: 'session', id: 's' }, { type: 'message', id: 'm', timestamp: time, message: { role: 'assistant', model: 'm', provider: 'v', usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 20, cost: { total: 0.001 } } } }]);
  expect(result.events[0].tokens).toEqual({ input: 100, output: 10, cacheRead: 50, cacheWrite: 20, cacheWriteLong: 0 });
  expect(result.events[0].reportedCost!.kind).toBe('estimated');
});
test('Codex uses cumulative deltas, skips repeated token_count and excludes reasoning double count', () => {
  const info = (input: number, output: number, cache: number) => ({ type: 'event_msg', timestamp: time, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cache, reasoning_output_tokens: 5 } } } });
  const result = parse('codex', [{ type: 'session_meta', payload: { id: 's', model_provider: 'openai' } }, { type: 'turn_context', payload: { model: 'gpt-x' } }, info(100, 10, 50), info(100, 10, 50), info(180, 30, 70)]);
  expect(result.events).toHaveLength(2); expect(result.events[1].tokens.input).toBe(60); expect(result.events[1].tokens.output).toBe(20);
});
test('Claude split assistant messages deduplicate by API message id', () => {
  const record = (output: number) => ({ type: 'assistant', uuid: `part-${output}`, sessionId: 's', timestamp: time, message: { id: 'api-message', model: 'claude-x', usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 50, cache_creation_input_tokens: 30, cache_creation: { ephemeral_1h_input_tokens: 10 } } } });
  const result = parse('claude', [record(1), record(20)]);
  expect(result.events).toHaveLength(1); expect(result.events[0].tokens).toEqual({ input: 100, output: 20, cacheRead: 50, cacheWrite: 20, cacheWriteLong: 10 });
});
test('WorkBuddy trace wrapper uses request totals once, multimodel totals stay unpriced', () => {
  const r = { trace: { traceId: 't', sessionId: 's', startedAt: time, modelInfo: { models: ['m1', 'm2'], totalInputTokens: 100, totalCachedTokens: 40, totalOutputTokens: 10 } }, spans: [] };
  const e = parse('workbuddy', [r]).events[0]; expect(e.tokens.input).toBe(60); expect(e.model).toBe('unknown'); expect(e.warnings!.length).toBeGreaterThan(0);
});
test('Cherry exported message recognizes model object and OpenAI usage', () => {
  const e = parse('cherry', [{ id: 'm', role: 'assistant', topicId: 's', createdAt: time, model: { id: 'deepseek-flash', provider: 'deepseek' }, usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } }]).events[0];
  expect(e.tokens.input).toBe(70); expect(e.model).toBe('deepseek-flash');
});
test('missing counts are diagnosed instead of silently recorded as zero', () => {
  const r = parse('omp', [{ type: 'message', id: 'm', timestamp: time, message: { role: 'assistant', model: 'm', usage: { input: 100 } } }]);
  expect(r.events).toHaveLength(0); expect(r.warnings.length).toBeGreaterThan(0);
});
test('OMP tiny source cost does not discard valid token usage', () => {
  const result = parse('omp', [{ type: 'message', id: 'tiny', timestamp: time, message: { role: 'assistant', model: 'm', usage: { input: 100, output: 10, cost: { total: 0.0000000012345678901234567 } } } }]);
  expect(result.events).toHaveLength(1); expect(result.warnings).toHaveLength(0);
});
test('Codex counter rollback counts only reported last request, never the whole session again', () => {
  const snapshot = (timestamp: string, input: number, output: number, last?: any) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 0 }, last_token_usage: last } } });
  const r = parse('codex', [snapshot(time, 1000, 100), snapshot('2026-09-18T00:01:00Z', 900, 90, { input_tokens: 50, output_tokens: 5, cached_input_tokens: 0 }), snapshot('2026-09-18T00:02:00Z', 1000, 100)]);
  expect(r.events.reduce((n, e) => n + e.tokens.input, 0)).toBe(1050);
  expect(r.events).toHaveLength(2); expect(r.events[1].warnings?.length).toBeGreaterThan(0);
});

const counts = (input: number, output: number, cache = 0, write = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cache, cache_write_input_tokens: write });
const snapshot = (total: any, last?: any) => ({ type: 'event_msg', timestamp: time, payload: { type: 'token_count', info: { total_token_usage: total, ...(last === undefined ? {} : { last_token_usage: last }) } } });
test('Claude explicit cache TTL breakdown survives conflicting aggregate with a visible explanation', () => {
  const r = parse('claude', [{ type: 'assistant', timestamp: time, message: { id: 'cache-conflict', model: 'claude-x', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 229 } } } }]);
  expect(r.events).toHaveLength(1);
  expect(r.events[0].tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWriteLong: 229 });
  expect(r.events[0].warnings?.join(' ')).toContain('分项');
  expect(r.warnings).toEqual([]);
});
test('Claude missing short TTL cannot be inferred from a smaller aggregate', () => {
  const r = parse('claude', [{ type: 'assistant', timestamp: time, message: { id: 'incomplete', model: 'm', usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 20 } } } }]);
  expect(r.events).toHaveLength(0);
  expect(r.warnings.join(' ')).toContain('缓存');
});
test('Codex interleaved cumulative branches use last request counts and ignore replayed snapshots', () => {
  const a = snapshot(counts(1000, 100, 800), counts(100, 10, 80));
  const b = snapshot(counts(1100, 110, 900), counts(100, 10, 100));
  const c = snapshot(counts(1100, 115, 820), counts(100, 15, 20));
  const d = snapshot(counts(1200, 120, 1000), counts(100, 10, 100));
  const r = parse('codex', [a, b, c, b, d, c, d]);
  expect(r.warnings).toEqual([]); expect(r.events).toHaveLength(4);
  expect(r.events.map(e => e.tokens.input)).toEqual([20, 0, 80, 0]);
  expect(r.events.reduce((n, e) => n + e.tokens.output, 0)).toBe(45);
  expect(r.events[2].warnings?.length).toBeGreaterThan(0);
});
test('Codex cache writes are included in input, while reasoning is included in output', () => {
  const r = parse('codex', [snapshot(counts(900, 100, 400, 200), { ...counts(100, 10, 40, 30), reasoning_output_tokens: 4 })]);
  expect(r.events[0].tokens).toEqual({ input: 30, output: 10, cacheRead: 40, cacheWrite: 30, cacheWriteLong: 0 });
});
test('Codex replay without last usage must not move the difference baseline backwards', () => {
  const a = snapshot(counts(100, 10, 50)), b = snapshot(counts(200, 20, 100));
  const r = parse('codex', [a, b, a, snapshot(counts(300, 30, 150))]);
  expect(r.events.reduce((n, e) => n + e.tokens.input + e.tokens.cacheRead, 0)).toBe(300);
});
test('Codex invalid last request is diagnosed instead of using plausible cumulative counters', () => {
  const r = parse('codex', [snapshot(counts(1000, 100, 800), counts(100, 10, 101))]);
  expect(r.events).toHaveLength(0); expect(r.warnings.join(' ')).toContain('单次');
});
test('Codex invalid cumulative counters do not poison the following valid delta', () => {
  const r = parse('codex', [snapshot(counts(100, 10, 50)), snapshot(counts(110, 11, -10)), snapshot(counts(200, 20, 100))]);
  expect(r.events).toHaveLength(2);
  expect(r.events.reduce((n, e) => n + e.tokens.input + e.tokens.cacheRead, 0)).toBe(200);
  expect(r.warnings).toHaveLength(1);
});
test('Codex a bad last snapshot cannot suppress a later valid snapshot with the same total', () => {
  const total = counts(100, 10, 50);
  const r = parse('codex', [snapshot(total, counts(100, 10, 200)), snapshot(total, counts(100, 10, 50))]);
  expect(r.events).toHaveLength(1); expect(r.events[0].tokens.input).toBe(50);
});
test('Codex a rollback breaks the fallback baseline when later snapshots lack last usage', () => {
  const r = parse('codex', [snapshot(counts(1000, 100)), snapshot(counts(900, 90), counts(50, 5)), snapshot(counts(1100, 110))]);
  expect(r.events.reduce((n, e) => n + e.tokens.input, 0)).toBe(1050);
  expect(r.warnings.join(' ')).toContain('基线');
});
test('Codex a last request cannot exceed its cumulative counters', () => {
  const r = parse('codex', [snapshot(counts(100, 10), counts(1000, 100))]);
  expect(r.events).toHaveLength(0); expect(r.warnings.join(' ')).toContain('单次');
});
test('Codex malformed timestamps do not suppress a later valid copy', () => {
  const record = snapshot(counts(100, 10, 50), counts(100, 10, 50));
  const r = parse('codex', [{ ...record, timestamp: 'bad' }, record]);
  expect(r.events).toHaveLength(1);
});
test('Codex zero last usage corrects an existing nonzero cumulative snapshot instead of leaving stale usage', () => {
  const total = counts(1000, 100, 800);
  const oldId = parse('codex', [snapshot(total)]).events[0].id;
  const r = parse('codex', [snapshot(total, counts(0, 0)), snapshot(total, counts(0, 0))]);
  expect(r.events).toHaveLength(1); expect(r.events[0].id).toBe(oldId);
  expect(Object.values(r.events[0].tokens).every(n => n === 0)).toBe(true);
  expect(r.events[0].warnings?.join(' ')).toContain('零');
  expect(parse('codex', [snapshot(counts(0, 0), counts(0, 0))]).events).toHaveLength(0);
});
test('Codex zero categories with a positive reported total are incomplete, not known free usage', () => {
  const r = parse('codex', [snapshot(counts(0, 2), { ...counts(0, 0), total_tokens: 13442 })]);
  expect(r.events).toHaveLength(1);
  expect(r.events[0].usageStatus).toBe('incomplete');
  expect(r.events[0].warnings?.join(' ')).toContain('无法');
});
test('Codex valid usage repairs an incomplete snapshot with the same ID, never regresses on replay', () => {
  const total = counts(100, 10, 50);
  const incomplete = snapshot(total, { ...counts(0, 0), total_tokens: 100 });
  const complete = snapshot(total, counts(100, 10, 50));
  const firstId = parse('codex', [incomplete]).events[0].id;
  const r = parse('codex', [incomplete, complete, incomplete, complete]);
  expect(r.events).toHaveLength(1); expect(r.events[0].id).toBe(firstId);
  expect(r.events[0].usageStatus).toBeUndefined(); expect(r.events[0].tokens.input).toBe(50);
});
