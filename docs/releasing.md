# GitHub Release 发布

版本以 `package.json` 为准；CLI `--version`、Dashboard 和健康检查读取同一版本。第一版通过 GitHub Release 分发，不发布到 npm。安装包包含已打包 JavaScript，仍需 Bun ≥ 1.3.14。

## 本地准备

1. 更新版本号、`CHANGELOG.md` 和 `docs/releases/<版本>.md`。
2. 运行以下检查，全部成功后再创建 tag：

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run release:pack
bun run release:smoke
```

`release:pack` 会重新构建，生成 `artifacts/token-usage-<版本>.tar.gz`、`SHA256SUMS` 和 `release-notes.md`。明确列出的程序、文档与示例进入归档，个人数据库、日志和 `node_modules` 不会打包。依赖许可根据锁定依赖生成在包内 `THIRD_PARTY_NOTICES.md`。

`release:smoke` 校验摘要，解压到项目外临时目录，从无关工作目录验证版本、命令发现、脚本采集与去重、计费、Skill 安装、HTTP 和静态资源。它使用独立账本并关闭内置来源，不访问真实日志。

## 发布到仓库

首次发布需要先在 GitHub 建立目标仓库，配置 `origin`，提交准备好的源码和文档，并推送 `main`。不要提交 `artifacts/`、真实日志或账本。

确认仓库 CI 在 macOS、Linux 通过后，给已验证提交创建 `v0.1.0` tag 并推送：

```sh
git tag -a v0.1.0 -m 'Token Usage 0.1.0'
git push origin v0.1.0
```

tag 工作流会再次运行测试和安装验证，检查 tag 与包版本一致，然后创建 **Draft Release**，附上发行包与 SHA-256 校验文件。检查草稿内容与附件后，在 GitHub 点击发布。GitHub 自动生成的 Source code 附件是源码，不是本工具的构建安装包。

CI 或版本检查失败时不会创建 Release。重试前先检查是否已有草稿；工作流不会自动覆盖现有 Release。正式发布后的版本不应移动 tag 或覆盖附件，修复应使用新版本。

## 0.1.0 首发前仍需在 GitHub 完成

- 配置目标仓库和首次提交，推送源码。
- 确认远程 macOS、Linux CI 成功；本地成功不代表远程已验证。
- 推送版本 tag，检查草稿附件与安装说明，再公开发布。
