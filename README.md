<div align="center">

# 🤖 pi-wecom-aibot

在企业微信里给 [pi](https://pi.dev) 发任务，进度和结果直接回到聊天窗口。

[📦 安装](#-安装) · [🔌 连接机器人](#-连接机器人) · [📝 配置文件](#-配置文件) · [🧰 命令速查](#-命令速查) · [❓ 常见问题](#-常见问题)

</div>

## ✅ 准备工作

| 准备项             | 说明                                                                                                 |
| :----------------- | :--------------------------------------------------------------------------------------------------- |
| 一台常开的电脑     | 关机、休眠或退出 pi 后机器人不再回复；同一个机器人同一时间只能在一台电脑、一个系统用户下连接         |
| pi                 | 1.3.0 或更高                                                                                         |
| Node.js            | 22.19.0 或更高，需要在 PATH 中                                                                       |
| Git                | 用于克隆插件仓库                                                                                     |
| 企业微信智能机器人 | 已开启 API 模式、长连接，并取得 BotID 和 Secret；没有时按 [第 1 步](#第-1-步创建企业微信机器人) 创建 |

## 📦 安装

插件还没有发布到 npm，从 Git 仓库或本地目录安装。两种方式都写入 pi 的全局设置（`~/.pi/agent/settings.json`），所有项目通用。

### 方式一：从 Git 仓库安装（推荐）

```bash
pi install git:github.com/cobia68/pi-wecom-aibot
```

pi 会把仓库克隆到 `~/.pi/agent/git/github.com/cobia68/pi-wecom-aibot`，并自动安装运行所需的依赖。

> [!TIP]
> 在末尾加 `@标签` 可以固定版本，例如 `pi install git:github.com/cobia68/pi-wecom-aibot@v0.1.0`。固定后 `pi update` 不会改动它；换版本时用新标签再执行一次 `pi install`。请用标签而不是缩写的 commit 号，否则之后的 `pi update` 会失败。

### 方式二：从本地目录安装

适合先改代码再试用。pi 不会给本地目录安装依赖，需要自己装一次：

```bash
git clone https://github.com/cobia68/pi-wecom-aibot.git
cd pi-wecom-aibot
npm ci --omit=dev --legacy-peer-deps
pi install .
```

- `npm ci` 这一步不能省：缺少依赖时 `/wecom-aibot` 命令照样出现，但后台网关启动不了，机器人连不上。
- pi 直接从这个目录加载插件，装好后不要移动或删除它。
- Windows 和 Linux 请各用一份克隆，不要共用同一个 `node_modules`。

### 检查安装

重新打开 pi，或在已打开的 pi 中输入 `/reload`，再输入 `/wecom-aibot`：显示「未配置（运行 /wecom-aibot setup）」说明插件已加载。

## 🔌 连接机器人

### 第 1 步：创建企业微信机器人

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/)，创建或打开一个「智能机器人」。
2. 在机器人配置页面开启「API 模式」，连接方式选「长连接」。
3. 记下 **BotID** 和 **Secret**。

> [!IMPORTANT]
> 连接方式请保持「长连接」，切换为「设置接收消息回调地址」会让插件断开。

### 第 2 步：在 pi 中配置

```text
/wecom-aibot setup
```

1. 按提示填入 BotID 和 Secret。
2. 「默认推送目标」选「自动识别：连上后给机器人发一条消息」。
3. 提示「已连接」后，在企业微信给机器人发一条消息：单聊直接发，群聊需 @机器人。
4. pi 显示识别到的聊天，确认后保存为默认推送目标。

这条消息只用于识别，不会被当成任务。想让通知默认发到某个群，就在那个群里 @机器人 发。

`/wecom-aibot setup` 会配置并连接**当前 session**。之后每个 session 都必须手动执行 `/wecom-aibot connect`，新建、恢复、分叉和 `/reload` 后也不例外；退出或切换会话时自动 disconnect。`connect` / `disconnect` 不修改共享配置，也不影响其他已接入的 pi。旧配置里的 `enabled` 已被忽略，即使为 `true` 也不会自动接入。

### 第 3 步：发送测试

```text
/wecom-aibot test
```

企业微信收到一条「部署测试」消息，pi 提示「部署测试通知已获得企业微信服务端确认」，就接通了 🎉

## 🔐 设置白名单

> [!CAUTION]
> 默认情况下，任何能给机器人发消息的人，都能让 pi 在这台电脑上读写文件、执行命令。强烈建议只放行自己和信任的同事。

1. 收集 userid：你的 userid 在第 2 步识别时已显示（单聊时就是配置里的 `defaultChatId`）。同事的用 `/wecom-aibot whoami` 识别：执行后让同事给机器人发一条消息，询问是否设为默认推送目标时选否。
2. 打开 [配置文件](#-配置文件)，加上 `allowedUserIds`（记得给上一行末尾补英文逗号）：

   ```json
     "defaultChatType": 1,
     "allowedUserIds": ["你的 userid", "同事的 userid"]
   }
   ```

3. 在每个正在使用的 pi 窗口执行 `/wecom-aibot connect`，新名单生效。

设置白名单后，`/wecom-aibot whoami` 只能识别名单内的人，所以先识别、再加名单。userid 以 `/wecom-aibot whoami` 显示的为准，可能和通讯录里的账号不同。

## 📝 配置文件

| 系统          | 位置                                           |
| :------------ | :--------------------------------------------- |
| Linux / macOS | `~/.pi/agent/wecom-aibot.json`                   |
| Windows       | `C:\Users\你的用户名\.pi\agent\wecom-aibot.json` |

实际位置以 `/wecom-aibot` 显示的为准。同一台电脑、同一系统用户下的 pi 窗口共用这份配置。`/wecom-aibot setup` 会写好 BotID、Secret 和默认推送目标，其余选项直接编辑：

```json
{
  "botId": "your-bot-id",
  "secret": "your-secret",
  "sendMode": "text",
  "defaultChatId": "your-userid",
  "defaultChatType": 1,
  "welcome": "你好，我是 pi 智能助手。直接把问题或任务发给我即可。",
  "allowedUserIds": ["your-userid"]
}
```

| 字段               | 作用                                                                                      |
| :----------------- | :---------------------------------------------------------------------------------------- |
| `botId` / `secret` | 机器人的 BotID 和 Secret                                                                  |
| `sendMode`         | 自动结果的通知模式：`text`（默认）发 Markdown，`image` 发当前终端图片；见下方「通知模式」 |
| `allowedUserIds`   | 允许使用机器人的 userid 名单；不写或留空表示所有人都能用                                  |
| `defaultChatId`    | 默认推送目标：单聊填 userid，群聊填群 chatid                                              |
| `defaultChatType`  | 默认推送目标类型：`1` 单聊，`2` 群聊                                                      |
| `welcome`          | 每天第一次打开单聊时的欢迎语                                                              |

- 改完后在每个正在使用的 pi 窗口执行 `/wecom-aibot connect` 生效。只改欢迎语或默认推送目标不会清掉排队任务和通知；更换 BotID、Secret 或 `allowedUserIds` 会撤销旧注册及其待处理工作。
- 连接状态只属于当前 session，不保存到配置文件。旧 `enabled` 字段留在文件里也无效，不需要改动或重新填写凭据。
- Secret 以明文保存，请勿提交到代码仓库或发给他人。

## 💬 日常使用

### pi 状态栏

当前 session 手动接入并**首次连接成功后**，底部状态栏只显示 `wecom-aibot`，不附加「在线」「重连中」等文字，也不加图标：

| 文字颜色（默认主题） | 含义                                                   |
| :------------------- | :----------------------------------------------------- |
| 绿色                 | 已完成网关注册和企业微信订阅，可以收发                 |
| 黄色                 | 已连接过，但当前断线，正在自动重连                     |
| 红色                 | 认证多次被拒绝、连接被接管等情况，已暂停重试，需要处理 |

**首次连接未就绪前不显示标签**，也不往正文追加「正在注册」「已连接」的静态通知；重复执行 `/wecom-aibot connect` 不重复提示。首次等待超过 30 秒会提醒一次，可用 `/wecom-aibot status`、`/wecom-aibot log` 排查，或 `/wecom-aibot disconnect` 取消；明确失败会提示原因。

成功连接后才用颜色跟踪断线和恢复。执行 `/wecom-aibot disconnect` / `/wecom-aibot logout`、退出、切换会话或 `/reload` 后隐藏，新 session 必须重新手动连接。每个 pi 独立显示自己的状态，查询 `/wecom-aibot` 不会启动接入。

文字保持不变，颜色随连接事件自动切换，无需手动刷新。采用 pi 的 `success` / `warning` / `error` 主题色，主题变化时也会更新；自定义主题以其配色为准。需要文字说明或排查红色状态时，用 `/wecom-aibot` 或 `/wecom-aibot log` 查看详情，处理后执行 `/wecom-aibot connect`。

使用 pi 原生状态栏，不替换模型、用量等现有信息，也不覆盖其他扩展。不做动画或轮询，不显示凭据和聊天目标，不增加编辑区的空白行；RPC、JSON、print 模式不输出此标签。若使用自定义 footer，需要它支持显示 pi 的扩展状态。

### 发送任务

单聊直接发消息，群聊先 @机器人。机器人先回一条「执行中…」的状态消息，pi 处理完后改为「本轮已结束」，结果单独发一条会话通知。

- pi 正忙时新消息排队，按顺序处理。
- 任务超过约 10 分钟时，状态消息提前改为「任务仍在执行，请等待会话通知。」，完成后照常发结果。
- 同一个 pi 窗口里，所有企业微信聊天共用一份对话；需要分开时，开不同的 pi 窗口。

| 发送的内容 | pi 收到的是                                         |
| :--------- | :-------------------------------------------------- |
| 文字       | 直接作为任务                                        |
| 语音       | 自动转成的文字                                      |
| 图片       | 图片本身（需要所用模型支持看图）                    |
| 文件、视频 | 保存到项目的 `.pi-wecom-aibot-files/`，并告诉 pi 文件位置 |
| 引用消息   | 被引用的文字一起带上                                |

语音、图片、文件和视频只能在单聊中发送（企业微信的限制），单个文件不超过 50 MB。`.pi-wecom-aibot-files/` 不会自动清理，也不会被提交到 Git。

每个 pi 最多排队 50 条任务，同时准备 2 条消息的媒体（包括下载、解密、转换和保存）。尚未交给 pi 的图片 Base64 内容合计最多 128 MiB；超过预算的图片会附上失败说明，文字和已处理好的图片仍会交给 pi。交付、取消或停止时释放预算；这不限制 pi 自己的运行中输入或会话历史。媒体链接有效期较短，大量图片请分批发送。

### 同时开着多个 pi

- 只有一个 pi 在线时，消息直接交给它。
- 有多个时，机器人列出每个 pi 的项目文件夹、模型和会话编号，回复序号选择；触发选择的那条消息暂存 5 分钟，选好后自动交给它。
- 选好后，后续消息都交给同一个 pi；它退出或切换会话后会请你重新选择。群聊里每个人的选择互不影响。
- 引用某条会话通知回复，消息直接交给发出这条通知的 pi。

在企业微信里发 `/wecom-aibot sessions` 重新列出并选择，发 `/wecom-aibot use <会话编号>` 按通知里 `session:` 后的完整编号选择。

### 共享网关

共享网关不需要单独启动或停止：

- 第一个 pi 手动接入（`/wecom-aibot connect` 或配置时的 `/wecom-aibot setup`）时，网关自动启动。
- 其他 pi 复用同一个网关，不会各自再连一条企业微信长连接。
- 最后一个 pi 执行 `/wecom-aibot disconnect`、退出或崩溃后约 1.5 秒，网关自动退出。
- `/wecom-aibot connect` / `/wecom-aibot disconnect` 只控制**当前 session** 是否接入，不停止 pi 进程、不修改共享配置，也不影响其他已接入的 pi。要停止全部，就在每个 pi 窗口各执行一次 `/wecom-aibot disconnect`。

### 完成后通知

- **企业微信发起的任务**：结果自动发回原聊天；pi 拿到的只有用户正文和图片/文件说明，不会再附加 chatid 之类的头。
- **电脑上布置的任务**：先在当前 session 执行 `/wecom-aibot connect`，再在任务里加一句「完成后发企业微信通知我」，pi 做完后推送到默认推送目标；要发到别的群，告诉 pi 那个群的 chatid。
- `wecom_send` 省略目标时：企业微信任务优先发回**来源聊天**，本地任务才使用 `defaultChatId` / `defaultChatType`。
- **断线恢复**：任务结果和已安排的完成通知在当前 pi 内保留快照，确定尚未发送时恢复连接后补发；若已尝试发送但确认丢失，则提示结果未知，不自动重复推送。明确被服务端拒绝的通知也不会自动重试。停止或退出当前 pi 会清除这些内存中的待发通知。

> [!NOTE]
> 企业微信要求对方先给机器人发过消息，机器人才能主动推送给他（或那个群）。通知默认是 Markdown 文字；`sendMode: "image"` 时自动结果会发一张渲染后的终端图片。暂不支持单独发送任意图片或文件。

## 🖼️ 通知模式（文字或图片）

`sendMode` 决定自动结果怎么发：

| `sendMode`     | 自动结果     | 说明                                                                                          |
| :------------- | :----------- | :-------------------------------------------------------------------------------------------- |
| `text`（默认） | Markdown     | 三行来源信息 + 正文                                                                           |
| `image`        | 原生图片消息 | 当前 pi 终端可见内容 + 卡片式来源头部；session 等信息在图片里，不含 footer/状态栏；不需要图床 |

- 只作用于自动结果（企业微信任务的结果、`wecom_send` 不带 `content` 的完成通知）。`wecom_send` 显式给 `content` 和 `/wecom-aibot test` 始终发 Markdown。
- image 模式截取 pi 编辑框以上最新一屏，不读 scrollback；RPC、JSON、print 模式没有 TUI，自动降级为 Markdown。
- 图片通过 `aibot_upload_media_*` 上传后以 `msgtype=image` 发送；生成或上传失败时改发 Markdown，并在末尾注明原因。
- 图片会带上屏幕上的工具输出和文件内容，只发到当前企业微信会话，不经过第三方图床。
- 头部按终端主题配色，深色、浅色都适用：标题是工作目录，右侧标签为「会话通知」，任务中止时改为警示色的「已中止」；下面两行是供应商 · 模型和 session。图标是 SVG 矢量图形，不依赖 emoji 字体。
- Linux 上中文粗体需要同目录下对应的 `-Bold` 字体文件（如 `NotoSansCJKsc-Bold.otf`）。正文里的 emoji 仍使用单色 `Noto Emoji`（Linux 可放到 `~/.local/share/fonts/noto-emoji/NotoEmoji.ttf`）；找不到时正文 emoji 可能显示为方框。彩色 emoji 字体（如 Noto Color Emoji）当前渲染不支持。

```json
{
  "sendMode": "image"
}
```

修改后在每个 pi 窗口执行 `/wecom-aibot connect` 重新读取配置。

## 🧰 命令速查

| 命令                | 作用                                                       |
| :------------------ | :--------------------------------------------------------- |
| `/wecom-aibot`            | 查看连接状态、默认推送目标和配置文件位置                   |
| `/wecom-aibot setup`      | 配置或更换 BotID、Secret，并重新连接                       |
| `/wecom-aibot whoami`     | 识别下一条消息所在的聊天，可设为默认推送目标               |
| `/wecom-aibot test`       | 发送一条部署测试消息                                       |
| `/wecom-aibot connect`    | 当前 session 手动接入并重新读取配置；网关未运行时自动启动  |
| `/wecom-aibot disconnect` | 仅注销当前 session；不修改配置，最后一个 pi 注销后网关退出 |
| `/wecom-aibot log`        | 查看最近 20 条运行记录                                     |
| `/wecom-aibot logout`     | 删除保存的配置并停止接收（需确认）                         |
| `/wecom-aibot --help`     | 查看全部命令；配置字段说明见 `/wecom-aibot setup --help`         |

`/wecom-aibot disconnect` 只取消当前 session 的排队消息和待发通知，已开始的任务在电脑上照常跑完，但结果不再发回企业微信；其他已接入的 pi 不受影响。它不会改写配置文件；之后需要在当前或新 session 中手动 `/wecom-aibot connect` 才会接入，最后一个 pi 断开后共享网关自动退出。

`whoami` 等待或确认期间，如果机器人凭据被更换、配置被删除或当前注册被重启，旧识别结果不会写入配置，请重新识别。`logout` 若报告删除失败，当前 pi 已停止，但凭据可能仍在磁盘；请检查提示的文件权限后重试。

## 🔄 升级与卸载

### 升级

| 安装方式 | 命令                                                                     |
| :------- | :----------------------------------------------------------------------- |
| Git 仓库 | `pi update git:github.com/cobia68/pi-wecom-aibot`                            |
| 本地目录 | 在插件目录执行 `git pull`，再执行 `npm ci --omit=dev --legacy-peer-deps` |

然后关闭所有使用这个机器人的 pi 窗口，再重新打开并逐个执行 `/wecom-aibot connect`。当前本机网关协议为 v3（支持投递结果分类和欢迎语热更新），不能与旧网关混用；原配置文件无需迁移。

本次连接行为变化：每个 session 都需手动 `/wecom-aibot connect`，退出、切换或重载时自动断开；旧 `enabled` 字段完全忽略，`connect` / `disconnect` 不再改写它。连接成功只通过状态栏显示，取消静态注册提示。

其他兼容说明：旧的 `screenMode`、`imageHosts`、`fontFiles`、`/wecom-aibot screen` 和 `wecom_send(screen=true)` 已移除，旧字段会被忽略；使用 `sendMode`（`text` / `image`），图片通过企业微信原生图片消息发送，不再需要图床。

帮助入口只剩 `--help` / `-h`：`/wecom-aibot --help` 看总帮助，`/wecom-aibot <子命令> --help` 看某个子命令；`help` 不再是子命令，`/wecom-aibot help` 会按未知子命令报错。

只执行 `pi update` 更新的是 pi 本身；`pi update --extensions` 更新所有已安装的插件。

### 卸载

1. 在 pi 中执行 `/wecom-aibot logout`，删除保存的 BotID 和 Secret。
2. 移除插件：
   - Git 仓库：`pi remove git:github.com/cobia68/pi-wecom-aibot`，会一并删除克隆的仓库
   - 本地目录：在插件目录执行 `pi remove .`，只取消登记，不删除目录
3. 可选清理：各项目里的 `.pi-wecom-aibot-files/`，以及会话选择记录 `~/.pi/wecom-aibot-gateway/`。

## ❓ 常见问题

<details>
<summary><b>给机器人发消息没有反应</b></summary>

- 确认至少有一个 pi 正在运行并已接入：执行 `/wecom-aibot`，状态应为 `subscribed`。
- 群聊中需要先 @机器人。
- 设置了白名单时，名单外的人发的消息会被直接忽略。
- 执行 `/wecom-aibot log` 查看运行记录。出现 `gateway process exited` 或 `gateway launch failed` 时，多半是本地目录安装漏了 `npm ci`，或 PATH 中找不到 Node.js。

</details>

<details>
<summary><b>提示「机器人连接已被其他机器或旧客户端接管」</b></summary>

同一个机器人同一时间只能在一处连接。另一台电脑或另一个系统用户启用了同一个机器人时，这里会被挤下线。确认只在一处使用后，在任一 pi 中执行 `/wecom-aibot connect` 恢复。

</details>

<details>
<summary><b>连接失败，提示核对 BotID/Secret</b></summary>

- 执行 `/wecom-aibot setup` 重新填写。
- 在企业微信管理后台确认机器人仍是「API 模式」+「长连接」。
- 连续被拒绝几次后插件停止重试；改好后执行 `/wecom-aibot connect` 重新连接。

</details>

<details>
<summary><b>更换 BotID 或 Secret 后连不上</b></summary>

其他还开着的 pi 窗口仍在用旧配置。在这些窗口执行 `/wecom-aibot connect` 读取新配置，或者关闭所有 pi 窗口后重新打开，再逐个执行 `/wecom-aibot connect`。

</details>

<details>
<summary><b>收不到主动推送</b></summary>

- 对方需要先在企业微信里给机器人发过消息。
- 企业微信限制每个聊天每分钟最多 30 条、每小时最多 1000 条消息。
- 没有默认推送目标时，用 `/wecom-aibot whoami` 设置，或在任务里写明发给谁。
- 失败原因可以在 `/wecom-aibot log` 中查看。

网络短暂中断时，已完成的结果会在恢复连接后补发；退出 pi 会取消还没发出的通知。

</details>

<details>
<summary><b>怎么查自己的 userid 或群的 chatid</b></summary>

执行 `/wecom-aibot whoami`，再让对方给机器人发一条消息（群聊需 @机器人）。pi 显示识别到的 chatid 和 userid，并询问是否设为默认推送目标，只想查看时选否。默认等 2 分钟，可用 `/wecom-aibot whoami --wait 300` 延长，最长 600 秒。

</details>

<details>
<summary><b>日志里经常出现 WebSocket closed，能否只在发送时连接</b></summary>

网关会自动重连：30 秒内恢复只记日志，超过 30 秒提醒一次，恢复后再提醒。日志里的 `1006` 只表示异常断开，不能据此判断是企业微信服务端还是中间网络造成的。

插件需要长连接实时接收任务和引用回复，断开期间收不到消息，所以保持连接。要暂停请用 `/wecom-aibot disconnect`。

</details>

<details>
<summary><b>机器人回复「当前等待任务较多，请稍后重试。」</b></summary>

每个 pi 最多排队 50 条消息，等前面的任务处理完再发。

</details>

## 🛠️ 开发

生产代码按运行归属组织：

- `src/extension/`：pi 侧入口、命令、会话桥接、状态栏和入站媒体。
- `src/gateway/`：独立网关进程、会话路由和企业微信长连接。
- `src/shared/`：双方共用的协议、通知契约和格式规则，不依赖任何一端实现。

扩展入口由 `package.json` 的 `pi.extensions` 声明为 `src/extension/index.ts`；如果原先直接指定根目录 `index.ts` 加载，请更新路径。按包安装的用户无需修改设置。

开发时需要安装完整依赖，不要使用 `--omit=dev`；Windows 和 Linux 各用独立的克隆及 `node_modules`：

```bash
npm ci
npm run check
```

`check` 包含类型检查、递归发现的全部测试和真实 pi loader 的扩展加载检查。也可以单独运行：

```bash
npm test -- --test-name-pattern=notification
node --import tsx --test tests/shared/notification.test.ts
npm pack --dry-run --json
```

源码直接发布，不需要生成 `dist/`。新增生产文件放入 `src/`，测试放入 `tests/`，无需逐项修改发布白名单或测试命令。修改后在 pi 中执行 `/reload` 加载新入口。
