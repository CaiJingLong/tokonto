import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import manifest from '../package.json';

const npmPackage = process.argv[2] === '--npm' || process.argv[2]?.endsWith('.tgz');
const archive = resolve(process.argv[2] && process.argv[2] !== '--npm' ? process.argv[2] : join(import.meta.dir, npmPackage ? `../artifacts/npm/${manifest.name}-${manifest.version}.tgz` : `../artifacts/${manifest.name}-${manifest.version}.tar.gz`));
const checksum = (await Bun.file(join(dirname(archive), 'SHA256SUMS')).text()).trim().split(/\r?\n/).find(line => line.endsWith(`  ${basename(archive)}`));
assert(checksum, 'Archive is absent from SHA256SUMS');
assert.equal(createHash('sha256').update(new Uint8Array(await Bun.file(archive).arrayBuffer())).digest('hex'), checksum.split('  ')[0], 'SHA256 mismatch');
const temp = mkdtempSync(join(tmpdir(), 'tokonto-release-test-'));
const cwd = join(temp, 'unrelated'), dataDir = join(temp, 'data');
mkdirSync(cwd);
const env = { ...process.env, TOKONTO_HOME: dataDir, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` };
let server: ReturnType<typeof Bun.spawn> | undefined;
async function run(args: string[]) {
  const p = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => p.kill('SIGKILL'), 30_000);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    assert.equal(code, 0, `${args.slice(1, 4).join(' ')} failed: ${err}\n${out}`); return out;
  } finally { clearTimeout(timeout); }
}
try {
  const rootName = npmPackage ? 'package' : `${manifest.name}-${manifest.version}`;
  const files = (await run(['tar', '-tzf', archive])).trim().split('\n');
  assert(files.every(f => (f === rootName || f.startsWith(`${rootName}/`)) && !f.split('/').includes('..')), 'Unexpected archive paths');
  assert(!files.some(f => /(?:^|\/)(?:node_modules|\.git|\.env)(?:\/|$)|\.sqlite(?:-|$)/.test(f)), 'Private or development files in archive');
  if (npmPackage) {
    await run(['npm', 'install', '--prefix', join(temp, 'installed'), '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archive]);
  } else await run(['tar', '-xzf', archive, '-C', temp]);
  const root = npmPackage ? join(temp, 'installed/node_modules', manifest.name) : join(temp, rootName);
  const assets = npmPackage ? join(root, 'dist') : root, cli = join(assets, 'cli.js');
  const command = async (args: string[], input?: unknown) => {
    const result = JSON.parse(await run([process.execPath, cli, ...args, '--json', ...(input ? ['--input', JSON.stringify(input)] : [])]));
    assert.equal(result.ok, true); return result.data;
  };
  assert(statSync(cli).mode & 0o111, 'CLI must be executable');
  assert.equal((await command(['--version'])).version, manifest.version);
  assert.equal((await command(['--version'])).name, manifest.name);
  if (npmPackage) assert.equal((await run([join(temp, 'installed/node_modules/.bin', manifest.name), '--version'])).trim(), manifest.version);
  assert.equal((await run([cli, '--version'])).trim(), manifest.version);
  assert.equal((await run([process.execPath, cli, '-V'])).trim(), manifest.version);
  assert((await command(['schema'])).commands.some((c: any) => c.name === 'usage dashboard'));
  assert(!existsSync(dataDir), 'Version/schema should not initialize a database');
  assert.match(await Bun.file(join(root, 'LICENSE')).text(), /MIT License/);
  for (const dep of ['decimal.js', 'luxon', 'zod']) assert((await Bun.file(join(assets, 'THIRD_PARTY_NOTICES.md')).text()).includes(`## ${dep} `));
  assert.equal((await Bun.file(join(root, 'package.json')).json()).bin['tokonto'], npmPackage ? 'dist/cli.js' : 'cli.js');
  await command(['init']);
  // Disable every built-in source before any sync; never read personal logs.
  for (const provider of await command(['providers', 'list'])) {
    const { status, ...config } = provider;
    await command(['providers', 'put'], { provider: { ...config, enabled: false } });
  }
  await command(['prices', 'put'], { rules: [{ id: 'smoke', model: 'my-model', vendor: 'my-gateway', currency: 'USD', rates: { input: '1', output: '2', cacheRead: '0.1' } }] });
  await command(['providers', 'put'], { provider: { id: 'release-smoke', name: 'Synthetic smoke test', kind: 'script', command: [process.execPath, join(root, 'examples/provider.mjs'), join(root, 'examples/agent.jsonl')] } });
  assert.equal((await command(['providers', 'test', '--id', 'release-smoke'])).count, 2);
  assert.equal((await command(['sync', '--id', 'release-smoke'])).results[0].inserted, 2);
  assert.equal((await command(['sync', '--id', 'release-smoke'])).results[0].inserted, 0);
  const stats = await command(['usage', 'stats']);
  assert.equal(stats.summary.events, 2); assert.equal(stats.summary.costs.USD, '0.02155');
  assert((await command(['skill', 'show'])).content.includes('schema --json'));
  await command(['skill', 'install', '--target', join(temp, 'skills')]);
  assert(existsSync(join(temp, 'skills/tokonto/SKILL.md')));
  const p = Bun.spawn([process.execPath, cli, 'server', '--port', '0', '--interval', '0'], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  server = p;
  const deadline = setTimeout(() => p.kill('SIGKILL'), 30_000);
  const errors = new Response(p.stderr).text();
  try {
    const reader = p.stdout.getReader(), decoder = new TextDecoder(); let output = '';
    while (!output.includes('\n')) { const chunk = await reader.read(); if (chunk.done) throw new Error(`Server exited: ${await errors}`); output += decoder.decode(chunk.value, { stream: true }); }
    reader.releaseLock();
    const url = JSON.parse(output.split('\n')[0]).data.url;
    const get = (path: string) => fetch(new URL(path, url), { signal: AbortSignal.timeout(10_000) });
    assert.equal((await (await get('/api/health')).json() as any).data.version, manifest.version);
    for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
      const response = await get(path); assert.equal(response.status, 200); assert(response.headers.get('content-type')?.startsWith(type)); assert((await response.text()).length > 100);
    }
    const dashboard = await fetch(new URL('/api/command', url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-tokonto': '1' }, body: JSON.stringify({ command: 'usage dashboard', input: { source: 'release-smoke' } }), signal: AbortSignal.timeout(10_000) });
    const payload: any = await dashboard.json(); assert.equal(payload.ok, true);
    assert.equal(payload.data.trend.summary.events, 2);
  } finally { clearTimeout(deadline); p.kill('SIGTERM'); await p.exited; await errors; }
  console.log(`Release smoke passed: ${basename(archive)} (isolated CLI, pricing, provider, skill, HTTP and assets)`);
} finally {
  if (server && server.exitCode === null) { server.kill('SIGKILL'); await server.exited; }
  rmSync(temp, { recursive: true, force: true });
}
