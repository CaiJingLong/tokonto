# 更新记录

## 0.2.0 — 2026-09-19

### 中文

- 面板支持简体中文 / English 切换、浏览器语言检测和本地偏好记忆，覆盖导航、图表、表单、提示及无障碍标签。
- 切换保留当前筛选、时区与币种，不改变用量或计费快照。
- 新增英文 README、双语发布说明及本地化维护约定；两种发行包均包含双语 README。
- 本版本通过 GitHub Release 触发 npm OIDC 自动发布。

### English

- Added Simplified Chinese / English switching, browser language detection and saved preferences across navigation, charts, forms, messages and accessibility labels.
- Language changes preserve filters, time zone, currency, usage and pricing snapshots.
- Added a full English README, bilingual release notes and localization guidelines; both distribution formats include both READMEs.
- This version uses GitHub Release events to trigger npm OIDC publishing.


## 0.1.0

首个公开版本。

- 正式定名 Tokonto，灵感来自 Token 与 Konto（账户）；命令、包名和 Skill 统一为 `tokonto`，兼容旧账本路径与环境变量。

- 汇集 Codex、Claude Code、OMP、WorkBuddy、Cherry Studio 用量，支持任意语言的脚本 Provider。
- CLI 和 JSON Schema 覆盖来源、价格、统计、导出、诊断与审计，随包提供 AI Skill。
- 本地 Dashboard 支持日期、时区、来源和模型筛选、趋势图及调用明细。
- 手动价格优先、模型预设兜底；支持日期、星期、跨午夜时段和上下文阈值定价。
- 精确十进制金额、互斥缓存用量、多币种分别汇总、历史价格快照和显式重算。
- 修复缓存计数解析、日期切换与加载性能，以及元数据修订导致原价格快照丢失的问题。
- 提供 MIT 许可证、依赖许可声明、GitHub Release 发行包、SHA-256 校验与独立安装验证。
- 支持从 npm 安装已构建的 CLI、Dashboard 和 Skill，保留 Bun 运行时要求。

价格是 token 费用估算，不包含订阅费、积分或非 token 项目，也不替代实际账单。
