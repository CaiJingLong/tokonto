import type { Database } from 'bun:sqlite';

// A rebuildable projection: financial snapshots remain authoritative in events.
// Database triggers also cover imports/repricing performed by another process.
export function ensureStatisticsIndex(db: Database) {
  db.transaction(() => {
    if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_stats_v1'").get()) return;
    const fields: [string, string, string][] = [
      ['source', 'TEXT NOT NULL', 'source'], ['id', 'TEXT NOT NULL', 'id'], ['time', 'INTEGER NOT NULL', 'time'],
      ...['model', 'vendor', 'channel', 'session'].map(k => [k, 'TEXT NOT NULL', `json_extract(data,'$.${k}')`] as [string, string, string]),
      ...['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWriteLong'].map(k => [k, 'INTEGER NOT NULL', `coalesce(json_extract(data,'$.tokens.${k}'),0)`] as [string, string, string]),
      ...[['priceStatus', 'status'], ['priceSource', 'source'], ['amount', 'amount'], ['currency', 'currency'], ['ruleId', 'rule.id']].map(([k, path]) => [k, 'TEXT', `json_extract(quote,'$.${path}')`] as [string, string, string]),
      ...[['reportedAmount', 'amount'], ['reportedCurrency', 'currency'], ['reportedKind', 'kind']].map(([k, path]) => [k, 'TEXT', `json_extract(data,'$.reportedCost.${path}')`] as [string, string, string]),
    ];
    const columns = fields.map(([name]) => name).join(','), expressions = fields.map(([, , sql]) => sql);
    const selectNew = expressions.map(sql => sql.replace(/\b(data|quote|source|id|time)\b(?=(?:,|\)|$))/g, 'new.$1')).join(',');
    db.exec(`CREATE TABLE event_stats_v1 (${fields.map(([name, type]) => `${name} ${type}`).join(',')}, PRIMARY KEY(source,id)) WITHOUT ROWID;
      INSERT INTO event_stats_v1 (${columns}) SELECT ${expressions.join(',')} FROM events;
      CREATE INDEX event_stats_time ON event_stats_v1(time);
      CREATE INDEX event_stats_model_time ON event_stats_v1(model,time);
      CREATE TRIGGER event_stats_insert AFTER INSERT ON events BEGIN
        INSERT OR REPLACE INTO event_stats_v1 (${columns}) VALUES (${selectNew}); END;
      CREATE TRIGGER event_stats_update AFTER UPDATE ON events BEGIN
        DELETE FROM event_stats_v1 WHERE source=old.source AND id=old.id;
        INSERT OR REPLACE INTO event_stats_v1 (${columns}) VALUES (${selectNew}); END;
      CREATE TRIGGER event_stats_delete AFTER DELETE ON events BEGIN
        DELETE FROM event_stats_v1 WHERE source=old.source AND id=old.id; END;`);
  }).immediate();
}
