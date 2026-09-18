import { expect, test } from 'bun:test';
import { chooseLocale, translate, messages } from '../web/i18n';

test('saved language overrides browser preferences with a deterministic English fallback', () => {
  expect(chooseLocale('en', ['zh-CN'])).toBe('en');
  expect(chooseLocale('zh-CN', ['en-US'])).toBe('zh-CN');
  expect(chooseLocale(null, ['zh-TW', 'en'])).toBe('zh-CN');
  expect(chooseLocale('invalid', ['de-DE', 'en-GB'])).toBe('en');
  expect(chooseLocale(null, [])).toBe('en');
});

test('translations interpolate whole messages without changing data values', () => {
  expect(translate('en', 'records.count', { count: '1,234' })).toBe('1,234 records');
  expect(translate('zh-CN', 'records.count', { count: '1,234' })).toBe('1,234 条记录');
  expect(translate('en', 'load.failed', { error: 'my-agent <failed>' })).toBe('Could not load usage: my-agent <failed>');
});

test('both catalogs have matching nonempty messages and interpolation parameters', () => {
  for (const [key, pair] of Object.entries(messages)) {
    expect(pair[0].length, key).toBeGreaterThan(0);
    expect(pair[1].length, key).toBeGreaterThan(0);
    const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    expect(params(pair[0]), key).toEqual(params(pair[1]));
  }
});

test('every static dashboard translation key exists in both languages', async () => {
  const html = await Bun.file(new URL('../web/index.html', import.meta.url)).text();
  let count = 0;
  const response = new HTMLRewriter().on('[data-i18n], [data-i18n-aria-label]', {
    element(el) {
      for (const attr of ['data-i18n', 'data-i18n-aria-label']) {
        const key = el.getAttribute(attr);
        if (key !== null) { expect(Object.hasOwn(messages, key), key).toBe(true); count++; }
      }
    },
  }).transform(new Response(html));
  await response.text();
  expect(count).toBeGreaterThan(70);
  for (const pair of Object.values(messages)) for (const message of pair) expect(message).not.toMatch(/<\/?[a-z][^>]*>/i);
});
