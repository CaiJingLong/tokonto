import { validateRules } from './pricing';
import type { PriceRule } from './schema';
import Decimal from 'decimal.js';
// Verified public list-price snapshot; historical fallback is explicitly a reference estimate.
const verifiedAt = '2026-09-18T00:00:00Z';
const common = { currency: 'USD', channel: 'api', priority: 0, timezone: 'UTC', effectiveFrom: verifiedAt, verifiedAt };
const rules: unknown[] = [];
for (const [model, input, output, read] of [
  ['deepseek-flash', '0.15', '0.6', '0.003'], ['deepseek-v4-flash', '0.15', '0.6', '0.003'],
  ['deepseek-v4-flash-vision-exp', '0.15', '0.6', '0.003'], ['deepseek-v4-pro', '0.66', '1.98', '0.022'],
]) {
  const base = { ...common, model, vendor: 'deepseek', reference: 'https://api-docs.deepseek.com/quick_start/pricing/' };
  rules.push({ ...base, id: `official-${model}-offpeak-20260918`, label: 'DeepSeek 谷时 · 官方 API', rates: { input, output, cacheRead: read } });
  rules.push({ ...base, id: `official-${model}-peak-20260918`, label: 'DeepSeek 峰时 · 官方 API', priority: 10, weekdays: [1, 2, 3, 4, 5], windows: [{ start: '01:00', end: '04:00' }, { start: '06:00', end: '10:00' }], rates: { input: String(Number(input) * 2), output: String(Number(output) * 2), cacheRead: String(Number(read) * 2) } });
}
for (const model of ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929']) rules.push({ ...common, id: `official-${model}-20260918`, model, vendor: 'anthropic', label: 'Claude Sonnet · 官方 API', reference: 'https://platform.claude.com/docs/en/about-claude/pricing', rates: { input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75', cacheWriteLong: '6' } });
for (const model of ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8']) rules.push({ ...common, id: `official-${model}-20260918`, model, vendor: 'anthropic', label: 'Claude Opus · 官方 API', reference: 'https://platform.claude.com/docs/en/about-claude/pricing', rates: { input: '5', output: '25', cacheRead: '0.5', cacheWrite: '6.25', cacheWriteLong: '10' } });
rules.push({ ...common, id: 'official-gpt-4o-20260918', model: 'gpt-4o', vendor: 'openai', label: 'GPT-4o · 官方 API', reference: 'https://developers.openai.com/api/docs/models/gpt-4o', rates: { input: '2.5', output: '10', cacheRead: '1.25' } });
// Retain the exact v1 seed for a conservative migration: edited rules stay manual.
const legacyRules = [...rules];
export function legacyCatalog(): PriceRule[] { return validateRules(legacyRules); }
for (const [model, input, output, read, write, long] of [
  ['gpt-6-astra', '10', '50', '1', '12.5', true],
  ['gpt-5.6-sol', '4', '20', '0.4', '5', true],
  ['gpt-5.6-terra', '2', '12', '0.2', '2.5', true],
  ['gpt-5.6-luna', '0.2', '1.2', '0.02', '0.25', true],
  ['gpt-5.5', '5', '30', '0.5', undefined, true],
  ['gpt-5.4', '2.5', '15', '0.25', undefined, true],
  ['gpt-5.3-codex', '1.75', '14', '0.175', undefined, false],
] as const) {
  const rates = { input, output, cacheRead: read, ...(write ? { cacheWrite: write } : {}) };
  rules.push({ ...common, id: `official-${model}-20260918`, model, vendor: 'openai', label: `${model} · 官方标准 API`, reference: `https://developers.openai.com/api/docs/models/${model}`, rates,
    ...(long ? { tiers: [{ from: 272001, rates: { input: new Decimal(input).mul(2).toFixed(), output: new Decimal(output).mul('1.5').toFixed(), cacheRead: new Decimal(read).mul(2).toFixed(), ...(write ? { cacheWrite: new Decimal(write).mul(2).toFixed() } : {}) } }] } : {}) });
}
for (const [model, input, output, read] of [
  ['glm-5.3-flash', '0.15', '0.5', '0.03'], ['glm-5.3-flashx', '0.37', '1.25', '0.075'],
  ['glm-5.3', '1.4', '4.4', '0.26'], ['glm-5.2', '1.4', '4.4', '0.26'], ['glm-5.1', '1.4', '4.4', '0.26'],
  ['glm-5', '1', '3.2', '0.2'], ['glm-4.7', '0.6', '2.2', '0.11'], ['glm-4.6', '0.6', '2.2', '0.11'],
  ['glm-4.5', '0.6', '2.2', '0.11'], ['glm-4.5-flash', '0', '0', '0'], ['glm-4.7-flash', '0', '0', '0'],
]) rules.push({ ...common, id: `official-${model}-20260918`, model, vendor: 'z-ai', label: `${model} · Z.AI 标准 API`, reference: 'https://docs.z.ai/guides/overview/pricing', rates: { input, output, cacheRead: read } });
for (const [model, input, output, read] of [['claude-fable-5', '10', '50', '1'], ['claude-opus-5', '5', '25', '0.5'], ['claude-opus-4-5', '5', '25', '0.5'], ['claude-sonnet-5', '2', '10', '0.2'], ['claude-haiku-4-5', '1', '5', '0.1']]) {
  rules.push({ ...common, id: `official-${model}-20260918`, model, vendor: 'anthropic', label: `${model} · 官方 API`, reference: 'https://platform.claude.com/docs/en/about-claude/pricing', rates: { input, output, cacheRead: read, cacheWrite: new Decimal(input).mul('1.25').toFixed(), cacheWriteLong: new Decimal(input).mul(2).toFixed() } });
}
export function catalog(): PriceRule[] { return validateRules(rules); }
export const catalogNote = '手动规则优先；未匹配时自动按模型预设价估算。预设核验于 2026-09-18，覆盖部分常用模型；历史或未知渠道按该快照作参考估算，不代表实际账单。未知模型、缺失费率与不完整用量仍保留未定价。';
