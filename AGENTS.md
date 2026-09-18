# 项目开发约定

- 使用中文交流。默认使用 Bun；本机路径 `/Users/cai/.bun/bin/bun`。
- 开发验证：`bun test`、`bun run typecheck`、`bun run build`。
- 功能统一注册于 `src/commands.ts`，CLI 与 HTTP 使用同一套业务逻辑。修改命令时维护 JSON Schema 和项目 Skill。
- 计费分类互斥，金额使用 Decimal 字符串。未知费用不可默认为 0，不同币种不可直接相加。
- 修改价格不得静默重算历史；采集修订沿用旧规则快照，全部费用变更保留审计。
- Provider 只保存白名单用量元数据；不能持久化聊天正文或凭证。
- 测试使用脱敏构造数据和隔离临时目录，不把个人日志提交到仓库。
- 项目 Skill：`.agents/skills/tokonto/SKILL.md`；操作用量/来源/价格时先用 CLI `schema --json` 发现接口。
- UI 文案必须同时提供简体中文和英文，集中维护 `web/messages.ts`，遵循 `docs/localization.md`。语言切换不能修改业务数据或计费语义。
- README.md 与 README.en.md 同步维护；每个新版本的 Release 说明和 CHANGELOG 都需中英文，发行包必须包含两份 README。
