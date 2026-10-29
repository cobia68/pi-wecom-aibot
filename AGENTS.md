# 提交

- 每个提交只做一件事并且做完：实现、测试、受影响的文档（README）、锁文件和版本号一起提交
- main 上每个提交单独检出都要通过 `npm run check`
- 无关的改动分开提交；不一起改就会编译失败、测试失败或行为不一致的，放在同一个提交里
- 大的改动拆成几步：先做不改行为的准备，再改行为，最后删掉不再用的代码
- 分支合进 main 前整理成符合上面要求的提交，用 rebase 或 squash 合入，不用 merge 提交
- 还没推到 main 的提交有遗漏，用 `git commit --amend` 或交互式 rebase 并进原来的提交；已推到 main 的不改写，要修正就再提交一个，除非用户明确要求改写
- 提交身份用 git 配置里的，不用 `--author` 覆盖
- 提交前用 `git status` 和 `git diff --cached` 核对暂存区里只有这次的改动；工作区里不属于这次任务的改动和提交不要动
- 推到 main 就会发布到 npm（见“发版”），推之前确认 `npm run check` 通过、版本号改对了

# 版本号

`package.json` 的 `version` 遵循 [SemVer](https://semver.org/lang/zh-CN/)：`MAJOR.MINOR.PATCH`。

## 递增

按影响最大的改动定：

| 改动 | 1.x 以后 | 0.x 阶段 |
| :--- | :--- | :--- |
| 不兼容：已有用户要跟着改，如删除或改名公开接口、改变它的行为、提高 `engines.node`、收窄 `peerDependencies` | MAJOR | MINOR |
| 兼容的新功能（`feat`）、标记弃用（`deprecate`） | MINOR | PATCH |
| 修复和其他影响包内容的改动（`fix`、`perf`、`security`、`refactor`、运行时依赖、包里带的 README） | PATCH | PATCH |
| 只改测试、CI、开发工具（如 `biome.json`、`scripts/`、devDependencies）或仓库说明 | 不改 | 不改 |

- 公开接口指下面这些，内部模块、测试和日志措辞不算：
  - 全局配置 `config.json` 和各 session 覆盖文件的位置、字段、取值和默认值
  - `/wecom-aibot` 的子命令和参数
  - `wecom_send` 工具的参数和行为
  - 用户在企业微信里能发的命令、能点的按钮和能填的字段
  - README 写明的接入、白名单、消息路由、通知和卡片内容
  - `package.json` 的 `engines.node`、`peerDependencies`、`pi.extensions`
- 用户确认接口稳定后再发 1.0.0
- 预发布只在用户要求时用，只用在新的 MAJOR 或 MINOR 之前，写成 `1.0.0-beta.1`、`1.0.0-rc.2`：标识和序号之间加点，不加点时 `beta10` 排在 `beta2` 前面

## 改版本号

提交时按改动改版本号，和改动放在同一个提交里：

1. `git fetch origin`，以 `origin/main` 上 `package.json` 的 `version` 为基准
2. 看这次和其他还没推送的提交，取影响最大的那一项，按递增规则从基准算出新版本号
3. 新版本号比现在的 `version` 大时，用 `npm version <新版本号> --no-git-tag-version` 改，`package-lock.json` 一起改；不比它大就不改。这样一次推送最多带一个新版本
4. rebase 到更新的 `origin/main` 后，基准可能变了，按第 1 到 3 步重新算。两边都从同一个版本升到同一个版本时 git 不会报冲突，不重算就会少升一次
5. `@cobia/pi-wecom-aibot` 还没发布到 npm 时（`npm view @cobia/pi-wecom-aibot version` 查不到）不改，现在的 `version` 就是第一版

## 发版

不手动打 tag，不手动 `npm publish`。推到 main 后，GitHub Actions 的 `publish.yml` 发现 `version` 还不在 npm 上，就跑 `npm run check`，用 trusted publishing（OIDC）发布，给这个提交打 tag `v<版本号>`，再建 GitHub Release，列出上一个 tag 以来改了 npm 包内容的提交。

- tag 只由 CI 打；推上去的 tag 不移动、不删除、不重打，发错了就发下一个版本
- `version` 已经发布过、main 上 npm 包里的文件却又改了时，CI 报错：漏改了版本号，再提交一次改版本号，不改写已推送的提交
- 一次推送里有几个提交都改了版本号时，只发最新的那个，其他的跳过
- `version` 必须比 npm 上的 `latest` 大，否则 CI 报错不发；预发布发到 `next`，不动 `latest`
- 包还不在 npm 上时，CI 只提示、不发布：trusted publishing 要在 npm 上包的设置页里配，第一版要手动发
