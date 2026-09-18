import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app';
import { execute } from '../src/commands';

const build = await Bun.build({ entrypoints: [new URL('../web/app.ts', import.meta.url).pathname], target: 'browser', format: 'iife' });
if (!build.success) throw new Error('Cannot build dashboard test');
const script = await build.outputs[0].text();
const html = await Bun.file(new URL('../web/index.html', import.meta.url)).text();
const settle = async (condition: () => boolean) => {
  for (let i = 0; i < 200; i++) { if (condition()) return; await Bun.sleep(5); }
  throw new Error('Dashboard did not settle');
};

test('dashboard switches languages without refetching or changing filters and translates after sync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokonto-locale-dom-')), app = new App(dir);
  const window = new Window({ url: 'http://localhost:4318/?days=all&timezone=UTC', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  try {
    app.store.ingest([{ id: 'locale-event', source: 'my-agent', session: 's', model: 'claude-opus-4-8', timestamp: '2026-09-18T00:00:00Z', tokens: { input: 1234, output: 100 } }]);
    const commands: string[] = [];
    window.fetch = (async (_url: unknown, options: any) => {
      const { command, input } = JSON.parse(options.body); commands.push(command);
      // Never run real source collection in a DOM test.
      const data = command === 'sync' ? { results: [] } : await execute(app, command, input);
      return new Response(JSON.stringify({ ok: true, data }));
    }) as any;
    window.localStorage.setItem('tokonto.locale', 'en');
    window.setInterval = (() => 0) as any;
    window.document.write(html);
    // Evaluate only our locally built entry point, never third-party page scripts.
    const globals = { document: window.document, navigator: window.navigator, localStorage: window.localStorage, location: window.location, history: window.history, fetch: window.fetch, setInterval: window.setInterval, setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), FormData: window.FormData };
    new Function(...Object.keys(globals), script)(...Object.values(globals));
    const el = (id: string) => window.document.getElementById(id)!;
    await settle(() => !el('dashboard-results').hasAttribute('hidden') && !el('sync').hasAttribute('disabled'));
    expect(window.document.documentElement.lang).toBe('en');
    expect(el('page-title').textContent).toBe('Overview');
    const counts = el('metrics').textContent!.replace(/[^0-9.$%]/g, '');
    const url = window.location.href, requests = commands.length;
    const change = (language: string) => { (el('language') as any).value = language; el('language').dispatchEvent(new window.Event('change')); };
    window.document.querySelector('[data-page="pricing"]')!.dispatchEvent(new window.MouseEvent('click'));
    change('zh-CN');
    expect(el('page-title').textContent).toBe('价格规则');
    expect(el('pricing').hasAttribute('hidden')).toBe(false);
    expect(el('metrics').textContent!.replace(/[^0-9.$%]/g, '')).toBe(counts);
    expect(window.location.href).toBe(url);
    expect((el('timezone') as any).value).toBe('UTC');
    expect(commands.length).toBe(requests);
    expect(window.localStorage.getItem('tokonto.locale')).toBe('zh-CN');
    // This catches removal of translation markers when sync replaces button content.
    el('sync').dispatchEvent(new window.MouseEvent('click'));
    await settle(() => commands.includes('sync') && !el('sync').hasAttribute('disabled'));
    expect(el('sync').textContent).toContain('立即同步');
    change('en');
    expect(el('sync').textContent).toContain('Sync now');
    expect(el('toast').textContent).toBe('Sync complete: 0 records added');
    expect(el('page-title').textContent).toBe('Pricing');
    el('add-price').dispatchEvent(new window.MouseEvent('click'));
    expect(el('dialog-title').textContent).toBe('Add pricing rule');
    expect(el('dialog-content').textContent).toContain('Cache write rate (long-lived)');
    expect(el('dialog-content').textContent).not.toMatch(/[\u3400-\u9fff]/);
    el('close-dialog').dispatchEvent(new window.MouseEvent('click'));
    window.document.querySelector('[data-page="sources"]')!.dispatchEvent(new window.MouseEvent('click'));
    el('add-provider').dispatchEvent(new window.MouseEvent('click'));
    expect(el('dialog-title').textContent).toBe('Add source');
    expect(el('dialog-content').textContent).toContain('Script command arguments');
    expect(el('dialog-content').textContent).not.toMatch(/[\u3400-\u9fff]/);
    el('close-dialog').dispatchEvent(new window.MouseEvent('click'));
    change('zh-CN');
    el('add-provider').dispatchEvent(new window.MouseEvent('click'));
    expect(el('dialog-title').textContent).toBe('添加数据来源');
    expect(el('dialog-content').textContent).toContain('脚本命令参数');
    expect((await execute(app, 'usage stats', {}) as any).summary.events).toBe(1);
  } finally { await window.happyDOM.abort(); window.close(); app.close(); rmSync(dir, { recursive: true, force: true }); }
});
