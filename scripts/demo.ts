import { App } from '../src/app';
import { DateTime } from 'luxon';
const dir = process.argv[2];
if (!dir) throw new Error('Usage: bun scripts/demo.ts /path/to/isolated-demo-data');
const app = new App(dir);
try {
  if (app.store.events().some(e => !e.id.startsWith('demo-'))) throw new Error('Refusing to mix demo with existing real usage');
  const sources = ['codex', 'claude-code', 'omp', 'cherry-studio', 'workbuddy'];
  const models = ['gpt-5.4', 'claude-sonnet-4-6', 'deepseek-flash', 'claude-opus-4-8'];
  app.store.putRules(models.map((model, i) => ({ id: `demo-${model}`, model, vendor: 'demo', channel: 'api', currency: 'USD', label: '演示价格 · 非官方定价', rates: { input: ['2.5', '3', '0.15', '5'][i], output: ['15', '15', '0.6', '25'][i], cacheRead: ['0.25', '0.3', '0.003', '0.5'][i] } })));
  let seed = 42; const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const events = [];
  for (let d = 0; d < 30; d++) for (let i = 0; i < 8 + Math.floor(rand() * 15); i++) {
    const source = sources[Math.floor(rand() * sources.length)], model = models[Math.floor(rand() * models.length)];
    events.push({ id: `demo-${d}-${i}`, source, session: `demo-session-${d}-${source}`, vendor: 'demo', channel: 'api', model,
      timestamp: DateTime.now().toUTC().startOf('day').minus({ days: 29 - d }).plus({ hours: 2 + Math.floor(rand() * 17), minutes: Math.floor(rand() * 60) }).toISO(),
      tokens: { input: Math.floor(rand() * 130000) + 8000, output: Math.floor(rand() * 12000) + 400, cacheRead: Math.floor(rand() * 65000) }, warnings: ['Synthetic demonstration record'] });
  }
  app.store.ingest(events);
  for (const { status, ...p } of app.store.providers()) { app.store.putProvider({ ...p, enabled: false }); app.store.status(p.id, { state: 'demo', at: new Date().toISOString(), inserted: events.filter(e => e.source === p.id).length }); }
  console.log(JSON.stringify({ dataDir: app.dataDir, records: events.length, demo: true }));
} finally { app.close(); }
