// Pass this function to playwright-cli run-code on an already opened dashboard.
async page => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const ready = async () => {
    await page.locator('#loading').waitFor({ state: 'hidden', timeout: 60000 });
    await page.locator('#dashboard-results').waitFor({ state: 'visible' });
  };
  const count = async () => Number((await page.locator('#metrics .metric-value').nth(3).innerText()).replace(/\D/g, ''));
  const endpoint = '**/api/command', elapsed = {};
  let expected;
  const onResponse = async response => {
    if (!response.url().endsWith('/api/command')) return;
    try {
      if (response.request().postDataJSON().command === 'usage dashboard') {
        const body = await response.json(); if (body.ok) expected = body.data;
      }
    } catch {}
  };
  page.on('response', onResponse);
  try {
    let t = Date.now();
    await page.goto(page.url().split('?')[0] + '?days=all'); await ready(); elapsed.initial = Date.now() - t;
    const all = await count();
    for (const days of ['7', '30', '90', 'all']) {
      t = Date.now(); await page.locator(`[data-days="${days}"]`).click(); await ready(); elapsed[days] = Date.now() - t;
      assert(await count() === expected.trend.summary.events, `date ${days} has stale metrics`);
      assert(Number((await page.locator('#activity-count').innerText()).replace(/\D/g, '')) === expected.activity.total, 'stale activity');
      assert(page.url().includes(`days=${days}&`), 'URL filter mismatch');
    }
    assert(await count() === all, 'all range changed in isolated database');
    await page.locator('[data-days="7"]').click(); await ready(); const week = await count();
    let release, arrived, completed;
    const held = new Promise(resolve => release = resolve), started = new Promise(resolve => arrived = resolve), done = new Promise(resolve => completed = resolve);
    const holdOld = async route => {
      const input = route.request().postDataJSON();
      if (input.command !== 'usage dashboard' || input.input.from) return route.continue();
      try { const response = await route.fetch(); arrived(); await held; await route.fulfill({ response }); }
      catch {} finally { completed(); }
    };
    await page.route(endpoint, holdOld);
    await page.locator('[data-days="all"]').click(); await started;
    assert(!(await page.locator('#metrics').isVisible()), 'old metrics visible while new date is loading');
    await page.locator('[data-days="7"]').click(); await ready(); release(); await done;
    assert(await count() === week, 'late old response overwrote latest date');
    await page.unroute(endpoint, holdOld);
    await page.locator('.custom-range summary').click();
    await page.locator('#from-date').fill('2026-08-01'); await page.locator('#to-date').fill('2026-08-01');
    await page.locator('#apply-dates').click(); await ready();
    const customCount = await count(); assert(customCount === expected.trend.summary.events, 'custom date mismatch');
    assert(await page.locator('[data-days].selected').count() === 0, 'preset date still selected for custom range');
    await page.reload(); await ready(); assert(await count() === customCount, 'custom date lost on reload');
    await page.locator('#timezone').selectOption('UTC'); await ready();
    assert(expected.trend.query.timezone === 'UTC', 'timezone not applied');
    await page.locator('#bucket').selectOption('hour'); await ready();
    assert(expected.trend.query.groupBy === 'hour', 'time granularity not applied');
    const fail = route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'Test unavailable' } }) });
    await page.route(endpoint, fail); await page.locator('[data-days="90"]').click();
    await page.locator('#loading').waitFor({ state: 'hidden' });
    assert((await page.locator('#notice').innerText()).includes('Test unavailable'), 'missing load error');
    assert(!(await page.locator('#metrics').isVisible()), 'failed request kept stale metrics visible');
    await page.unroute(endpoint, fail); await page.locator('[data-days="7"]').click(); await ready();
    assert(await count() === expected.trend.summary.events, 'recovery has stale metrics');
    return { elapsedMs: elapsed, all, week, customCount, checks: 'dates, details, stale results, late response, custom reload, timezone, hours, failure recovery' };
  } finally { page.off('response', onResponse); await page.unroute(endpoint); }
}
