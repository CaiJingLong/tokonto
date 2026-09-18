import { messages } from './messages';
export { messages } from './messages';
export type Locale = 'zh-CN' | 'en';
export type MessageKey = keyof typeof messages;

export function chooseLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === 'en' || saved === 'zh-CN') return saved;
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN';
    if (/^en(?:-|$)/i.test(language)) return 'en';
  }
  return 'en';
}

export function translate(locale: Locale, key: MessageKey, values: Record<string, string | number> = {}): string {
  return messages[key][locale === 'zh-CN' ? 0 : 1].replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
}
