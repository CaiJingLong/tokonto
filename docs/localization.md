# 本地化 / Localization

## 中文

- 支持 `zh-CN`（简体中文）和 `en`（英文）。已保存的 `tokonto.locale` 优先于浏览器语言；首次访问选择浏览器首个受支持语言，不支持时回退英文。
- 文案集中在 `web/messages.ts`，每项为 `[中文, English]`。静态 HTML 使用 `data-i18n` / `data-i18n-aria-label`，动态内容使用 `t(key, values)`。句子使用完整消息和具名占位符，不拼接数量、语序不同的句子。
- 文案不得含 HTML。将动态数据插入 HTML 时仍必须转义，翻译函数本身不转义。模型名、来源自定义名称、脚本参数、API/CLI 字段和 CSV 表头不翻译；原始诊断按原文保留。
- 切换语言只更新界面，不能修改用量、计费快照、时区或币种，不能发起采集或重算。
- 新页面、表单、空状态、错误、toast 和无障碍标签均需双语。修改消息后运行 `bun test`、`bun run typecheck`，在浏览器中检查两种语言及窄屏。日期筛选、费用计算也需要回归检查。
- 同步维护 `README.md` 和 `README.en.md`。每次发布的 `docs/releases/<version>.md` 必须包含 `## 中文` 与 `## English`；打包脚本会检查。CHANGELOG 新版本同样记录两种语言。

## English

- Supported locales are `zh-CN` (Simplified Chinese) and `en` (English). Saved `tokonto.locale` takes precedence over the browser's first supported language. Unsupported languages fall back to English.
- Keep UI messages in `web/messages.ts` as `[Chinese, English]` pairs. Use `data-i18n` / `data-i18n-aria-label` in static HTML and `t(key, values)` for dynamic content. Use complete sentences and named placeholders when grammar or word order differs.
- Catalog messages must not contain HTML. Escape dynamic values when inserting them into HTML; translation itself does not escape. Do not translate model identifiers, user-defined source names, script arguments, API/CLI fields or CSV headers. Preserve original technical diagnostics.
- Switching languages only changes presentation. It must not change usage, price snapshots, time zones or currencies, or trigger collection/repricing.
- Translate new pages, forms, empty states, errors, toasts and accessibility labels. Run `bun test` and `bun run typecheck`, then inspect both languages at desktop and narrow widths. Recheck date filters and costs.
- Keep both READMEs in sync. Each `docs/releases/<version>.md` must include `## 中文` and `## English`; packaging enforces this. Add both languages to new CHANGELOG entries too.
