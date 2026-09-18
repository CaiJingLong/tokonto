import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { App } from './app';
import { execute, errorResult, serverSchema } from './commands';
import { sync } from './providers/collect';
import { AppError } from './schema';
import { VERSION } from './version';
export async function startServer(app: App, input: unknown) {
  const opts = serverSchema.parse(input), root = existsSync(join(import.meta.dir, 'web/index.html')) ? join(import.meta.dir, 'web') : join(import.meta.dir, '../web');
  const build = await Bun.build({ entrypoints: [join(root, existsSync(join(root, 'app.ts')) ? 'app.ts' : 'app.js')], target: 'browser', minify: true });
  if (!build.success) throw new AppError('BUILD_FAILED', build.logs.map(String).join('\n'));
  const assets = new Map<string, { body: string; type: string }>([
    ['/', { body: await Bun.file(join(root, 'index.html')).text(), type: 'text/html; charset=utf-8' }],
    ['/app.js', { body: await build.outputs[0].text(), type: 'text/javascript; charset=utf-8' }],
    ['/style.css', { body: await Bun.file(join(root, 'style.css')).text(), type: 'text/css; charset=utf-8' }],
  ]);
  const allowed = new Set(['providers list', 'providers put', 'providers remove', 'prices list', 'prices catalog', 'prices put', 'prices remove', 'prices explain', 'prices history', 'prices reprice', 'prices fill', 'usage stats', 'usage dashboard', 'usage list', 'usage export', 'sync', 'doctor', 'audit list']);
  const envelope = z.object({ command: z.string(), input: z.unknown().default({}) }).strict();
  const server = Bun.serve({
    hostname: '127.0.0.1', port: opts.port, maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(req, server) {
      const url = new URL(req.url), host = req.headers.get('host');
      const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'", 'Referrer-Policy': 'no-referrer' };
      const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
      if (![`${server.hostname}:${server.port}`, `localhost:${server.port}`].includes(host ?? '')) return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Invalid local Host header' } }, 403);
      const origin = req.headers.get('origin');
      if (origin && origin !== `http://${host}`) return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Cross-origin request rejected' } }, 403);
      if (req.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, data: { version: VERSION } });
      if (req.method === 'GET' && assets.has(url.pathname)) { const a = assets.get(url.pathname)!; return new Response(a.body, { headers: { ...headers, 'Content-Type': a.type } }); }
      if (url.pathname === '/api/command' && req.method === 'POST') {
        if (req.headers.get('x-token-usage') !== '1' || !req.headers.get('content-type')?.startsWith('application/json')) return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Explicit JSON application request required' } }, 403);
        try {
          const body = envelope.parse(await req.json());
          if (!allowed.has(body.command)) throw new AppError('FORBIDDEN', 'This operation is available only through the local CLI');
          return json({ ok: true, data: await execute(app, body.command, body.input) });
        } catch (error) { return json(errorResult(error), error instanceof AppError && error.code === 'SYNC_BUSY' ? 409 : 400); }
      }
      return json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
  const collect = async () => {
    try { await sync(app.store); } catch (e) { console.error('Collection:', e instanceof Error ? e.message : e); }
    if (!stopped && opts.interval > 0) timer = setTimeout(collect, opts.interval * 1000);
  };
  if (opts.interval > 0) timer = setTimeout(collect, 100);
  const originalStop = server.stop.bind(server);
  server.stop = ((force?: boolean) => { stopped = true; clearTimeout(timer); return originalStop(force); }) as typeof server.stop;
  return server;
}
