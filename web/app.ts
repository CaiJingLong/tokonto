import { VERSION } from '../src/version';
import { DateTime } from 'luxon';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
$('app-version').textContent = `v${VERSION}`;
const esc = (x: unknown) => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
const compact = (n: number) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : fmt(n);
const money = (n: string | number, c = 'USD') => `${c === 'USD' ? '$' : c === 'CNY' ? '¥' : c + ' '}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: Number(n) > 0 && Number(n) < .01 ? 6 : 2 })}`;
const colors = ['#247e69', '#84ba99', '#c2dca7', '#d7b78d', '#a9bdb3', '#8b9fa9', '#bda6b0'];
const names: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code', omp: 'OMP', workbuddy: 'WorkBuddy', 'cherry-studio': 'Cherry Studio' };
let data: any, providers: any[] = [], rules: any[] = [], presets: any[] = [], page = 'overview', offset = 0, days = '30', custom: { from: string; to: string } | undefined;
let requestVersion = 0, busy = false, toastTimer: ReturnType<typeof setTimeout>;
let loading = false, loadController: AbortController | undefined;
const urlState = new URLSearchParams(location.search);
let selectedSource = urlState.get('source') ?? '', selectedModel = urlState.get('model') ?? '';
if (['7', '30', '90', 'all'].includes(urlState.get('days') ?? '')) days = urlState.get('days')!;
const requestedZone = urlState.get('timezone');
const timezone = requestedZone && DateTime.now().setZone(requestedZone).isValid ? requestedZone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const fromDate = urlState.get('from'), toDate = urlState.get('to');
if (fromDate && toDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate) && /^\d{4}-\d{2}-\d{2}$/.test(toDate) && fromDate <= toDate && DateTime.fromISO(fromDate).isValid && DateTime.fromISO(toDate).isValid) {
  custom = { from: fromDate, to: toDate }; $<HTMLInputElement>('from-date').value = fromDate; $<HTMLInputElement>('to-date').value = toDate;
}
if (![...$('timezone').querySelectorAll('option')].some(o => o.value === timezone)) $('timezone').insertAdjacentHTML('beforeend', `<option>${esc(timezone)}</option>`);
$<HTMLSelectElement>('timezone').value = timezone;
async function api(command: string, input: any = {}, signal?: AbortSignal) {
  const res = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tokonto': '1' }, body: JSON.stringify({ command, input }), signal });
  const body: any = await res.json(); if (!body.ok) throw new Error(`${body.error.message}${body.error.details ? '\n' + JSON.stringify(body.error.details) : ''}`); return body.data;
}
function toast(message: string) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 6000); }
function query() {
  const zone = $<HTMLSelectElement>('timezone').value, now = DateTime.now().setZone(zone);
  const range = custom ? { from: DateTime.fromISO(custom.from, { zone }).startOf('day').toUTC().toISO()!, to: DateTime.fromISO(custom.to, { zone }).plus({ days: 1 }).startOf('day').toUTC().toISO()! } : days === 'all' ? {} : { from: now.startOf('day').minus({ days: Number(days) - 1 }).toUTC().toISO()!, to: now.plus({ days: 1 }).startOf('day').toUTC().toISO()! };
  return { ...range, timezone: zone, ...(selectedSource ? { source: selectedSource } : {}), ...(selectedModel ? { model: selectedModel } : {}) };
}
const empty = (message: string) => `<div class="empty"><span>◌</span>${esc(message)}</div>`;
function costs(map: Record<string, string>) { return Object.entries(map).map(([c, v]) => money(v, c)).join(' / ') || '—'; }
function openDialog(title: string, content: string) { $('dialog-title').textContent = title; $('dialog-content').innerHTML = content; $<HTMLDialogElement>('dialog').showModal(); }
$('close-dialog').onclick = () => $<HTMLDialogElement>('dialog').close();
$<HTMLDialogElement>('dialog').addEventListener('click', e => { if (e.target === $('dialog')) $<HTMLDialogElement>('dialog').close(); });
const pageCopy: Record<string, [string, string]> = { overview: ['用量概览', '了解你的 AI 使用习惯，让每一枚 token 都清晰可见。'], activity: ['调用明细', '追溯每次调用的用量、来源和计费依据。'], sources: ['数据来源', '把你日常使用的 AI 工具，连接到同一个视图。'], pricing: ['价格规则', '灵活配置模型价格，让费用跟随真实的计费规则。'] };
document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => button.onclick = () => {
  page = button.dataset.page!; document.querySelectorAll('.page').forEach(el => (el as HTMLElement).hidden = el.id !== page);
  document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('active', (el as HTMLElement).dataset.page === page));
  $('page-title').textContent = $('breadcrumb').textContent = pageCopy[page][0]; $('page-description').textContent = pageCopy[page][1];
});
async function load() {
  const version = ++requestVersion;
  loadController?.abort(); loadController = new AbortController(); loading = true;
  $('loading').hidden = false; $('dashboard-results').hidden = true; $('notice').hidden = true;
  const params = new URLSearchParams({ days, timezone: $<HTMLSelectElement>('timezone').value });
  if (selectedSource) params.set('source', selectedSource); if (selectedModel) params.set('model', selectedModel);
  if (custom) { params.set('from', custom.from); params.set('to', custom.to); }
  history.replaceState(null, '', '?' + params);
  try {
    const q = query(), bucket = $<HTMLSelectElement>('bucket').value;
    const { trend, sources, models, billing, activity, providers: pp, prices, allModels } = await api('usage dashboard', { ...q, groupBy: bucket, limit: 25, offset }, loadController.signal);
    if (version !== requestVersion) return;
    data = { trend, sources, models, billing, activity }; providers = pp; rules = prices.rules; presets = prices.presets ?? [];
    for (const p of providers) names[p.id] = p.name;
    const sourceIds = [...new Set([...providers.map(p => p.id), ...sources.groups.map((g: any) => g.key), ...(selectedSource ? [selectedSource] : [])])];
    $('source-filter').innerHTML = '<option value="">全部来源</option>' + sourceIds.map(s => `<option value="${esc(s)}">${esc(names[s] ?? s)}</option>`).join(''); $<HTMLSelectElement>('source-filter').value = selectedSource;
    $('model-filter').innerHTML = '<option value="">全部模型</option>' + allModels.map((model: string) => `<option value="${esc(model)}">${esc(model)}</option>`).join(''); $<HTMLSelectElement>('model-filter').value = selectedModel;
    const currency = $<HTMLSelectElement>('currency').value, currencies = Object.keys(trend.summary.costs);
    $('currency').innerHTML = (currencies.length ? currencies : ['USD']).map(c => `<option>${esc(c)}</option>`).join(''); if (currencies.includes(currency)) $<HTMLSelectElement>('currency').value = currency;
    $('source-count').textContent = String(providers.length); $('pricing-note').textContent = prices.note;
    const last = providers.map(p => p.status?.at).filter(Boolean).sort().at(-1);
    $('last-sync').textContent = last ? '最近同步 ' + DateTime.fromISO(last).setZone(q.timezone).toFormat('MM-dd HH:mm:ss') : '等待首次同步';
    $('dashboard-results').hidden = false; render();
  } catch (e) { if (version === requestVersion && (e as Error).name !== 'AbortError') { $('dashboard-results').hidden = true; $('notice').hidden = false; $('notice').textContent = `读取失败：${(e as Error).message}`; } }
  finally { if (version === requestVersion) { $('loading').hidden = true; loading = false; } }
}
function render() {
  const s = data.trend.summary, cur = $<HTMLSelectElement>('currency').value;
  const inputTotal = s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite + s.tokens.cacheWriteLong;
  const ratio = inputTotal ? (s.tokens.cacheRead / inputTotal * 100).toFixed(1) : '0.0';
  const metrics = [
    ['总 Token 用量', compact(s.totalTokens), 'tokens', `输入 ${compact(inputTotal)} · 输出 ${compact(s.tokens.output)}`, '◈'],
    ['估算费用', s.priced ? money(s.costs[cur] ?? '0', cur) : '—', '', `已定价 ${fmt(s.priced)} / ${fmt(s.events)} 条 · 其中预设 ${fmt(s.presetPriced ?? 0)} 条${Object.keys(s.costs).length > 1 ? ' · 币种分别汇总' : ''}`, '＄'],
    ['缓存命中率', ratio, '%', `命中 ${compact(s.tokens.cacheRead)} 输入 token`, '↺'],
    ['用量记录', fmt(s.events), '条', `${data.sources.groups.length} 个来源 · ${data.models.groups.length} 个模型`, '↗'],
  ];
  $('metrics').innerHTML = metrics.map(([label, value, unit, note, icon]) => `<article class="metric"><div class="metric-label">${label}<span class="metric-icon">${icon}</span></div><div class="metric-value">${value}<span class="unit">${unit}</span></div><div class="metric-note">${note}</div></article>`).join('');
  $('notice').hidden = s.unpriced + s.conflicts === 0;
  $('notice').innerHTML = `${fmt(s.unpriced)} 条记录尚未定价，${fmt(s.conflicts)} 条存在规则冲突。已知 token 用量仍计入统计；可在明细查看缺少预设、费率或用量不完整的原因。 <button class="row-button" id="notice-fill">按预设补算未定价记录 ↗</button>`;
  $('notice-fill').onclick = () => void previewPricing(true);
  drawTrend(); drawSources(); renderModels(); renderActivity(); renderProviders(); renderPrices();
  const coverage = s.events ? (100 * s.priced / s.events).toFixed(1) : '0';
  const peak = data.billing.groups.filter((g: any) => /peak/.test(g.key) && !/offpeak/.test(g.key)).reduce((n: number, g: any) => n + g.events, 0);
  $('insights').innerHTML = `<div class="insight-item"><span class="insight-number">✓</span><div><h3>${coverage}% 的记录已完成定价</h3><p>${s.unpriced ? `${fmt(s.unpriced)} 条待补充模型、渠道或历史价格。` : '每笔估算都保留价格规则和计算明细。'}</p></div></div><div class="insight-item"><span class="insight-number">◷</span><div><h3>${fmt(peak)} 条命中内置峰时规则</h3><p>按调用发生时间与规则时区计价。自定义规则可按规则分组查询。</p></div></div><div class="insight-item"><span class="insight-number">≋</span><div><h3>上报费用 ${esc(costs(s.reportedCosts))}</h3><p>来源自身估算 ${esc(costs(s.sourceEstimates))}。与规则估算分别保留，不重复相加。</p></div></div><div class="insight-link">◇ 修改单价会保留旧费用，历史重算前可预览差额。</div>`;
}
function drawTrend() {
  const groups = data.trend.groups, costMode = $<HTMLSelectElement>('metric-mode').value === 'cost', cur = $<HTMLSelectElement>('currency').value;
  $('currency').hidden = !costMode;
  const legend = document.querySelector('.legend') as HTMLElement;
  legend.innerHTML = costMode ? `<span><i class="dot input"></i>估算费用 · ${esc(cur)}</span>` : '<span><i class="dot input"></i>输入</span><span><i class="dot cache"></i>缓存</span><span><i class="dot output"></i>输出</span>';
  if (!groups.length) { $('trend-chart').innerHTML = empty('还没有用量数据，点击「立即同步」开始采集。'); $('chart-range').textContent = ''; return; }
  const max = Math.max(...groups.map((g: any) => costMode ? Number(g.costs[cur] ?? 0) : g.totalTokens), 1) * 1.18;
  const width = Math.max(300, $('trend-chart').clientWidth - 28), height = 220, left = 45, right = 10, top = 8, bottom = 30, plotW = width - left - right, plotH = height - top - bottom;
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${costMode ? '费用' : 'Token'}趋势图">`;
  for (let i = 0; i < 5; i++) { const y = top + plotH * i / 4; svg += `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" stroke="#eaf0eb" stroke-dasharray="3 4"/><text x="${left - 9}" y="${y + 3}" text-anchor="end" font-size="9" fill="#99a69b">${esc(costMode ? (max * (1 - i / 4)).toFixed(2) : compact(max * (1 - i / 4)))}</text>`; }
  const step = plotW / groups.length, bw = Math.min(22, step * .58);
  groups.forEach((g: any, i: number) => {
    const x = left + step * i + step / 2, values = costMode ? [Number(g.costs[cur] ?? 0)] : [g.tokens.input, g.tokens.cacheRead + g.tokens.cacheWrite + g.tokens.cacheWriteLong, g.tokens.output];
    let y = top + plotH;
    values.forEach((v, k) => { const h = v / max * plotH; y -= h; svg += `<rect class="bar-hover" x="${x - bw / 2}" y="${y}" width="${bw}" height="${h}" rx="${Math.min(2, bw / 3)}" fill="${['#1f826c', '#89cbb0', '#c9e3a7'][k]}"><title>${esc(g.key)}\n${costMode ? money(v, cur) : ['输入', '缓存', '输出'][k] + ' ' + fmt(v)}\n未定价 ${g.unpriced} 条</title></rect>`; });
    if (i % Math.max(1, Math.ceil(groups.length / (width < 450 ? 4 : 7))) === 0 || i === groups.length - 1 && groups.length > 1) {
      const label = data.trend.query.groupBy === 'hour' ? g.key.slice(5, 16).replace('T', ' ') : g.key.slice(5) || g.key;
      svg += `<text x="${x}" y="${height - 8}" text-anchor="middle" font-size="9" fill="#96a599">${esc(label)}</text>`;
    }
  });
  $('trend-chart').innerHTML = svg + '</svg>';
  $('chart-range').textContent = `${groups[0].key.slice(0, 10)} — ${groups.at(-1).key.slice(0, 10)}`;
  $('trend-subtitle').textContent = costMode ? '仅包含已定价记录，可切换币种查看' : '输入、输出与缓存分类互斥，避免重复统计';
}
function drawSources() {
  const groups = [...data.sources.groups].sort((a: any, b: any) => b.totalTokens - a.totalTokens), total = data.sources.summary.totalTokens;
  if (!total) { $('source-chart').innerHTML = empty('采集后查看各来源的占比'); return; }
  let offset = 0; const circumference = 2 * Math.PI * 61;
  const arcs = groups.map((g: any, i: number) => { const length = g.totalTokens / total * circumference, arc = `<circle cx="85" cy="85" r="61" fill="none" stroke="${colors[i % colors.length]}" stroke-width="19" stroke-dasharray="${Math.max(0, length - 3)} ${circumference}" stroke-dashoffset="${-offset}"><title>${esc(names[g.key] ?? g.key)}: ${fmt(g.totalTokens)}</title></circle>`; offset += length; return arc; }).join('');
  $('source-chart').innerHTML = `<div class="donut-area"><svg viewBox="0 0 170 170" role="img" aria-label="来源占比"><circle cx="85" cy="85" r="61" fill="none" stroke="#f1f5ef" stroke-width="19"/>${arcs}</svg><div class="donut-label"><strong>${groups.length}</strong><span>活跃来源</span></div></div><div class="source-legend">${groups.map((g: any, i: number) => `<div class="source-row"><i class="dot" style="background:${colors[i % colors.length]}"></i>${esc(names[g.key] ?? g.key)}<strong>${compact(g.totalTokens)}</strong><span>${(g.totalTokens / total * 100).toFixed(1)}%</span></div>`).join('')}</div>`;
}
function renderModels() {
  const groups = [...data.models.groups].sort((a: any, b: any) => b.totalTokens - a.totalTokens), total = data.models.summary.totalTokens;
  $('model-count').textContent = `${groups.length} MODELS`;
  $('model-table').innerHTML = groups.length ? groups.slice(0, 8).map((g: any) => { const pct = total ? g.totalTokens / total * 100 : 0; return `<tr><td><div class="model-name"><span class="model-icon">◇</span><strong>${esc(g.key)}</strong></div></td><td>${fmt(g.events)}</td><td>${compact(g.totalTokens)}</td><td>${esc(costs(g.costs))}${g.unpriced ? `<small>${g.unpriced} 条未定价</small>` : ''}</td><td><span class="share-bar"><i style="width:${pct}%"></i></span>${pct.toFixed(0)}%</td></tr>`; }).join('') : '<tr><td colspan="5">' + empty('暂无模型用量') + '</td></tr>';
}
function renderActivity() {
  const a = data.activity, zone = $<HTMLSelectElement>('timezone').value;
  $('activity-count').textContent = `${fmt(a.total)} RECORDS`; $('page-number').textContent = `${Math.floor(offset / 25) + 1} / ${Math.max(1, Math.ceil(a.total / 25))}`;
  $<HTMLButtonElement>('prev').disabled = offset === 0; $<HTMLButtonElement>('next').disabled = offset + 25 >= a.total;
  $('activity-table').innerHTML = a.events.length ? a.events.map((e: any, index: number) => `<tr><td>${DateTime.fromISO(e.timestamp).setZone(zone).toFormat('MM-dd HH:mm:ss')}</td><td><strong>${esc(names[e.source] ?? e.source)}</strong><small title="${esc(e.session)}">${esc(e.session)}</small></td><td>${esc(e.model)}</td><td>${compact(e.tokens.input)} / ${compact(e.tokens.output)}</td><td>${compact(e.tokens.cacheRead + e.tokens.cacheWrite + e.tokens.cacheWriteLong)}</td><td>${e.quote.status === 'priced' ? money(e.quote.amount, e.quote.currency) + `<small>${e.quote.source === 'preset' ? '预设参考价' : '手动规则'}</small>` : '<span class="unpriced">' + (e.quote.status === 'conflict' ? '规则冲突' : '未定价') + '</span>'}</td><td><button class="row-button" data-event="${index}">详情 ↗</button></td></tr>`).join('') : '<tr><td colspan="7">' + empty('此范围内没有记录') + '</td></tr>';
  document.querySelectorAll<HTMLButtonElement>('[data-event]').forEach(b => b.onclick = async () => {
    const e = a.events[Number(b.dataset.event)];
    try { const explanation = await api('prices explain', { source: e.source, id: e.id }); const revisions = await api('prices history', { source: e.source, id: e.id }); const result = { ...explanation, revisions }; openDialog('调用与计费明细', `<div class="detail-list"><div><small>模型</small>${esc(e.model)}</div><div><small>发生时间</small>${esc(e.timestamp)}</div><div><small>供应商 / 渠道</small>${esc(e.vendor)} / ${esc(e.channel)}</div><div><small>已存估算费用</small>${e.quote.status === 'priced' ? money(e.quote.amount, e.quote.currency) : '未定价'}</div></div><p>下面分别保留用量、入库时计费快照和当前规则报价。</p><pre>${esc(JSON.stringify(result, null, 2))}</pre>`); } catch (err) { toast((err as Error).message); }
  });
}
function renderProviders() {
  const stateName: Record<string, string> = { ok: '已同步', partial: '部分异常', missing: '未发现数据', error: '采集失败', demo: '演示数据' };
  $('providers-grid').innerHTML = providers.map((p, i) => `<article class="provider-card"><div class="provider-top"><span class="provider-logo">${esc(p.name.slice(0, 1))}</span><span class="badge ${p.status && !['ok', 'demo'].includes(p.status.state) ? 'warn' : ''}">${p.enabled ? stateName[p.status?.state] ?? '待同步' : p.status?.state === 'demo' ? '演示数据' : '已停用'}</span></div><h2>${esc(p.name)}</h2><p>${p.kind === 'script' ? '自定义脚本来源' : '内置来源 · 本地只读采集'}</p><div class="provider-path">${p.paths.length ? p.paths.map(esc).join('<br>') : '由脚本提供用量记录'}</div><div class="provider-status">${p.status ? `最近新增 ${fmt(p.status.inserted ?? 0)} 条 · 更新 ${fmt(p.status.updated ?? 0)} 条` : '尚未采集数据'}${p.status?.warnings?.length ? '<br>' + esc(p.status.warnings[0]) : ''}</div><div class="provider-actions"><button class="button" data-provider="${i}">配置</button><button class="button" data-toggle="${i}">${p.enabled ? '停用' : '启用'}</button></div></article>`).join('');
  document.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach(b => b.onclick = () => providerForm(providers[Number(b.dataset.provider)]));
  document.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach(b => b.onclick = async () => { const { status, ...p } = providers[Number(b.dataset.toggle)]; try { await api('providers put', { provider: { ...p, enabled: !p.enabled } }); await load(); } catch (e) { toast((e as Error).message); } });
}
function renderPrices() {
  $('price-table').innerHTML = rules.length ? rules.map((r, i) => `<tr><td><strong>${esc(r.model)}</strong><small title="${esc(r.id)}">${esc(r.label ?? r.id)}</small></td><td>${esc(r.vendor)}<small>${esc(r.channel)} · ${esc(r.currency)}</small></td><td>${esc(r.rates.input)} / ${esc(r.rates.output)}<small>每百万 token</small></td><td>${esc(r.rates.cacheRead ?? '—')}</td><td>${r.windows ? r.windows.map((w: any) => `${w.start}–${w.end}`).join('<br>') : '全天'}<small>${esc(r.timezone)}${r.weekdays ? ' · 周 ' + r.weekdays.join(',') : ''}</small></td><td>${r.priority}</td><td><button class="row-button" data-price="${i}">编辑</button></td></tr>`).join('') : '<tr><td colspan="7">' + empty('尚无手动规则，已自动使用模型预设参考价。') + '</td></tr>';
  document.querySelectorAll<HTMLButtonElement>('[data-price]').forEach(b => b.onclick = () => priceForm(rules[Number(b.dataset.price)]));
  $('preset-table').innerHTML = presets.map((r, i) => `<tr><td><strong>${esc(r.model)}</strong><small>预设参考价 · ${esc(r.currency)}</small></td><td>${esc(r.rates.input)} / ${esc(r.rates.output)}<small>每百万 token</small></td><td>${esc(r.rates.cacheRead ?? '—')}</td><td>${esc(r.rates.cacheWrite ?? '—')} / ${esc(r.rates.cacheWriteLong ?? '—')}</td><td>${r.windows ? r.windows.map((w: any) => `${esc(w.start)}–${esc(w.end)}`).join('<br>') : '基础价'}<small>${esc(r.timezone)}${r.weekdays ? ' · 周 ' + r.weekdays.join(',') : ''}${r.tiers?.length ? ' · 含长上下文阶梯' : ''}</small></td><td>${esc(r.verifiedAt?.slice(0, 10))}<small><a href="${esc(r.reference)}" target="_blank" rel="noopener noreferrer">官方价格 ↗</a></small></td><td><button class="row-button" data-preset="${i}">自定义此价格</button></td></tr>`).join('');
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(b => b.onclick = () => {
    const { effectiveFrom, effectiveTo, revision, ...r } = presets[Number(b.dataset.preset)];
    priceForm({ ...r, id: `custom-${r.model}-${Date.now()}`, label: `自定义 ${r.model}`, vendor: '*', channel: '*', priority: 100 + r.priority }, true);
  });
}
function field(label: string, name: string, value: unknown = '', type = 'text', extra = '') { return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`; }
function priceForm(rule?: any, fromPreset = false) {
  const r = rule ?? { id: '', model: '', vendor: '*', channel: '*', currency: 'USD', priority: 100, timezone: $<HTMLSelectElement>('timezone').value, rates: {} };
  const simpleWindow = r.windows?.length === 1;
  openDialog(fromPreset ? '基于预设自定义价格' : rule ? '编辑价格规则' : '添加价格规则', `<p>单价以每百万 token 计。日期结束日不包含在优惠内。现有历史费用会保留。</p><form id="price-form"><div class="form-grid" style="margin-top:18px">${field('规则 ID', 'id', r.id, 'text', rule && !fromPreset ? 'required readonly' : 'required')}${field('显示名称', 'label', r.label)}${field('模型（精确名称）', 'model', r.model, 'text', 'required')}${field('供应商', 'vendor', r.vendor, 'text', 'required')}${field('计费渠道', 'channel', r.channel, 'text', 'required')}${field('币种', 'currency', r.currency, 'text', 'required pattern="[A-Z]{3}"')}${field('输入单价', 'input', r.rates.input, 'text', 'required')}${field('输出单价', 'output', r.rates.output, 'text', 'required')}${field('缓存读取单价', 'cacheRead', r.rates.cacheRead)}${field('缓存写入单价（短期）', 'cacheWrite', r.rates.cacheWrite)}${field('缓存写入单价（长期）', 'cacheWriteLong', r.rates.cacheWriteLong)}${field('优先级（较大优先）', 'priority', r.priority, 'number')}${field('规则时区', 'timezone', r.timezone)}${field('星期（1–7，逗号分隔；空=每天）', 'weekdays', r.weekdays?.join(','))}${field('优惠开始日期', 'dateFrom', r.dateFrom, 'date')}${field('优惠结束日期（不含）', 'dateTo', r.dateTo, 'date')}${field('每日开始时间', 'start', simpleWindow ? r.windows[0].start : '', 'time')}${field('每日结束时间', 'end', simpleWindow ? r.windows[0].end : '', 'time')}${field('生效时间（ISO，含时区）', 'effectiveFrom', r.effectiveFrom)}${field('失效时间（ISO，含时区）', 'effectiveTo', r.effectiveTo)}<label class="wide">高级规则：多个时段和上下文阶梯（JSON，可选）<textarea name="advanced" rows="4">${esc(JSON.stringify({ ...(r.windows?.length > 1 ? { windows: r.windows } : {}), ...(r.tiers ? { tiers: r.tiers } : {}) }, null, 2))}</textarea></label></div><div class="form-error" id="form-error"></div><div class="form-actions">${rule && !fromPreset ? '<button type="button" class="button danger" id="remove-rule">停用此规则</button>' : ''}<button class="button primary" type="submit">校验并保存</button></div></form>`);
  $<HTMLFormElement>('price-form').onsubmit = async e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget as HTMLFormElement));
    try {
      const next: any = { ...r, id: f.id, model: f.model, vendor: f.vendor, channel: f.channel, currency: f.currency, label: f.label || undefined, priority: Number(f.priority), timezone: f.timezone, rates: {} };
      delete next.revision;
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWriteLong']) if (f[k]) next.rates[k] = f[k];
      for (const k of ['dateFrom', 'dateTo', 'effectiveFrom', 'effectiveTo']) { delete next[k]; if (f[k]) next[k] = f[k]; }
      delete next.weekdays; if (f.weekdays) next.weekdays = String(f.weekdays).split(',').map(Number);
      delete next.windows; delete next.tiers;
      if (f.start || f.end) next.windows = [{ start: f.start, end: f.end }];
      const advanced = JSON.parse(String(f.advanced)); if (Object.keys(advanced).some(k => !['windows', 'tiers'].includes(k))) throw new Error('高级规则仅支持 windows、tiers'); Object.assign(next, advanced);
      await api('prices put', { rules: [next], dryRun: true }); await api('prices put', { rules: [next] }); $<HTMLDialogElement>('dialog').close(); toast('价格已保存，历史费用保持原样'); await load();
    } catch (err) { $('form-error').textContent = (err as Error).message; }
  };
  if (rule && !fromPreset) $('remove-rule').onclick = async () => { try { await api('prices remove', { id: rule.id }); $<HTMLDialogElement>('dialog').close(); toast('规则已停用，历史快照保留'); await load(); } catch (e) { $('form-error').textContent = (e as Error).message; } };
}
function providerForm(provider?: any) {
  const { status, ...p } = provider ?? { id: '', name: '', kind: 'script', paths: [], enabled: true };
  openDialog(provider ? '配置数据来源' : '添加数据来源', `<p>内置来源读取本地日志；外置脚本以标准用量协议输出数据。脚本会以你的本地用户权限运行。</p><form id="provider-form"><div class="form-grid" style="margin-top:18px">${field('来源 ID', 'id', p.id, 'text', provider ? 'required readonly' : 'required')}${field('名称', 'name', p.name, 'text', 'required')}<label>来源类型<select name="kind">${['script', 'codex', 'claude', 'omp', 'workbuddy', 'cherry'].map(k => `<option ${p.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>${field('脚本超时（毫秒）', 'timeoutMs', p.timeoutMs ?? 30000, 'number')}${field('覆盖供应商（可选）', 'vendor', p.vendor)}${field('计费渠道（可选，如 api）', 'channel', p.channel)}<label class="wide">数据路径（每行一个）<textarea name="paths" rows="3">${esc(p.paths.join('\n'))}</textarea></label><label class="wide">脚本命令参数（JSON 数组）<textarea name="command" rows="3" placeholder='["python3", "/path/to/provider.py"]'>${esc(p.command ? JSON.stringify(p.command) : '')}</textarea></label>${field('脚本工作目录（可选）', 'cwd', p.cwd)}</div><div class="form-error" id="form-error"></div><div class="form-actions"><button class="button primary" type="submit">保存来源</button></div></form>`);
  $<HTMLFormElement>('provider-form').onsubmit = async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget as HTMLFormElement)); try {
    const next: any = { ...p, id: f.id, name: f.name, kind: f.kind, timeoutMs: Number(f.timeoutMs), paths: String(f.paths).split('\n').map(s => s.trim()).filter(Boolean) };
    for (const k of ['vendor', 'channel', 'cwd']) { delete next[k]; if (f[k]) next[k] = f[k]; }
    delete next.command; if (f.command) next.command = JSON.parse(String(f.command));
    await api('providers put', { provider: next }); $<HTMLDialogElement>('dialog').close(); toast('来源已保存，点击同步开始采集'); await load();
  } catch (err) { $('form-error').textContent = (err as Error).message; } };
}
$('add-price').onclick = () => priceForm(); $('add-provider').onclick = () => providerForm();
async function previewPricing(fill = false) {
  try {
    const q = query(), command = fill ? 'prices fill' : 'prices reprice', preview = await api(command, { query: q });
    openDialog(fill ? '补算未定价记录' : '历史费用重算预览', `<p>范围与当前筛选一致。${fill ? '只补算未定价记录，保留已有费用；手动规则优先，其余使用模型预设参考价。' : ''}应用后会更新 ${preview.changed} 条计费快照，并保存审计记录。</p><div class="detail-list"><div><small>处理前</small>${esc(costs(preview.before.costs))}</div><div><small>处理后</small>${esc(costs(preview.after.costs))}</div><div><small>费用差额</small>${esc(costs(preview.delta))}</div><div><small>未定价记录</small>${preview.before.unpriced} → ${preview.after.unpriced}</div></div><div class="form-actions"><button id="apply-reprice" class="button primary" ${preview.changed ? '' : 'disabled'}>${fill ? '应用补算' : '应用重算'}</button></div>`);
    $('apply-reprice').onclick = async () => { const b = $<HTMLButtonElement>('apply-reprice'); b.disabled = true; try { await api(command, { query: q, apply: true }); $<HTMLDialogElement>('dialog').close(); toast(fill ? '补算已完成' : '重算已完成'); await load(); } catch (e) { toast((e as Error).message); b.disabled = false; } };
  } catch (e) { toast((e as Error).message); }
}
$('reprice').onclick = () => void previewPricing();
$('fill-prices').onclick = () => void previewPricing(true);
$('sync').onclick = async () => { if (busy) return; busy = true; const b = $<HTMLButtonElement>('sync'); b.disabled = true; b.textContent = '正在同步…'; try { const result = await api('sync'); const count = result.results.reduce((n: number, r: any) => n + r.inserted, 0), failed = result.results.filter((r: any) => ['error', 'partial'].includes(r.state)).length; toast(`同步完成，新增 ${fmt(count)} 条记录${failed ? `；${failed} 个来源有异常，请查看数据来源` : ''}`); await load(); } catch (e) { toast((e as Error).message); } finally { busy = false; b.disabled = false; b.innerHTML = '<span>↻</span> 立即同步'; } };
$('export').onclick = async () => { try { const r = await api('usage export', { query: query(), format: 'csv' }); const url = URL.createObjectURL(new Blob(['\ufeff', r.content], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = `tokonto-${DateTime.now().toISODate()}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast(`已导出 ${fmt(r.count)} 条记录`); } catch (e) { toast((e as Error).message); } };
$('ai-help').onclick = () => openDialog('用 AI 管理你的用量', '<p>项目内附带 tokonto Skill。让你的 AI 助手加载它，即可查询统计、配置分时价格或编写新的数据来源。</p><pre>tokonto skill install --target ~/.codex/skills\ntokonto schema --json</pre><p>也可将 Skill 安装到 OMP 或其他支持 Agent Skills 的工具目录。</p><pre>“比较本月 OMP 和 Codex 的费用，按模型展开。”\n“给我的模型设置下周每天凌晨半价。”\n“把我自己的 agent 日志接入用量看板。”</pre>');
document.querySelectorAll<HTMLButtonElement>('[data-days]').forEach(b => { b.classList.toggle('selected', !custom && b.dataset.days === days); b.onclick = () => { days = b.dataset.days!; custom = undefined; offset = 0; document.querySelectorAll('[data-days]').forEach(x => x.classList.toggle('selected', (x as HTMLElement).dataset.days === days)); void load(); }; });
$('source-filter').onchange = () => { selectedSource = $<HTMLSelectElement>('source-filter').value; offset = 0; void load(); };
$('model-filter').onchange = () => { selectedModel = $<HTMLSelectElement>('model-filter').value; offset = 0; void load(); };
$('timezone').onchange = () => { offset = 0; void load(); }; $('bucket').onchange = () => void load();
$('metric-mode').onchange = () => { if (data) render(); }; $('currency').onchange = () => { if (data) render(); };
$('apply-dates').onclick = () => { const from = $<HTMLInputElement>('from-date').value, to = $<HTMLInputElement>('to-date').value; if (!from || !to || from > to) return toast('请选择有效的开始和结束日期'); custom = { from, to }; offset = 0; document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('selected')); (document.querySelector('.custom-range') as HTMLDetailsElement).open = false; void load(); };
$('prev').onclick = () => { offset = Math.max(0, offset - 25); void load(); }; $('next').onclick = () => { offset += 25; void load(); };
void load();
setInterval(() => { if (!document.hidden && !$<HTMLDialogElement>('dialog').open && !busy && !loading) void load(); }, 60000);
