import Decimal from 'decimal.js';
import { DateTime } from 'luxon';
import { AppError, eventSchema, ruleSchema, tokenKeys, type PriceRule, type UsageEvent } from './schema';
Decimal.set({ precision: 40 });
export type Quote = {
  status: 'priced' | 'unpriced' | 'conflict'; amount?: string; currency?: string;
  rule?: PriceRule; breakdown?: Record<string, string>; reason?: string; candidates?: string[]; tierFrom?: number;
  source?: 'custom' | 'preset'; presetModel?: string; assumptions?: string[];
};
const minute = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
function scheduled(r: PriceRule, local: DateTime): boolean {
  const m = local.hour * 60 + local.minute;
  const days = r.weekdays ?? [1, 2, 3, 4, 5, 6, 7];
  const dateMatches = (d: DateTime) => (!r.dateFrom || d.toISODate()! >= r.dateFrom) && (!r.dateTo || d.toISODate()! < r.dateTo);
  if (!r.windows) return days.includes(local.weekday) && dateMatches(local);
  return r.windows.some(w => {
    const start = minute(w.start), end = minute(w.end);
    const anchor = start > end && m < end ? local.minus({ days: 1 }) : local;
    return (start < end ? m >= start && m < end : m >= start || m < end) && days.includes(anchor.weekday) && dateMatches(anchor);
  });
}
export function matches(r: PriceRule, e: UsageEvent): boolean {
  if (r.model !== '*' && r.model !== e.model || r.vendor !== '*' && r.vendor !== e.vendor || r.channel !== '*' && r.channel !== e.channel) return false;
  const t = Date.parse(e.timestamp);
  if (r.effectiveFrom && t < Date.parse(r.effectiveFrom) || r.effectiveTo && t >= Date.parse(r.effectiveTo)) return false;
  return scheduled(r, DateTime.fromMillis(t, { zone: r.timezone }));
}
export function price(input: unknown, inputRules: unknown[]): Quote {
  const e = eventSchema.parse(input), rules = inputRules.map(r => ruleSchema.parse(r));
  const candidates = rules.filter(r => matches(r, e)).sort((a, b) => b.priority - a.priority);
  if (!candidates.length) return { status: 'unpriced', reason: 'No matching model/vendor/channel/date rule' };
  const top = candidates.filter(r => r.priority === candidates[0].priority);
  if (top.length > 1) return { status: 'conflict', reason: 'Multiple rules have the same highest priority', candidates: top.map(r => r.id).sort() };
  return priceSnapshot(e, top[0]);
}
// Revisions retain the selected rule, even when corrected metadata would no
// longer match it. Only explicit repricing is allowed to select a new rule.
export function priceSnapshot(input: unknown, snapshot: unknown): Quote {
  const e = eventSchema.parse(input), r = ruleSchema.parse(snapshot);
  // Keep the matching rule snapshot so a later usage correction can recover
  // with the original rates. Incomplete categories must never quote zero cost.
  if (e.usageStatus === 'incomplete') return { status: 'unpriced', reason: 'Usage categories are incomplete or inconsistent; cannot determine cost', rule: r };
  const context = e.contextTokens ?? e.tokens.input + e.tokens.cacheRead + e.tokens.cacheWrite + e.tokens.cacheWriteLong;
  const tier = r.tiers?.filter(t => context >= t.from).sort((a, b) => b.from - a.from)[0];
  const rates = tier?.rates ?? r.rates;
  const breakdown: Record<string, string> = {};
  let total = new Decimal(0);
  for (const key of tokenKeys) {
    if (e.tokens[key] > 0 && rates[key] === undefined) return { status: 'unpriced', reason: `Missing ${key} rate`, rule: r };
    const cost = new Decimal(e.tokens[key]).mul(rates[key] ?? '0').div(1_000_000);
    breakdown[key] = cost.toFixed(); total = total.plus(cost);
  }
  return { status: 'priced', amount: total.toFixed(), currency: r.currency, rule: r, breakdown, ...(tier ? { tierFrom: tier.from } : {}) };
}
function overlaps(a: PriceRule, b: PriceRule): boolean {
  for (const k of ['model', 'vendor', 'channel'] as const) if (a[k] !== '*' && b[k] !== '*' && a[k] !== b[k]) return false;
  const low = Math.max(a.effectiveFrom ? Date.parse(a.effectiveFrom) : -Infinity, b.effectiveFrom ? Date.parse(b.effectiveFrom) : -Infinity);
  const high = Math.min(a.effectiveTo ? Date.parse(a.effectiveTo) : Infinity, b.effectiveTo ? Date.parse(b.effectiveTo) : Infinity);
  if (low >= high) return false;
  // Different zones can shift at DST transitions: conservatively reject potential ambiguity.
  if (a.timezone !== b.timezone) return true;
  const spills = (r: PriceRule) => r.windows?.some(w => w.start > w.end && w.end !== '00:00') ?? false;
  const endsBefore = (r: PriceRule, next: PriceRule) => r.dateTo && next.dateFrom && (r.dateTo < next.dateFrom || r.dateTo === next.dateFrom && !spills(r));
  if (endsBefore(a, b) || endsBefore(b, a)) return false;
  const occupies = (r: PriceRule) => {
    const set = new Set<number>();
    for (const d of r.weekdays ?? [1, 2, 3, 4, 5, 6, 7]) for (const w of r.windows ?? [{ start: '00:00', end: '00:00' }]) {
      const start = minute(w.start), end = minute(w.end), duration = end > start ? end - start : 1440 - start + end;
      for (let m = 0; m < duration; m++) set.add(((d - 1) * 1440 + start + m) % 10080);
    }
    return set;
  };
  const aa = occupies(a), bb = occupies(b); return [...aa].some(m => bb.has(m));
}
export function validateRules(input: unknown[]): PriceRule[] {
  const rules = input.map(r => ruleSchema.parse(r)); const ids = new Set<string>();
  for (const r of rules) {
    if (ids.has(r.id)) throw new AppError('RULE_INVALID', `Duplicate rule id: ${r.id}`); ids.add(r.id);
    if (r.effectiveFrom && r.effectiveTo && Date.parse(r.effectiveFrom) >= Date.parse(r.effectiveTo)) throw new AppError('RULE_INVALID', 'effectiveFrom must precede effectiveTo');
    if (r.dateFrom && r.dateTo && r.dateFrom >= r.dateTo) throw new AppError('RULE_INVALID', 'dateFrom must precede dateTo');
    if (r.windows?.some(w => w.start === w.end)) throw new AppError('RULE_INVALID', 'Equal window endpoints are ambiguous; omit windows for all day');
    if (r.tiers && new Set(r.tiers.map(t => t.from)).size !== r.tiers.length) throw new AppError('RULE_INVALID', 'Duplicate context tier');
  }
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    if (rules[i].priority === rules[j].priority && overlaps(rules[i], rules[j])) throw new AppError('RULE_CONFLICT', `Potential overlap: ${rules[i].id} / ${rules[j].id}. Use distinct priorities or disjoint periods.`);
  }
  return rules;
}
