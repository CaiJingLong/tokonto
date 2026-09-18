import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import manifest from '../package.json';
import { App, defaultDataDir } from '../src/app';
const cli = join(import.meta.dir, '../src/cli.ts');
test('version works without initializing a database and matches the release manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'token-version-'));
  try {
    const r = await run(join(root, 'unused'), ['--version']);
    expect(r.code).toBe(0); expect(r.value.data.version).toBe(manifest.version);
    expect(r.value.data.name).toBe('tokonto');
    expect(await Bun.file(join(root, 'unused', 'usage.sqlite')).exists()).toBe(false);
    const p = Bun.spawn([process.execPath, cli, '-V'], { stdout: 'pipe' });
    expect((await new Response(p.stdout).text()).trim()).toBe(manifest.version); expect(await p.exited).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('renaming preserves the legacy ledger and prefers an existing Tokonto ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'tokonto-paths-'));
  try {
    const current = join(root, '.tokonto'), legacy = join(root, '.token-usage');
    expect(defaultDataDir({}, root)).toBe(current);
    const old = new App(legacy);
    old.store.ingest([{ id: 'retained', source: 'test', session: 's', model: 'unknown', timestamp: '2026-09-18T00:00:00Z', tokens: { input: 10, output: 5 } }]); old.close();
    mkdirSync(current);
    expect(defaultDataDir({}, root)).toBe(legacy);
    const reopened = new App(defaultDataDir({}, root));
    try { expect(reopened.store.stats().summary.events).toBe(1); } finally { reopened.close(); }
    const fresh = new App(current); fresh.close();
    expect(defaultDataDir({}, root)).toBe(current);
    expect(defaultDataDir({ TOKEN_USAGE_HOME: legacy }, root)).toBe(legacy);
    expect(defaultDataDir({ TOKONTO_HOME: current, TOKEN_USAGE_HOME: legacy }, root)).toBe(current);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('Tokonto environment selects the ledger and explicit data-dir takes precedence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tokonto-env-'));
  try {
    const env = { ...process.env, TOKONTO_HOME: join(root, 'new'), TOKEN_USAGE_HOME: join(root, 'legacy') };
    for (const [args, expected] of [[[], env.TOKONTO_HOME], [['--data-dir', join(root, 'explicit')], join(root, 'explicit')]] as const) {
      const p = Bun.spawn([process.execPath, cli, 'init', '--json', ...args], { env, stdout: 'pipe', stderr: 'pipe' });
      const result = JSON.parse(await new Response(p.stdout).text());
      expect(await p.exited).toBe(0); expect(result.data.dataDir).toBe(expected);
    }
    expect(await Bun.file(join(root, 'legacy/usage.sqlite')).exists()).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
async function run(root: string, args: string[]) {
  const p = Bun.spawn([process.execPath, cli, ...args, '--data-dir', root, '--json'], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, value: JSON.parse(out), err };
}
test('AI discovers schemas and completes prices, import, stats, explain and dry-run workflow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'token-cli-'));
  try {
    const discovery = await run(root, ['schema']); expect(discovery.code).toBe(0); expect(discovery.value.data.commands.some((x: any) => x.name === 'prices reprice')).toBe(true);
    const rule = { id: 'test', model: 'm', vendor: 'custom', currency: 'USD', rates: { input: '2', output: '4' } };
    expect((await run(root, ['prices', 'put', '--input', JSON.stringify({ rules: [rule], dryRun: true })])).value.data.applied).toBe(false);
    expect((await run(root, ['prices', 'put', '--input', JSON.stringify({ rules: [rule] })])).code).toBe(0);
    const event = { id: 'e', source: 'custom', session: 's', model: 'm', vendor: 'custom', channel: 'api', timestamp: '2026-09-18T01:00:00Z', tokens: { input: 1000000, output: 0 } };
    expect((await run(root, ['usage', 'import', '--input', JSON.stringify({ events: [event] })])).code).toBe(0);
    expect((await run(root, ['usage', 'stats', '--group-by', 'hour', '--timezone', 'Asia/Shanghai'])).value.data.summary.costs).toEqual({ USD: '2' });
    expect((await run(root, ['prices', 'explain', '--source', 'custom', '--id', 'e'])).value.data.stored.amount).toBe('2');
    const bad = await run(root, ['usage', 'stats', '--typo', 'x']); expect(bad.code).not.toBe(0); expect(bad.value.ok).toBe(false); expect(bad.value.error.code).toBe('VALIDATION_ERROR');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('AI registers and tests an external provider without importing during test', async () => {
  const root = mkdtempSync(join(tmpdir(), 'token-cli-provider-'));
  try {
    const script = join(root, 'provider.js'); writeFileSync(script, 'console.log(JSON.stringify({protocolVersion:1,events:[]}))');
    const provider = { id: 'custom', name: 'Mine', kind: 'script', command: [process.execPath, script] };
    expect((await run(root, ['providers', 'put', '--input', JSON.stringify({ provider })])).code).toBe(0);
    expect((await run(root, ['providers', 'test', '--id', 'custom'])).value.data.valid).toBe(true);
    expect((await run(root, ['sync', '--id', 'custom'])).value.data.results[0].state).toBe('ok');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('boolean global flags work before command and explicit argument separator is supported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'token-cli-flags-'));
  try {
    const p = Bun.spawn([process.execPath, cli, '--data-dir', root, '--json', 'schema'], { stdout: 'pipe' });
    const out = JSON.parse(await new Response(p.stdout).text()); expect(await p.exited).toBe(0); expect(out.data.commands.length).toBeGreaterThan(5);
    const q = await run(root, ['--', 'usage', 'stats']); expect(q.code).toBe(0); expect(q.value.data.summary.events).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('AI discovers presets and fills existing unpriced records through a previewable command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'token-cli-presets-'));
  try {
    const schema = await run(root, ['schema']); expect(schema.value.data.commands.some((x: any) => x.name === 'prices fill')).toBe(true);
    const list = await run(root, ['prices', 'list']); expect(list.value.data.presets.length).toBeGreaterThan(10);
    expect(list.value.data.rules).toHaveLength(0);
    const fill = await run(root, ['prices', 'fill']); expect(fill.value.data.applied).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
