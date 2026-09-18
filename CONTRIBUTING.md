# 参与开发

需要 Bun ≥ 1.3.14。安装依赖后运行：

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run build
```

功能命令集中在 `src/commands.ts`，CLI 与 HTTP 共用业务逻辑。修改参数时同步维护 JSON Schema、README 与 `.agents/skills/token-usage/SKILL.md`。

金额使用十进制字符串，token 分类互斥；未知费用不能按零计算，多币种不能直接相加。价格更新不应静默改变历史费用，同 ID 修订沿用原价格快照，显式重算保留审计。

为解析器、计费或统计变更提供脱敏构造样例和回归验证。测试使用隔离临时目录，不读取个人账本。不要提交日志正文、凭证、真实使用记录或数据库。脚本 Provider 协议见 [文档](docs/providers.md)。

提交问题时附版本、操作系统、复现步骤与脱敏错误。修改发行构建后额外运行 `bun run release:pack` 和 `bun run release:smoke`，发布过程见 [发布文档](docs/releasing.md)。
