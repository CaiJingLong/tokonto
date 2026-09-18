# 预设价格与手动规则

新采集的记录先匹配手动规则；没有匹配时，按模型名称或明确的别名使用预设参考价。已匹配手动规则但费率缺失或规则冲突时，不绕过用户规则。模型没有预设、用量不完整或缓存类别缺少单价时，仍标记未定价。

预设适用于历史日期、未知渠道、订阅和代理来源的参考估算，不会修改记录的供应商与渠道，也不代表实际账单。按核验日的公开标准 API 单价估算，未还原历史促销、订阅额度、地区附加费、服务等级和工具调用费用。长上下文阶梯根据单次 contextTokens 或已知输入推定，不完整的会话级信息可能使估算与实际账单有差异。

Dashboard 的“价格规则”分别展示手动规则和自动启用的预设，支持查看核验日期、官方出处、缓存单价、峰谷时段和长上下文阶梯。点击“自定义此价格”生成可编辑规则。峰时与谷时预设派生规则保留相对优先级。

CLI / AI：

```sh
tokonto prices catalog --json
tokonto prices list --json
tokonto prices explain --source codex --id <事件ID> --json
tokonto prices fill --json
tokonto prices fill --apply --json
```

`prices fill` 默认仅预览，应用时只填补能够成功报价的未定价记录；保留已有费用和冲突。`prices reprice` 用于明确要求重算全部记录的场景。两者都支持 query 日期/来源/模型筛选，并保留逐条价格历史。规则变更、预设更新和启动程序都不会自动改写已有报价。

报价的 `source` 区分 `custom` / `preset`，预设报价保存 `presetModel`、`assumptions` 及完整规则快照。用量修订沿用原快照，`usage stats` 的 `presetPriced` 可统计预设覆盖量。

升级时，旧版本自动植入的原始规则只有在内容完全相同且 revision=1 时才转为独立预设；用户修改过的版本保留为手动规则，既有价格快照保留。

当前快照核验于 2026-09-18，主要参考：

- [OpenAI 标准价格](https://developers.openai.com/api/docs/pricing)，GPT-5.4、GPT-5.5、GPT-5.3-Codex 的各自模型页面。
- [Anthropic 价格与缓存分类](https://platform.claude.com/docs/en/about-claude/pricing)。
- [Z.AI 价格](https://docs.z.ai/guides/overview/pricing)。缓存存储免费不等于缓存写入免费，未提供写入单价时不会自行补零。
- [DeepSeek 峰谷价格](https://api-docs.deepseek.com/quick_start/pricing/)，按 UTC 工作日 01:00–04:00、06:00–10:00 计算峰时。
