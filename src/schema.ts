import { z } from 'zod';
import { DateTime, IANAZone } from 'luxon';
export const id = z.string().min(1).max(300);
export const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const timestamp = z.string().datetime({ offset: true }).refine(s => DateTime.fromISO(s).isValid, 'Invalid calendar date');
export const zone = z.string().refine(s => s === 'UTC' || IANAZone.isValidZone(s), 'Invalid IANA timezone');
export const money = z.string().max(100).regex(/^(0|[1-9]\d*)(\.\d{1,36})?$/, 'Use a nonnegative decimal string');
export const currency = z.string().regex(/^[A-Z]{3}$/);
export const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWriteLong'] as const;
export const tokensSchema = z.object({ input: count, output: count, cacheRead: count.default(0), cacheWrite: count.default(0), cacheWriteLong: count.default(0) }).strict();
export const eventSchema = z.object({
  id, source: id, session: id, timestamp, model: id, vendor: id.default('unknown'), channel: id.default('unknown'),
  tokens: tokensSchema, contextTokens: count.optional(), project: z.string().max(2000).optional(),
  usageStatus: z.enum(['complete', 'incomplete']).optional(),
  reportedCost: z.object({ amount: money, currency, kind: z.enum(['reported', 'estimated']) }).strict().optional(),
  warnings: z.array(z.string().max(500)).max(30).optional(),
}).strict();
export type UsageEvent = z.infer<typeof eventSchema>;
const ratesSchema = z.object({ input: money, output: money, cacheRead: money.optional(), cacheWrite: money.optional(), cacheWriteLong: money.optional() }).strict();
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => DateTime.fromISO(s).isValid, 'Invalid date');
export const ruleSchema = z.object({
  id, model: id, vendor: id, channel: id.default('api'), currency,
  priority: z.number().int().min(-10000).max(10000).default(0), timezone: zone.default('UTC'),
  effectiveFrom: timestamp.optional(), effectiveTo: timestamp.optional(), dateFrom: calendarDate.optional(), dateTo: calendarDate.optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  windows: z.array(z.object({ start: clock, end: clock }).strict()).min(1).max(20).optional(),
  rates: ratesSchema, tiers: z.array(z.object({ from: count, rates: ratesSchema }).strict()).max(20).optional(),
  label: z.string().max(300).optional(), reference: z.string().url().optional(), verifiedAt: timestamp.optional(), revision: z.number().int().positive().optional(),
}).strict();
export type PriceRule = z.infer<typeof ruleSchema>;
export const querySchema = z.object({
  from: timestamp.optional(), to: timestamp.optional(), source: id.optional(), model: id.optional(), vendor: id.optional(), channel: id.optional(), session: id.optional(),
  timezone: zone.default('UTC'), groupBy: z.enum(['hour', 'day', 'month', 'source', 'model', 'session', 'rule']).default('day'),
}).strict().refine(q => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), 'from must be before to');
export type Query = z.infer<typeof querySchema>;
export const providerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), name: id, kind: z.enum(['codex', 'claude', 'omp', 'workbuddy', 'cherry', 'script']),
  paths: z.array(z.string().min(1)).default([]), command: z.array(z.string().min(1)).min(1).optional(), cwd: z.string().optional(),
  timeoutMs: z.number().int().min(100).max(300000).default(30000), enabled: z.boolean().default(true), vendor: id.optional(), channel: id.optional(),
}).strict().refine(p => p.kind !== 'script' || p.command, 'Script providers require command argv');
export type Provider = z.infer<typeof providerSchema>;
export class AppError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
