# npm 与 GitHub Release 发布

版本以 `package.json` 为准；CLI `--version`、Dashboard 和健康检查读取同一版本。npm 分发已构建的 CLI、Dashboard 与 Skill，GitHub Release 提供独立归档。两者运行均需 Bun ≥ 1.3.14。

## 首次发布 npm

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run npm:pack
bun run npm:smoke
npm login --registry=https://registry.npmjs.org/
npm publish artifacts/npm/tokonto-0.1.0.tgz --access public --registry=https://registry.npmjs.org/ --ignore-scripts
```

登录和发布时按 npm 的浏览器提示完成身份验证。发布精确验证过的 `.tgz`；不要将 GitHub 的 `.tar.gz` 当成 npm 安装包。`artifacts/npm/SHA256SUMS` 保存摘要。`npm:smoke` 将安装包安装到临时目录，验证命令链接、采集、计费、Skill、服务器和静态资源，无须安装脚本或开发依赖。

npm 包的文件清单只包含发行资源、文档和合成示例；原始源码、测试、账本、凭证与开发脚本不进入包。依赖已打包，许可声明位于 `dist/THIRD_PARTY_NOTICES.md`。npm 发布后的同一版本不可覆盖，下一次发布需更新版本。

首次发布完成后，在 npm 的包设置中配置 GitHub Actions Trusted Publisher。仓库为 `CaiJingLong/tokonto`，工作流为 `npm-publish.yml`，GitHub Release 公开发布后触发；使用 OIDC 发布，无须在 GitHub 保存长期 npm token。逐项配置见 [npm CI 指南](npm-ci.md)，原理见 [npm 官方 Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。

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

`release:pack` 会重新构建，生成 `artifacts/tokonto-<版本>.tar.gz`、`SHA256SUMS` 和 `release-notes.md`。明确列出的程序、文档与示例进入归档，个人数据库、日志和 `node_modules` 不会打包。依赖许可根据锁定依赖生成在包内 `THIRD_PARTY_NOTICES.md`。

`release:smoke` 校验摘要，解压到项目外临时目录，从无关工作目录验证版本、命令发现、脚本采集与去重、计费、Skill 安装、HTTP 和静态资源。它使用独立账本并关闭内置来源，不访问真实日志。

## 发布到仓库

首次发布需要先在 GitHub 建立目标仓库，配置 `origin`，提交准备好的源码和文档，并推送 `main`。不要提交 `artifacts/`、真实日志或账本。

确认仓库 CI 在 macOS、Linux 通过后，给已验证提交创建 `v0.1.0` tag 并推送：

```sh
git tag -a v0.1.0 -m 'Tokonto 0.1.0'
git push origin v0.1.0
```

tag 工作流会再次运行测试和安装验证，检查 tag 与包版本一致，然后创建 **Draft Release**，附上发行包与 SHA-256 校验文件。检查草稿内容与附件后，在 GitHub 点击发布。GitHub 自动生成的 Source code 附件是源码，不是本工具的构建安装包。

CI 或版本检查失败时不会创建 Release。重试前先检查是否已有草稿；工作流不会自动覆盖现有 Release。正式发布后的版本不应移动 tag 或覆盖附件，修复应使用新版本。

## GitHub 首发前仍需完成

- 配置目标仓库和首次提交，推送源码。
- 确认远程 macOS、Linux CI 成功；本地成功不代表远程已验证。
- 推送版本 tag，检查草稿附件与安装说明，再公开发布。
