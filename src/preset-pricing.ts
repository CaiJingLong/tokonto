import { catalog } from './catalog';
import { price, priceSnapshot, type Quote } from './pricing';
import type { PriceRule, UsageEvent } from './schema';

// Presets are reference estimates, separate from user rules and actual bills.
const bundled = catalog();
const aliases: Record<string, string> = {
  'claude-opus-4.8': 'claude-opus-4-8', 'claude-opus-4.7': 'claude-opus-4-7', 'claude-opus-4.6': 'claude-opus-4-6',
  'claude-sonnet-4.5': 'claude-sonnet-4-5', 'claude-4.5-sonnet': 'claude-sonnet-4-5', 'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'glm-5-2': 'glm-5.2', 'gpt-5.6': 'gpt-5.6-sol',
};
const byModel = new Map<string, PriceRule[]>();
function presetsFor(model: string) {
  if (!byModel.has(model)) {
    const canonical = aliases[model] ?? model;
    byModel.set(model, bundled.filter(r => r.model === canonical).map(r => {
      const { effectiveFrom, effectiveTo, ...reference } = r;
      return { ...reference, model, vendor: '*', channel: '*', id: `preset:${r.id}` };
    }));
  }
  return byModel.get(model)!;
}
export function resolvePrice(e: UsageEvent, manual: PriceRule[]): Quote {
  const custom = price(e, manual);
  // A matched manual rule with missing rates or conflicts must be fixed by its
  // author, never silently replaced with a cheaper preset.
  if (custom.rule || custom.status === 'conflict') return { ...custom, source: 'custom' };
  const preset = presetsFor(e.model);
  if (!preset.length) return custom;
  const quote = price(e, preset);
  return { ...quote, source: 'preset', presetModel: aliases[e.model] ?? e.model, assumptions: [
    '按内置官方标准 API 参考价估算，不代表订阅、代理或实际账单。',
    `价格快照核验于 ${preset[0].verifiedAt?.slice(0, 10)}；历史记录按该快照估算，不保证当日实际价格。`,
  ] };
}
export function updatePinnedPrice(e: UsageEvent, old: Quote): Quote {
  if (!old.rule) return old;
  return { ...priceSnapshot(e, old.rule), ...(old.source ? { source: old.source } : {}), ...(old.presetModel ? { presetModel: old.presetModel } : {}), ...(old.assumptions ? { assumptions: old.assumptions } : {}) };
}
