# Provider 协议 v1

## 配置

```json
{
  "provider": {
    "id": "my-agent",
    "name": "My Agent",
    "kind": "script",
    "command": ["/absolute/python3", "/absolute/provider.py"],
    "cwd": "/absolute/workdir",
    "timeoutMs": 30000,
    "enabled": true
  }
}
```

命令是 argv 数组，不经过 shell；空格不需要额外转义，不展开 `$HOME`、`~` 或 shell 运算符。使用绝对路径最可靠。`cwd` 和内置来源的 `paths` 支持 `~/`。`vendor`、`channel` 可选，用于显式覆盖该来源事件的计费标识。`id` 必须以小写字母开头，最多 64 个小写字母、数字或连字符。

脚本属于受信任的本地可执行代码，不提供权限沙箱。默认 30 秒超时，上限 300 秒；macOS/Linux 使用独立进程组，在成功、失败、超时后清理该组，插件不应创建守护进程或主动脱离组。Windows 使用 taskkill 进行尽力清理。

## 请求与响应

stdin（一个 JSON 对象，末尾换行，然后 EOF）：

```json
{"protocolVersion":1,"action":"collect","cursor":null}
```

stdout（仅一个 JSON 对象；日志写 stderr）：

```json
{
  "protocolVersion": 1,
  "events": [
    {
      "id": "request-001",
      "session": "session-001",
      "timestamp": "2026-09-18T09:30:00+08:00",
      "model": "my-model",
      "vendor": "my-gateway",
      "channel": "api",
      "tokens": {
        "input": 7500,
        "output": 900,
        "cacheRead": 2500,
        "cacheWrite": 0,
        "cacheWriteLong": 0
      }
    }
  ],
  "cursor": "opaque-next-position"
}
```

`source` 由宿主设置为 provider ID，即使脚本传入其他值也会覆盖。响应的精确 JSON Schema 可用 `schema --json` 的 `schemas.pluginResponse` 获取。

一次响应最多 50,000 条事件、16 MiB stdout、64 KiB stderr。任何事件不合法、进程非零退出或协议不匹配，整批不入库，游标不推进，其他来源继续。不要把 stderr 写入凭证或原始聊天内容，宿主不会把它当用量数据保存。

游标是可选、不透明字符串，最长 4096 字符。成功入库后回传到下一次 collect。若未返回新游标则保留旧值；`sync --force` 将请求 cursor 重置为 null。不依赖游标的来源可以每次返回全部记录。游标推进前崩溃可能导致重复拉取，因此稳定 ID 仍是必需的。`providers test` 不持久化游标。

## 用量口径

- ID 对应一次实际计费调用，不能每次采集生成新的随机 ID。
- 相同来源 + 相同 ID 更新原记录。普通插件允许纠正 token 数量；内置 Claude 会合并同 API message ID 的流式/复制记录，采用最大完整计数。
- 输入类别互斥：`input` **不包含**缓存；缓存读取、短期写入、长期写入分别记录。如果原始 API 的 `prompt_tokens` 包含缓存，适配器必须扣除对应缓存分类。
- `output` 已包含 reasoning token；不要再把 reasoning 加一次。
- token 为非负安全整数，不支持负差分、浮点或计数字符串。input/output 缺失不能猜成 0。
- 可选 `usageStatus: "incomplete"` 表示计数分类不完整或互相矛盾；tokens 仅保留已知分类，不能把它们之和视为完整消耗。无论是否匹配价格规则，该记录的规则费用始终未定价，不能当免费。用 `warnings` 说明缺失或冲突原因。
- `timestamp` 必须是带 Z 或 UTC offset 的 ISO 时间，不接受模糊本地时间。建议请求开始时间；如果只能拿到聚合或完成时间，通过 warnings 明示。
- 模型/供应商无法确定时用 `unknown`。不要把缓存命中率、费用或积分反推成精确 token。
- 可选 `contextTokens` 指此次请求的上下文规模，供长上下文阶梯匹配；不是会话累计 input。
- 可选 `project` 为项目路径或名称。无需传入消息内容或 key；未知字段会被严格校验拒绝。
- 可选 `reportedCost: {amount:"0.002",currency:"USD",kind:"reported"|"estimated"}`；kind=reported 仅用于来源明确给出的费用，SDK 自算 cost 使用 estimated。省略费用代表未知，明确 0 代表来源明确上报免费。

## 内置来源校验与版本边界

`providers test --input '{"id":"omp","records":[...]}'` 可以用脱敏后的原始记录测试内置适配器。它不读取文件、不导入用量；实际文件发现用 `doctor`，采集用 `sync`。

文件采集按大小/修改时间（SQLite 另含 WAL）跳过未变化文件，变化后重读并以稳定 ID 去重。畸形 JSONL 尾行不会阻断其他完整记录；有警告的文件会重试。单个 JSON/JSONL 文件限 256 MiB，超出需拆分或通过流式脚本来源分批接入。

Claude 与 Codex 的缓存口径分别归一化：

- Claude 的 `input_tokens` 不包含缓存。完整的 `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` 分别作为短期/长期写入；若两者之和与写入总量冲突，采用明确分项并在调用明细保留说明。只有一项时，仅在总量有效且足够时推导另一项；无法推导则跳过并诊断，不能把负数截为零。
- Codex 的 `input_tokens` 包含缓存读取和写入；归一化时扣除这两部分，output 已含 reasoning。优先读取有效的 `last_token_usage`；只在该字段缺失时采用非负且分类一致的累计差分。相同累计快照只采集一次，旧快照重放不回退差分基线。不同快照即使共享相同前置计数也不擅自合并，避免把并行调用误当修订。缺少请求 ID 的日志只能按快照尽力去重；累计差分与单次用量不符时保留说明，不声称能完全恢复每次调用身份。
- 已恢复记录的说明保存在事件 `warnings`，可通过调用明细或 `usage list` 查看；真正无法解析的记录才使来源显示部分异常。
- 解析规则升级会自动重读对应来源，保留原事件 ID。修正用量沿用原价格规则快照，旧值与新值进入 `prices history`；不会自动应用新价格目录。
- Codex 报告单次分类全零时，保留非零累计快照的原 ID 以修正旧的累计差分。若单次 `total_tokens` 仍为正，可能是上下文占用标记，记为 `usageStatus: "incomplete"` 并禁止计算费用，不把无法确认的费用当成零。累计快照不连续后，没有单次用量的后续记录会跳过并告警。

字段依据：[Anthropic 提示缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[OpenAI 提示缓存](https://developers.openai.com/api/docs/guides/prompt-caching)。

OMP 文件结构参考 [官方 Session 文档](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md)。Cherry JSON 消息参考 [官方消息类型](https://github.com/CherryHQ/cherry-studio/blob/main/src/renderer/src/types/newMessage.ts)，当前 SQLite 适配器通过本机 `ai_usage_record` 表结构核验；WorkBuddy 通过本机 trace wrapper 核验。第三方客户端格式没有统一的稳定兼容承诺，日志异常应保留诊断并调整适配器，而不是悄悄猜数。
