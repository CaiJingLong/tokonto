#!/usr/bin/env bun
import { App } from './app';
import { VERSION } from './version';
import { AppError } from './schema';
import { commands, discovery, execute, errorResult, serverSchema } from './commands';
function parse(argv: string[]) {
  const words: string[] = [], flags: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] === '-V' ? '--version' : argv[i]; if (a === '--') continue; if (!a.startsWith('--')) { words.push(a); continue; }
    const eq = a.indexOf('='), key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, x) => x.toUpperCase());
    if (Object.hasOwn(flags, key)) throw new AppError('VALIDATION_ERROR', `Repeated flag: ${key}`);
    const booleans = ['json', 'help', 'version', 'dryRun', 'open', 'force', 'history', 'apply'];
    let value: any = eq > 0 ? a.slice(eq + 1) : booleans.includes(key) ? ['true', 'false'].includes(argv[i + 1]) ? argv[++i] : true : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : undefined;
    if (value === undefined) throw new AppError('VALIDATION_ERROR', `Missing value for --${key}`);
    if (booleans.includes(key) && typeof value === 'string') { if (!['true', 'false'].includes(value)) throw new AppError('VALIDATION_ERROR', `--${key} requires true or false`); value = value === 'true'; }
    else if (['port', 'interval', 'limit', 'offset'].includes(key)) value = Number(value);
    flags[key] = value;
  }
  return { name: words.join(' '), flags };
}
let app: App | undefined;
try {
  const { name, flags } = parse(process.argv.slice(2)); const { dataDir, json, input, help, version, ...options } = flags;
  if (version) {
    console.log(json ? JSON.stringify({ ok: true, data: { name: 'token-usage', version: VERSION } }) : VERSION);
  } else if (!name || name === 'schema' || help) {
    const output = discovery(help && name ? name : options.command);
    if (json || name === 'schema') console.log(JSON.stringify({ ok: true, data: output }));
    else {
      console.log('token-usage · 本地 AI 用量与分时计费\n\n用法: token-usage <command> [--input @file.json] [--json] [--data-dir path]\n');
      for (const c of output.commands) console.log(`${c.name.padEnd(20)} ${c.description}`);
      if (help && name) console.log('\n' + JSON.stringify(output.commands[0]?.inputSchema, null, 2));
      console.log('\nAI 调用: token-usage schema --json\n版本: token-usage --version (-V)');
    }
  } else {
    let payload: any = {};
    if (input !== undefined) {
      const text = input === '-' ? await Bun.stdin.text() : input.startsWith('@') ? await Bun.file(input.slice(1)).text() : input;
      try { payload = JSON.parse(text); } catch { throw new AppError('INVALID_JSON', '--input requires a JSON object'); }
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new AppError('INVALID_JSON', '--input requires a JSON object');
    }
    payload = { ...payload, ...options };
    if (name !== 'server' && !commands.some(c => c.name === name)) throw new AppError('UNKNOWN_COMMAND', `Unknown command: ${name}; run schema --json`);
    app = new App(dataDir);
    if (name === 'server') {
      const opts = serverSchema.parse(payload); const { startServer } = await import('./server');
      const server = await startServer(app, opts);
      console.log(JSON.stringify({ ok: true, data: { url: server.url.toString(), dataDir: app.dataDir, pid: process.pid } }));
      console.error(`Dashboard: ${server.url}`);
      if (opts.open) { const args = process.platform === 'darwin' ? ['open', server.url.toString()] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', server.url.toString()] : ['xdg-open', server.url.toString()]; Bun.spawn(args, { stdout: 'ignore', stderr: 'ignore' }); }
      const runtimeApp = app;
      const stop = () => { server.stop(true); runtimeApp.close(); process.exit(0); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
      app = undefined; // Owned by the running server.
    } else {
      const data = await execute(app, name, payload); console.log(JSON.stringify({ ok: true, data }, null, json ? undefined : 2));
      if (name === 'sync' && (data as any).results.some((r: any) => r.state === 'error' || r.state === 'partial')) process.exitCode = 2;
    }
  }
} catch (error) { console.log(JSON.stringify(errorResult(error))); process.exitCode = 1; }
finally { app?.close(); }
