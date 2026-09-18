import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app';
import { startServer } from '../src/server';
test('dashboard shares CLI logic and rejects cross-origin mutations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'token-server-')), app = new App(root);
  let server: any;
  try {
    server = await startServer(app, { port: 0, interval: 0, open: false }); const base = server.url.toString();
    const html = await fetch(base).then(r => r.text()); expect(html).toContain('Token Usage');
    const query = (command: string, input: any, headers = {}) => fetch(base + 'api/command', { method: 'POST', headers: { 'content-type': 'application/json', 'x-token-usage': '1', ...headers }, body: JSON.stringify({ command, input }) });
    const stats = await query('usage stats', {}); expect((await stats.json() as any).data.summary.events).toBe(0);
    const dashboard = await query('usage dashboard', {}); expect((await dashboard.json() as any).data.trend.summary.events).toBe(0);
    expect((await query('sync', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(base + 'api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await query('usage stats', { timezone: 'not-a-zone' })).status).toBe(400);
    expect((await fetch(base + 'app.js')).headers.get('content-type')).toContain('javascript');
  } finally { server?.stop(true); app.close(); rmSync(root, { recursive: true, force: true }); }
});
