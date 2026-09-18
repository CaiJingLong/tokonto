import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { AppError, eventSchema, providerSchema, type Provider, type UsageEvent } from '../schema';
import { Store } from '../store';
import { parseRecords } from './parsers';

export function defaults(home = homedir()): Provider[] {
  const cherryRoot = process.platform === 'darwin' ? join(home, 'Library/Application Support/CherryStudio') : process.platform === 'win32' ? join(process.env.APPDATA ?? join(home, 'AppData/Roaming'), 'CherryStudio') : join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'CherryStudio');
  return [
    { id: 'codex', name: 'Codex', kind: 'codex', paths: [join(home, '.codex/sessions'), join(home, '.codex/archived_sessions')] },
    { id: 'claude-code', name: 'Claude Code', kind: 'claude', paths: [join(home, '.claude/projects')] },
    { id: 'omp', name: 'OMP', kind: 'omp', paths: [join(home, '.omp/agent/sessions')] },
    { id: 'workbuddy', name: 'WorkBuddy', kind: 'workbuddy', paths: [join(home, '.workbuddy/traces')] },
    { id: 'cherry-studio', name: 'Cherry Studio', kind: 'cherry', paths: [join(cherryRoot, 'Data/cherrystudio.sqlite')] },
  ].map(p => providerSchema.parse(p));
}
function expand(path: string) { return resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path); }
async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > limit) throw new AppError('PROVIDER_OUTPUT_LIMIT', `Provider output exceeds ${limit} bytes`); chunks.push(value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function runScript(input: unknown, cursor?: string): Promise<{ events: UsageEvent[]; cursor?: string }> {
  const { status: _status, ...config } = input as Record<string, unknown>;
  const p = providerSchema.parse(config);
  if (!p.command) throw new AppError('PROVIDER_INVALID', 'Missing script command');
  const proc = Bun.spawn(p.command, { cwd: p.cwd ? expand(p.cwd) : undefined, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true });
  const stopTree = () => {
    if (process.platform === 'win32') {
      Bun.spawnSync(['taskkill', '/pid', String(proc.pid), '/t', '/f'], { stdout: 'ignore', stderr: 'ignore' });
    } else {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { if (proc.exitCode === null) proc.kill(9); }
    }
  };
  process.once('exit', stopTree);
  let timer: ReturnType<typeof setTimeout>;
  try {
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { stopTree(); reject(new AppError('PROVIDER_TIMEOUT', `Provider ${p.id} timed out after ${p.timeoutMs}ms`)); }, p.timeoutMs); });
    proc.stdin.write(JSON.stringify({ protocolVersion: 1, action: 'collect', cursor: cursor ?? null }) + '\n'); proc.stdin.end();
    const work = Promise.all([readBounded(proc.stdout, 16 * 1024 * 1024), readBounded(proc.stderr, 64 * 1024), proc.exited]);
    const [stdout, , code] = await Promise.race([work, deadline]);
    if (code !== 0) throw new AppError('PROVIDER_EXIT', `Provider ${p.id} exited with code ${code}; inspect the script directly for diagnostics`);
    let parsed: unknown; try { parsed = JSON.parse(stdout); } catch { throw new AppError('PROVIDER_PROTOCOL', 'stdout must be one protocol JSON object; send logs to stderr'); }
    const response = z.object({ protocolVersion: z.literal(1), events: z.array(z.record(z.string(), z.unknown())).max(50000), cursor: z.string().max(4096).optional() }).strict().parse(parsed);
    return { events: response.events.map(e => eventSchema.parse({ ...e, source: p.id, ...(p.vendor ? { vendor: p.vendor } : {}), ...(p.channel ? { channel: p.channel } : {}) })), cursor: response.cursor };
  } finally { clearTimeout(timer!); process.off('exit', stopTree); stopTree(); }
}
function filesAt(path: string, kind: Provider['kind']): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  const result: string[] = [];
  for (const item of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, item.name);
    if (item.isDirectory()) result.push(...filesAt(file, kind));
    else if (item.isFile() && (kind === 'workbuddy' ? /^trace_.*\.json$/.test(item.name) : /\.(jsonl|json|sqlite)$/.test(item.name))) result.push(file);
  }
  return result.sort();
}
function cherryDatabase(file: string): any[] {
  const db = new Database(file, { readonly: true });
  try {
    const columns = db.query('PRAGMA table_info(ai_usage_record)').all().map((x: any) => x.name);
    const required = ['id', 'record_kind', 'model_id', 'input_tokens', 'output_tokens', 'created_at'];
    if (!required.every(k => columns.includes(k))) throw new AppError('SOURCE_FORMAT', 'Cherry database has no supported ai_usage_record table. Use a JSON message export or update source path.');
    const allowed = ['id', 'request_id', 'record_kind', 'message_id', 'source_id', 'provider_id', 'model_id', 'input_tokens', 'output_tokens', 'no_cache_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost', 'cost_currency', 'cost_source', 'created_at'];
    return db.query(`SELECT ${allowed.filter(k => columns.includes(k)).join(',')} FROM ai_usage_record ORDER BY created_at`).all();
  } finally { db.close(); }
}
function flattenCherry(x: any): any[] {
  if (Array.isArray(x)) return x.flatMap(flattenCherry);
  if (!x || typeof x !== 'object') return [];
  if (x.role === 'assistant' && x.usage || x.record_kind !== undefined) return [x];
  // Only known export containers, never arbitrary recursive payloads.
  return ['messages', 'topics', 'assistants', 'data'].flatMap(k => x[k] ? flattenCherry(x[k]) : []);
}
async function readRecords(file: string, p: Provider): Promise<{ records: any[]; warnings: string[] }> {
  if (p.kind === 'cherry' && ['.sqlite', '.db'].includes(extname(file))) return { records: cherryDatabase(file), warnings: [] };
  if (statSync(file).size > 256 * 1024 * 1024) throw new AppError('SOURCE_TOO_LARGE', 'File exceeds 256 MiB; split or export it before collection');
  if (extname(file) === '.json') {
    const x = await Bun.file(file).json(); return { records: p.kind === 'cherry' ? flattenCherry(x) : Array.isArray(x) ? x : [x], warnings: [] };
  }
  const records: any[] = [], warnings: string[] = [];
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let index = 0;
  for await (const line of lines) {
    index++; if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.message) r.message.content = undefined;
      if (r.type === 'response_item') continue;
      if (['message', 'assistant', 'session', 'session_meta', 'turn_context', 'event_msg'].includes(r.type)) records.push(r);
      else if (p.kind === 'cherry' && r.usage) records.push(r);
    } catch { if (warnings.length < 10) warnings.push(`Incomplete or malformed JSONL line ${index}`); }
  }
  return { records, warnings };
}
const running = new WeakMap<Store, Promise<any>>();
export async function sync(store: Store, options: { id?: string; force?: boolean } = {}): Promise<any> {
  if (running.has(store)) throw new AppError('SYNC_BUSY', 'Collection already running');
  const work = (async () => {
    const providers = store.providers().filter(p => p.enabled && (!options.id || p.id === options.id));
    if (options.id && !providers.length) throw new AppError('NOT_FOUND', 'Provider not found or disabled');
    const results: any[] = [];
    for (const p of providers) {
      const result = { id: p.id, state: 'ok', at: new Date().toISOString(), inserted: 0, updated: 0, unchanged: 0, files: 0, skippedFiles: 0, warnings: [] as string[], cursor: p.status?.cursor as string | undefined };
      try {
        if (p.kind === 'script') {
          const batch = await runScript(p, options.force ? undefined : p.status?.cursor);
          Object.assign(result, store.ingest(batch.events)); result.cursor = batch.cursor ?? result.cursor;
        } else {
          const files = [...new Set(p.paths.flatMap(path => filesAt(expand(path), p.kind)))]; result.files = files.length;
          if (!files.length) { result.state = 'missing'; result.warnings.push('No source files found; configure paths with providers put'); }
          for (const file of files) {
            const info = statSync(file), wal = existsSync(file + '-wal') ? statSync(file + '-wal') : null;
            // Revisit unchanged logs once when their normalization rules change.
            const parserVersion = p.kind === 'codex' ? 'cache-v3:' : p.kind === 'claude' ? 'cache-v2:' : '';
            const signature = `${parserVersion}${info.size}:${info.mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`;
            if (!options.force && store.fileSignature(p.id, file) === signature) { result.skippedFiles++; continue; }
            try {
              const raw = await readRecords(file, p), batch = parseRecords(p, raw.records, file);
              const counts = store.ingest(batch.events, p.kind === 'claude');
              result.inserted += counts.inserted; result.updated += counts.updated; result.unchanged += counts.unchanged;
              const warnings = [...raw.warnings, ...batch.warnings];
              for (const warning of warnings) if (result.warnings.length < 30) result.warnings.push(`${file}: ${warning}`);
              if (!warnings.length) store.setFileSignature(p.id, file, signature);
              else result.state = 'partial';
            } catch (error) { result.state = 'partial'; if (result.warnings.length < 30) result.warnings.push(`${file}: ${error instanceof Error ? error.message : 'read failed'}`); }
          }
        }
      } catch (error) { result.state = 'error'; result.warnings.push(error instanceof AppError ? `${error.code}: ${error.message}` : 'Provider failed validation or execution; check configuration and protocol'); }
      store.status(p.id, result); results.push(result);
    }
    return { results };
  })();
  running.set(store, work);
  try { return await work; } finally { running.delete(store); }
}
