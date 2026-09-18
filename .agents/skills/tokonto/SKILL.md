---
name: tokonto
description: 使用 tokonto CLI 管理本地 AI 用量、模型分时价格和脚本 Provider，查询或解释 token 与费用统计。适用于接入 agent 日志、配置优惠日期和峰谷时段、比较来源或模型费用，以及历史费用重算。
---

使用项目提供的 `tokonto` CLI。尚未链接命令时，发行包使用 `bun /安装目录/cli.js <子命令>`，源码根目录使用 `bun run cli -- <子命令>`；Bun 不在 PATH 时使用已知的 Bun 可执行文件绝对路径。`tokonto --version --json` 查看应用版本，不初始化账本。

先运行 `tokonto schema --json` 获取命令清单、参数 JSON Schema 和用量/价格/Provider 协议。需要单个命令时用 `schema --command "prices put" --json`。全部业务功能都有非交互 CLI，不需要控制浏览器。

- 稳定输出 `{ok,data}` 或 `{ok:false,error:{code,message,details}}`，始终使用 `--json`。stdout 仅含 JSON，日志在 stderr。失败先根据错误码修正，避免重复执行失败的插件。
- 复杂输入写 JSON 文件，再传 `--input @/absolute/path/input.json`，或从 stdin 传 `--input -`。不要把不受信任文本拼进 shell 命令。`--data-dir` 显式选择账本，默认 `~/.tokonto`。
- `TOKONTO_HOME` 设置默认账本目录；兼容旧变量 `TOKEN_USAGE_HOME`。若新目录无账本，会原地读取已有 `~/.token-usage` 账本。先用 `doctor --json` 确认实际目录，不因改名创建空账本替代旧数据。
- 模型价格由 `vendor + model + channel` 匹配。用户说某 app 名字时，不要误认为模型供应商。渠道不明先查询现有来源配置；不要把订阅或代理渠道当官方 API。
- 手动规则优先；没有匹配手动规则时，内置模型预设自动兜底。`prices list` 分别返回 rules 与 presets，`prices catalog` 查看预设。quote.source 为 custom/preset，预设的 assumptions 与 verifiedAt 说明参考口径；历史、代理、订阅的预设估算不是实际账单，不为套用预设而改写来源渠道。
- `prices fill` 预览补算未定价记录，`--apply` 应用并保存完整审计，支持 query 筛选，保留已定价和冲突记录。已有授权要求补算时可应用；仅查询价格不代表授权改写历史。`prices reprice` 则会重算范围内的全部记录。
- 添加或更新价格使用 `prices put`，删除使用 `prices remove`；先用同一输入加 `dryRun:true` 校验。有效期、时段和查询范围都左闭右开。星期 1=周一；跨午夜窗口属于开始日。日期范围按规则时区，使用 IANA 时区。费用单价是每百万 token 的十进制字符串。
- 同优先级重叠会被拒绝，明确设置更高 priority 表示优惠/峰时覆盖。优惠不自动叠乘。`prices explain` 比较已存价格与当前规则报价；`prices history --source <source> --id <id>` 查询完整用量和计费修订历史。
- 已存费用不会跟着调价变化。`prices reprice` 默认只预览；用户确实要求重算后传 `apply:true`。先报告费用差额、未定价覆盖变化及币种。更新未来价格不代表需要重算历史。
- 外置 Provider 是本地可信脚本，用 argv 数组 `command`，不使用 shell 字符串。stdin 接收 `{protocolVersion:1,action:"collect",cursor:null|string}`；stdout 输出一个 `{protocolVersion:1,events:[...],cursor?:string}`。日志写 stderr。脚本可以使用任何语言。
- `providers put` 注册/更新，`providers test` 执行校验但不导入，`sync --id <id>` 正式采集。测试也会执行脚本，因此不要把不可信脚本当成数据文件执行。事件 ID 在来源内稳定且对应一次计费调用；来源由宿主指定，重复导入同一 ID 更新、不累计。游标只在校验和入库成功后推进。
- 统一 token 分类互斥：input 不含缓存，output 已含 reasoning，cacheRead/cacheWrite/cacheWriteLong 分别是读缓存、短期写缓存、长期写缓存。不要把累计计数当单次调用，也不要重复加 reasoning。仅保存用量元数据，不带聊天正文或凭证。
- `usageStatus: "incomplete"` 表示分类缺失或冲突，tokens 仅为已知分类；规则费用始终未定价，不能解释为完整用量或免费。查看事件 `warnings` 获取采集还原说明，`prices history` 查看解析修订前后的记录。
- `usage stats` 支持时间、时区、来源、供应商、模型、渠道、会话筛选，以及 hour/day/month/source/model/session/rule 分组。不同币种分别汇总；unpriced/conflicts 不是免费。reportedCosts 与 sourceEstimates、规则估算 costs 分别说明，不能合并成实际账单。
- 同时需要多个统计维度时使用 `usage dashboard`，传入与 stats 相同的筛选、groupBy 和分页 limit/offset，一次返回趋势、来源、模型、规则分组和明细。统计和明细来自同一数据库快照；采集修订或重新计价后缓存自动失效。
- `usage list` 分页查明细；`usage export` 输出 JSON 或 CSV 内容；`audit list` 查配置和重算记录；`doctor` 检查来源。
- `server --open` 启动本地 dashboard；服务器会定时同步，`interval:0` 关闭定时采集。`server --help` 或 schema 查看启动参数。

典型任务：
1. “本周 OMP 按小时花费”：使用当地周一和当前时间对应的显式 UTC/offset 时间，`usage stats --input` 指定 source、from、to、timezone、groupBy。
2. “下周每天凌晨半价”：查现有基准规则，保留币种和各 token 单价；创建更高优先级、限定本地 dateFrom/dateTo、时区和 windows 的新规则，将价格精确减半；校验后按用户授权写入。
3. “我的 agent 也接进来”：用 schema 的 event 定义编写只输出用量的脚本，稳定 ID，先测试样本、注册、test，再 sync 两次确认去重。
