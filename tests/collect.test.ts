import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScript, sync } from '../src/providers/collect';
import { Store } from '../src/store';
const base = { id: 'custom', name: 'Custom', kind: 'script', timeoutMs: 2000 };
const event = { id: 'r', source: 'spoof', session: 's', model: 'm', timestamp: '2026-09-18T00:00:00Z', tokens: { input: 10, output: 5 } };
test('script protocol validates output and assigns configured source', async () => {
  const result = await runScript({ ...base, command: [process.execPath, '-e', `console.log(JSON.stringify({protocolVersion:1,events:[${JSON.stringify(event)}],cursor:'next'}))`] });
  expect(result.events[0].source).toBe('custom'); expect(result.cursor).toBe('next');
});
test('script rejects invalid output and terminates on timeout', async () => {
  await expect(runScript({ ...base, command: [process.execPath, '-e', 'console.log("oops")'] })).rejects.toThrow();
  await expect(runScript({ ...base, timeoutMs: 100, command: [process.execPath, '-e', 'setInterval(()=>{},1000)'] })).rejects.toThrow('timed out');
});
test('failed source is isolated and file sync is repeatable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'token-collect-')); const store = new Store(':memory:');
  try {
    const file = join(root, 'usage.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'message', id: 'm', timestamp: event.timestamp, message: { role: 'assistant', model: 'm', usage: { input: 10, output: 5 } } }) + '\n');
    store.putProvider({ id: 'omp', name: 'OMP', kind: 'omp', paths: [file] });
    store.putProvider({ ...base, command: [process.execPath, '-e', 'process.exit(1)'] });
    const first = await sync(store); expect(first.results.find((r: any) => r.id === 'custom').state).toBe('error');
    expect(store.stats().summary.events).toBe(1);
    const second = await sync(store); expect(second.results.find((r: any) => r.id === 'omp').skippedFiles).toBe(1);
    expect(store.stats().summary.events).toBe(1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
test('timeout also terminates descendants of a provider script', async () => {
  if (process.platform === 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'token-child-')), marker = join(root, 'escaped');
  try {
    const child = `setTimeout(()=>Bun.write(${JSON.stringify(marker)},'escaped'),500)`;
    const parent = `Bun.spawn([process.execPath,'-e',${JSON.stringify(child)}],{stdout:'ignore',stderr:'ignore'});setInterval(()=>{},1000)`;
    await expect(runScript({ ...base, timeoutMs: 150, command: [process.execPath, '-e', parent] })).rejects.toThrow('timed out');
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('Claude copied partial messages cannot regress totals across files or force sync', async () => {
  const root = mkdtempSync(join(tmpdir(), 'token-claude-')), store = new Store(':memory:');
  try {
    const record = (output: number, session: string) => JSON.stringify({ type: 'assistant', sessionId: session, timestamp: '2026-09-18T00:00:00Z', message: { id: 'shared-api-id', model: 'claude-x', usage: { input_tokens: 100, output_tokens: output } } }) + '\n';
    writeFileSync(join(root, 'a.jsonl'), record(20, 'original')); writeFileSync(join(root, 'b.jsonl'), record(1, 'fork'));
    store.putProvider({ id: 'claude', name: 'Claude', kind: 'claude', paths: [root] });
    await sync(store); expect(store.stats().summary.tokens.output).toBe(20);
    writeFileSync(join(root, 'a.jsonl'), record(20, 'original') + '\n'); await sync(store);
    expect(store.events()[0].session).toBe('original');
    await sync(store, { force: true }); expect(store.stats().summary.tokens.output).toBe(20); expect(store.stats().summary.events).toBe(1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
test('parser upgrade revisits unchanged Codex logs, updates stable IDs and preserves pinned pricing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'token-upgrade-')), store = new Store(':memory:');
  try {
    const file = join(root, 'usage.jsonl'), current = { input: 1000, output: 100, cacheRead: 800, cacheWrite: 0 };
    const id = `s:${createHash('sha256').update(JSON.stringify(current)).digest('hex').slice(0, 32)}`;
    const record = { type: 'event_msg', timestamp: event.timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 800 }, last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80 } } } };
    writeFileSync(file, [{ type: 'session_meta', payload: { id: 's' } }, record].map(r => JSON.stringify(r)).join('\n') + '\n');
    store.putProvider({ id: 'codex', kind: 'codex', name: 'Codex', paths: [file] });
    store.putRules([{ id: 'r', model: '*', vendor: '*', channel: '*', currency: 'USD', rates: { input: '1', output: '2', cacheRead: '0.1' } }]);
    store.ingest([{ ...event, id, source: 'codex', tokens: { input: 200, output: 100, cacheRead: 800 } }]);
    store.putRules([{ id: 'r', model: '*', vendor: '*', channel: '*', currency: 'USD', rates: { input: '10', output: '20', cacheRead: '1' } }]);
    const stat = statSync(file); store.setFileSignature('codex', file, `${stat.size}:${stat.mtimeMs}:0:0`);
    const first = await sync(store);
    expect(first.results[0].updated).toBe(1); expect(first.results[0].inserted).toBe(0);
    expect(store.events()).toHaveLength(1); expect(store.events()[0].tokens.input).toBe(20);
    expect(store.events()[0].quote.rule?.revision).toBe(1);
    expect(store.priceHistory('codex', id)).toHaveLength(1);
    expect((await sync(store)).results[0].skippedFiles).toBe(1);
    await sync(store, { force: true }); expect(store.priceHistory('codex', id)).toHaveLength(1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
