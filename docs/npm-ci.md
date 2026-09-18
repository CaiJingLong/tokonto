# npm 自动发布配置

Tokonto 首次发布使用本地 npm 登录。后续版本通过 GitHub Actions 的 OIDC Trusted Publishing 发布，不需要创建 `NPM_TOKEN` 或保存 npm 密码。

## 一次性配置

1. 将本项目（包括 `.github/workflows/npm-publish.yml`）提交并推送到公开仓库 `CaiJingLong/tokonto` 的 `main` 分支。
2. 登录 npm，打开 [tokonto 包设置](https://www.npmjs.com/package/tokonto/access)，找到 **Trusted Publisher / Trusted publishing**，添加 GitHub Actions。
3. 按下面的值填写并保存；npm 可能要求浏览器身份验证。

| 字段 | 值 |
| --- | --- |
| Organization or user | `CaiJingLong` |
| Repository | `tokonto` |
| Workflow filename | `npm-publish.yml` |
| Environment name | 留空，当前工作流未使用 Environment |
| Allowed actions | 允许直接 `npm publish` |

Workflow filename 只填文件名，不要填 `.github/workflows/`。新建 Trusted Publisher 默认允许 staged publishing，需要额外允许 `npm publish` 才能使用本工作流。

本工作流使用 GitHub 托管的 Ubuntu runner、Node.js 24、npm 11.19.1、Bun 1.3.14，并给发布 job 设置 `id-token: write`。包内 `repository.url` 必须匹配实际 GitHub 仓库。来自公开仓库的公开包 OIDC 发布会自动生成 provenance。

## 发布后续版本

1. 修改 `package.json` 的版本，例如 `0.1.1`，更新 `CHANGELOG.md` 并创建 `docs/releases/0.1.1.md`。
2. 运行测试、类型检查、`npm:pack`、`npm:smoke`，提交并推送源码。
3. 创建 `v0.1.1` tag 并推送。现有 GitHub Release 工作流通过验证后创建草稿。
4. 检查草稿，点击 **Publish release**。`npm-publish.yml` 接收 `release.published` 事件，检出对应 tag，再次构建和验证，然后发布 npm。

也可以在 Actions → **Publish npm** → **Run workflow** 中填写已有 tag 手动触发。手动发布同样只检出该 tag，不会发布当前未提交代码。当前工作流只接受稳定版本，并发布到 `latest`；预发布版本需要另行设置 npm tag。

`0.1.0` 若已本地发布，不要再次用此工作流发布相同版本；可以从下一版 `0.1.1` 验证自动发布。npm 不允许覆盖相同版本。

## 排查

- 验证失败：检查 npm 设置中的 owner、repo、workflow filename 是否完全一致，以及 Allowed actions 是否允许 `npm publish`。
- Provenance / repository 错误：确认仓库公开，`package.json` 的 `repository.url` 为 `git+https://github.com/CaiJingLong/tokonto.git`。
- 找不到 tag：先推送版本 tag；发布 job 只读取 `refs/tags/<tag>`。
- 版本已存在：不要移动旧 tag 或试图覆盖，修复后增加新版本。

参见 [npm 官方 Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。保存设置成功只表示配置已记录，首个后续版本的工作流成功发布后，才算完成端到端验证。
