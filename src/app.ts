import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Store } from './store';
import { defaults } from './providers/collect';
import { legacyCatalog } from './catalog';
export class App {
  store: Store; dataDir: string;
  constructor(dataDir = process.env.TOKEN_USAGE_HOME ?? join(homedir(), '.token-usage')) {
    this.dataDir = resolve(dataDir); this.store = new Store(join(this.dataDir, 'usage.sqlite'));
    const initialized = this.store.db.query("SELECT id FROM audit WHERE action='init' LIMIT 1").get();
    if (!initialized) this.store.db.transaction(() => {
      for (const p of defaults()) this.store.putProvider(p);
      this.store.audit('init', { version: 2 });
    }).immediate();
    if (!this.store.db.query("SELECT id FROM audit WHERE action='pricing.presets.v1' LIMIT 1").get()) this.store.db.transaction(() => {
      const seeds = new Map(legacyCatalog().map(r => [r.id, JSON.stringify(r)])), archived: string[] = [];
      for (const { revision, ...r } of this.store.rules()) {
        if (revision === 1 && seeds.get(r.id) === JSON.stringify(r)) {
          this.store.db.query('UPDATE rules SET active=0 WHERE id=? AND revision=1').run(r.id); archived.push(r.id);
        }
      }
      this.store.audit('pricing.presets.v1', { archivedSeedRules: archived, historicalQuotesUnchanged: true });
    }).immediate();
  }
  close() { this.store.close(); }
}
