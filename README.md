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
| 企业微信智能机器人 | 已开启 API 模式、长连接，并取得 BotID 和 Secret；没有时按 [第 1 步](#第-1-步创建企业微信智能机器人) 创建 |

## 📦 安装

插件还没有发布到 npm，从 Git 仓库或本地目录安装。两种方式都写入 pi 的全局设置（`~/.pi/agent/settings.json`），所有项目通用。

### 方式一：从 Git 仓库安装（推荐）

```bash
pi install git:github.com/cobia68/pi-wecom-aibot
```

pi 会把仓库克隆到 `~/.pi/agent/git/github.com/cobia68/pi-wecom-aibot`，并自动安装运行所需的依赖。

> [!TIP]
> 在末尾加 `@标签` 可以固定版本，例如 `pi install git:github.com/cobia68/pi-wecom-aibot@v0.1.0`。固定后 `pi update` 和 `pi update <source>` 都不会改动它；换版本时用新标签再执行一次 `pi install`。请用标签而不是缩写的 commit 号，否则之后的 `pi update` 会失败。

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

重新打开 pi，或在已打开的 pi 中输入 `/reload`，再输入 `/wecom-aibot`：显示「未配置（运行 /wecom-aibot config global edit）」说明插件已加载。

## 🔌 连接机器人

### 第 1 步：创建企业微信智能机器人

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/)，创建或打开一个「智能机器人」。
2. 在机器人配置页面开启「API 模式」，连接方式选「长连接」。
3. 记下 **BotID** 和 **Secret**。

> [!IMPORTANT]
> 连接方式请保持「长连接」，切换为「设置接收消息回调地址」会让插件断开。

### 第 2 步：在 pi 中配置

```text
/wecom-aibot config global edit
/wecom-aibot whoami
```

1. `config global edit`：按提示填入 BotID 和 Secret，「默认推送目标」选「暂不设置」。知道 userid／chatid 时也可以直接手动填写，跳过后两步。
2. `whoami`：提示「临时识别连接已就绪」后，在企业微信给机器人发一条消息：单聊直接发，群聊需 @机器人。这里的连接仅用于识别，不是正式接入。
3. pi 显示识别到的聊天，确认后保存为全局默认推送目标，临时连接随即关闭。

这条消息只用于识别，不会被当成任务。想让通知默认发到某个群，就在那个群里 @机器人 发。

`config` 和 `whoami` **只修改配置，不自动正式接入，也不发送会话入口通知**。`whoami` 在离线时可临时连接以识别：不接收任务、不出现在在线会话列表，完成、取消或超时后关闭当前临时接入。每个 session 都必须手动执行 `/wecom-aibot connect`，新建、恢复、分叉和 `/reload` 后也不例外；退出或切换会话时自动 disconnect。`connect` / `disconnect` 不修改配置，也不影响其他已接入的 pi。

没有交互界面（如 print 模式）时不能使用 `edit`，凭据请直接写入 [配置文件](#-配置文件)。

### 第 3 步：正式接入并测试

```text
/wecom-aibot connect
/wecom-aibot test
```

`connect` 要求 BotID、Secret 和默认推送目标齐全。网关注册与企业微信订阅成功后，自动向默认目标发送一条带完整 session ID 的「会话已接入」通知，**直接引用它回复即可发送任务**。通知跟随 `notificationMode`：文字或当前终端截图；已在线重复执行 `connect` 和网络自动重连不重复通知。入口通知发送失败不代表连接失败，可用 `test` 排查。

企业微信收到「部署测试」通知，pi 提示「部署测试通知已获得企业微信服务端确认」，就接通了 🎉

## 🔐 设置白名单

> [!CAUTION]
> 默认情况下，任何能给机器人发消息的人，都能让 pi 在这台电脑上读写文件、执行命令。强烈建议只放行自己和信任的同事。

1. 收集 userid：你的 userid 在第 2 步识别时已显示（单聊时就是配置里的 `defaultChatId`）。同事的用 `/wecom-aibot whoami` 识别：执行后让同事给机器人发一条消息，询问是否设为默认推送目标时选否。
2. 打开全局 [配置文件](#-配置文件) `config.json`，加上 `allowedUserIds`（记得给上一行末尾补英文逗号）。这一项不由 `config` 命令管理，只能写在全局配置里：

   ```json
     "defaultChatType": 1,
     "allowedUserIds": ["你的 userid", "同事的 userid"]
   }
   ```

3. 在每个正在使用的 pi 窗口执行 `/wecom-aibot connect`，新名单生效。网关按各窗口接入时的名单放行：收紧名单后，没有重新接入的窗口仍按旧名单放行，撤销权限时请逐个重新接入。

设置白名单后，`/wecom-aibot whoami` 只能识别名单内的人，所以先识别、再加名单。userid 以 `/wecom-aibot whoami` 显示的为准，可能和通讯录里的账号不同。

## 📝 配置文件

配置分两层，都用 `/wecom-aibot config` 查看和修改：

- **全局配置**：同一台电脑、同一系统用户下的所有 pi 窗口共用。
- **session 覆盖**：只属于一个 pi 会话，只保存这个会话里显式设置过的字段。

```text
/wecom-aibot config                                  # 列出子命令供选择
/wecom-aibot config show                             # 当前 session 合并后的配置，标明每项来源
/wecom-aibot config global edit                      # 交互编辑全局配置
/wecom-aibot config session set screenshotTheme=light
/wecom-aibot config session unset screenshotTheme    # 删除覆盖，重新继承全局值
```

| 系统          | 位置                                         |
| :------------ | :------------------------------------------- |
| Linux / macOS | `~/.pi/agent/wecom-aibot/`                   |
| Windows       | `C:\Users\你的用户名\.pi\agent\wecom-aibot\` |

实际位置以 `/wecom-aibot` 显示的为准。这个文件夹属于插件自己：`config.json` 是全局配置，`sessions/` 放各 session 的覆盖（按 session ID 命名），`gateway/` 放共享网关的 socket；`PI_CODING_AGENT_DIR` 改变时整个文件夹随之移动。

优先级：内置默认值 < 全局配置 < session 覆盖。BotID 与 Secret、默认推送目标与类型各自成组，整组取自同一层，session 的 BotID 不会配上全局的 Secret。

- 只输入 `config`、`config global` 或 `config session` 时不执行任何动作，而是列出子命令供选择：`show`、`edit` 选中即执行；`set`、`unset` 把命令填进输入框，补上 `字段=值` 后回车。没有交互界面时只列出子命令。
- `set` 写成 `字段=值`，字段名即 JSON 键名，大小写不敏感；一条命令可写多个字段，有任何错误时一项都不保存。
- BotID 和 Secret 只能用 `edit` 输入：`set` 的命令文本会留在 pi 的输入历史里。`edit` 输入时 Secret 显示在屏幕上，之后查看时只显示「已配置」。
- 没有交互界面时不能使用 `edit`，凭据请直接编辑 `config.json`。

```json
{
  "botId": "your-bot-id",
  "secret": "your-secret",
  "defaultChatId": "your-userid",
  "defaultChatType": 1,
  "notificationMode": "text",
  "notificationScope": "wecom-tasks",
  "allowedUserIds": ["your-userid"]
}
```

| 字段                | 作用                                                                                      |
| :------------------ | :---------------------------------------------------------------------------------------- |
| `botId` / `secret`  | 机器人的 BotID 和 Secret                                                                  |
| `defaultChatId`     | 默认推送目标：单聊填 userid，群聊填群 chatid                                              |
| `defaultChatType`   | 默认推送目标类型：`1` 单聊（只给 `defaultChatId` 时即为单聊），`2` 群聊                   |
| `notificationMode`  | 正式通知的方式：`text`（默认）发 Markdown，`screenshot` 发当前终端截图；见下方「通知方式」 |
| `notificationScope` | 自动结束通知范围：`wecom-tasks`（默认）只回传企微下发的任务；`all-runs` 时**本地终端里自己敲的提示词跑完也发通知**到默认目标（没有默认目标则不发），企微任务不重复发送 |
| `screenshotTheme`   | 截图用的 pi 主题名，如 `dark`、`light` 或已安装的自定义主题；不设置时跟随 pi 当前的界面主题。只影响截图，不改变 pi 本身的界面 |
| `allowedUserIds`    | 允许使用机器人的 userid 名单；不写或留空表示所有人都能用。只能写在全局配置中，不由 `config` 管理 |

- 保存配置从不断开或重连。`notificationMode`、`notificationScope`、`screenshotTheme` 用到时现读，所有 pi 窗口下次使用时生效，无需 `connect`；已生成、等待发送的通知保持原快照。
- BotID、Secret、默认推送目标和 `allowedUserIds` 只在 `connect` 时采用。改变后，`status`、`config show` 和状态栏显示「待重新接入」，当前接入仍使用旧配置；运行 `/wecom-aibot connect` 确认后切换。切换会撤销旧注册，清除排队任务和待发通知，已开始的任务继续运行但结果不再回传。没有交互界面时，只有没有待处理工作才直接切换。
- `whoami` 确认后把目标保存到全局配置，不断开当前接入；当前 session 覆盖了凭据时不写入全局，改用提示里的 `config session set`。
- 分叉出的 session（`/fork`、`/clone`、`--fork`）首次启动时复制一次父 session 的覆盖项并提示，之后两边各自独立。连接状态不复制，也不保存到配置文件。
- Secret 以明文保存，请勿提交到代码仓库或发给他人。删除 pi 会话不会删除它的覆盖文件，不需要时手动清理 `sessions/`。

## 💬 日常使用

### pi 状态栏

当前 session 手动接入并**首次连接成功后**，底部状态栏只显示 `wecom-aibot`，不附加「在线」「重连中」等文字，也不加图标：

| 文字颜色（默认主题） | 含义                                                   |
| :------------------- | :----------------------------------------------------- |
| 绿色                 | 已完成网关注册和企业微信订阅，可以收发                 |
| 黄色                 | 已连接过，但当前断线，正在自动重连                     |
| 红色                 | 认证多次被拒绝、连接被接管等需要处理的情况；`/wecom-aibot disconnect` 后的约 1.5 秒也是红色 |

已接入后，配置文件里的接入配置（凭据、默认目标或白名单）改变时，标签后追加警示色的「（待重新接入）」，运行 `/wecom-aibot connect` 后消失。

**首次连接未就绪前不显示标签**，也不往 pi 正文追加「正在注册」「已连接」的静态通知；重复执行 `/wecom-aibot connect` 不重复提示。注册与订阅均可用后才显示绿色标签，并在企业微信发送一次会话入口通知。首次等待超过 30 秒会提醒一次，可用 `/wecom-aibot status`、`/wecom-aibot log` 排查，或 `/wecom-aibot disconnect` 取消；明确失败会提示原因。

成功连接后才用颜色跟踪断线和恢复。执行 `/wecom-aibot disconnect` 后标签先变红约 1.5 秒再隐藏，让「为什么没有反应」有个交代；`/wecom-aibot reset`、退出、切换会话或 `/reload` 后直接隐藏，新 session 必须重新手动连接。每个 pi 独立显示自己的状态，查询 `/wecom-aibot` 不会启动接入。

文字保持不变，颜色随连接事件自动切换，无需手动刷新。采用 pi 的 `success` / `warning` / `error` 主题色，主题变化时也会更新；自定义主题以其配色为准。需要文字说明或排查红色状态时，用 `/wecom-aibot` 或 `/wecom-aibot log` 查看详情，处理后执行 `/wecom-aibot connect`。

使用 pi 原生状态栏，不替换模型、用量等现有信息，也不覆盖其他扩展。不做动画或轮询，不显示凭据和聊天目标，不增加编辑区的空白行；RPC、JSON、print 模式不输出此标签。若使用自定义 footer，需要它支持显示 pi 的扩展状态。

### 发送任务

每条任务都要指明目标会话：引用 `connect` 的入口通知、结果通知或机器人发来的图片，或者用命令写出完整 session ID。机器人收到后先回一条**固定文字**的「执行中…」状态消息；文字模式下，pi 在 10 分钟内完成时这条消息直接变成结果（带 session 等来源信息），不会再单独发通知。超过 10 分钟的任务先收尾为「任务仍在执行，请等待会话通知」，结果随后单独推送。图片模式下，状态收尾为「本轮已结束，结果将另行通知」，然后单独发送当前终端截图，不额外再发完整文字结果；图片失败时改发文字兜底并说明原因。

```text
/wecom-aibot sessions
/wecom-aibot send   --sessionid <完整 session ID> --prompt <正文>
/wecom-aibot screen --sessionid <完整 session ID>
/wecom-aibot cancel --sessionid <完整 session ID>
/wecom-aibot --help
```

- `sessions` 列出在线会话：目录、供应商 · 模型、忙闲，以及单独一行的完整 session ID。
- `send` 的正文从 `--prompt` 之后开始，空格、换行和 `--` 开头的文字都原样保留；`--prompt` 必须放在最后。
- `screen` 截取该会话当前的终端画面，只读请求，不打断正在运行的任务。
- `cancel` 请求中止该会话正在运行的一轮；中止是异步生效的。
- 参数只用空格分隔，不支持 `=`；未知选项会报错并列出可用选项。
- 没有任何目标的普通消息不会投递，机器人会回一条用法提示。
- 引用机器人发来的图片（截图、图片通知）回复，同样能定位到发它的会话：网关发出的每张 PNG 里都带这个 session 的标记，读标记不需要 OCR，也不靠记住发过什么。

| 发送的内容 | pi 收到的是                                         |
| :--------- | :-------------------------------------------------- |
| 文字       | `--prompt` 之后的正文                               |
| 语音       | 自动转成的文字（引用一条通知来指定目标）            |
| 图片       | 图片本身（需要所用模型支持看图；引用一条通知来指定目标） |
| 文件、视频 | 保存到项目的 `.pi-wecom-aibot-files/`，并告诉 pi 文件位置 |
| 引用消息   | 被引用的文字一起带上；引用的若是机器人发来的图片，只当作定位会话的凭借，正文里不会留下「[图片]」 |

语音、图片、文件和视频只能在单聊中发送（企业微信的限制），单个文件不超过 50 MB。`.pi-wecom-aibot-files/` 不会自动清理，也不会被提交到 Git。

每个 pi 最多排队 50 条任务，同时准备 2 条消息的媒体（包括下载、解密、转换和保存）。尚未交给 pi 的图片 Base64 内容合计最多 128 MiB；超过预算的图片会附上失败说明，文字和已处理好的图片仍会交给 pi。交付、取消或停止时释放预算；这不限制 pi 自己的运行中输入或会话历史。媒体链接有效期较短，大量图片请分批发送。

### 同时开着多个 pi

网关不记住任何选择：每条消息自己带目标，所以不会因为切换窗口或成员变化而投到别的 pi。

- 只有一个 pi 在线时，同样要先指明目标（`/wecom-aibot sessions` 拿到 ID，或引用一条通知）。
- 引用某条会话通知回复，这条消息就交给发出该通知的 pi，且不影响其他消息。
- 引用机器人发来的一张图片回复，同样交给发这张图的 pi；图片被重新压缩、标记读不出来时，会回一条错误并附上当前会话列表。
- 群聊里每个人各自指定目标，互不影响。
- 目标 session 离线或写错时，机器人会回一条错误并附上当前会话列表。

### 共享网关

共享网关不需要单独启动或停止：

- 第一个 pi 正式接入（`/wecom-aibot connect`）或临时识别（离线 `whoami`）时，网关自动启动。临时连接不是可接收任务的在线会话。
- 其他 pi 复用同一个网关，不会各自再连一条企业微信长连接。
- 最后一个 pi 执行 `/wecom-aibot disconnect`、退出或崩溃后约 1.5 秒，网关自动退出。
- `/wecom-aibot connect` / `/wecom-aibot disconnect` 只控制**当前 session** 是否接入，不停止 pi 进程、不修改配置，也不影响其他已接入的 pi。要停止全部，就在每个 pi 窗口各执行一次 `/wecom-aibot disconnect`。
- 断开后企业微信侧不会收到「已断开」提示。网关退出前的约 1.5 秒内，若有消息到达，会回复「当前没有在线的 pi 会话」；之后长连接关闭，机器人不再响应，需要重新 `connect`。

### 完成后通知

- **企业微信发起的任务**：结果自动发回原聊天；pi 拿到的只有用户正文和图片/文件说明，不会再附加 chatid 之类的头。
- **电脑上布置的任务**：先在当前 session 执行 `/wecom-aibot connect`，再在任务里加一句「完成后发企业微信通知我」，pi 做完后推送到默认推送目标；要发到别的群，告诉 pi 那个群的 chatid。
- `wecom_send` 省略目标时：企业微信任务优先发回**来源聊天**，本地任务才使用当前接入采用的默认推送目标（`defaultChatId` / `defaultChatType`）。
- **断线恢复**：任务结果和已安排的完成通知在当前 pi 内保留快照，确定尚未发送时恢复连接后补发；若已尝试发送但确认丢失，则提示结果未知，不自动重复推送。明确被服务端拒绝的通知也不会自动重试。停止或退出当前 pi 会清除这些内存中的待发通知。

> [!NOTE]
> 企业微信要求对方先给机器人发过消息，机器人才能主动推送给他（或那个群）。正式通知默认是 Markdown 文字；`notificationMode` 为 `screenshot` 时发送当前终端截图，与 `screen` 一致。暂不支持单独发送任意图片或文件。

## 🖼️ 通知方式（文字或截图）

`notificationMode` 控制正式通知，**不是把任意消息正文排版成图**：`screenshot` 与 `screen` 使用同一种当前终端截图。

| 消息类别 | `text` | `screenshot` |
| :------- | :----- | :------ |
| connect 会话入口、自动结果、`wecom_send`（含显式 `content`）、部署测试 | Markdown：三行来源信息 + 正文 | 当前终端截图 + 来源头部，原生图片消息 |
| 执行中、排队、中止等状态回执 | 文字 | 文字 |
| 帮助、错误、在线会话列表 | 文字 | 文字 |
| 显式 `screen` 请求 | 截图 | 截图 |

- 保存配置和 `whoami` 不发送入口通知；只有正式 `connect` 成功后发送。
- `wecom_send(content: "部署成功")` 在 screenshot 模式下仍然发当前终端截图，**不把“部署成功”另画进图里**；`content` 只作为图片失败时的 Markdown 兜底。省略 `content` 时，从本轮回复摘录文字兜底。
- screenshot 模式截取 pi 编辑框以上最新一屏，不读 scrollback；编辑框、pi 状态栏（powerline 等挂在编辑框上方的栏）和 footer 都不进图片。RPC、JSON、print 模式没有 TUI，降级为 Markdown 并说明原因。
- 每张图都是**固定 1600×2150 像素**：头部固定大小，不随终端列数缩放；正文最多取最新 57 行，超出的从顶部丢掉，行数不足时下方留空（终端背景色）。113 列以内正文字号不变、右侧补白，更宽的内容等比缩小。因此不同窗口、不同内容发出的截图在企业微信里尺寸和头部完全一致。
- 图片通过 `aibot_upload_media_*` 上传后以 `msgtype=image` 发送；生成、上传失败或发送明确被拒绝时，改发 Markdown 并注明原因。发送确认丢失、结果未知时不自动发第二份。
- 显式 `screen` 失败只回复文字错误，不把无关正文当作截图结果。
- 图片会带上屏幕上的工具输出和文件内容，包括 connect 当时的旧屏幕；只发到该通知的目标聊天，不经过第三方图床。
- 头部图标是内置的 SVG 线性图标，不依赖字体。终端正文里的 emoji 仍需要单色的 Noto Emoji：Windows 和 macOS 自带的是彩色 emoji 字体，图片渲染不支持；Windows 可把 `NotoEmoji-Regular.ttf` 或 `NotoEmoji.ttf` 放到 `%LOCALAPPDATA%\Microsoft\Windows\Fonts\`。Markdown 通知不受影响。
- 截图默认就是屏幕上 pi 当前主题的颜色，自定义主题也一样；`screenshotTheme` 设为某个 pi 主题名时改用那个主题，显式 `screen` 同样如此。插件不自带主题，可选的就是 pi 的主题列表；设置时 pi 中没有的主题会被拒绝，截图时找不到则改发文字并说明原因。头部文字和图标达不到对比度下限时自动加深或提亮。三行同字号、同风格：工作目录、供应商 · 模型、session，行首图标依次是文件夹、机器人、代码对话气泡（Lucide 图标，ISC 许可；Markdown 通知仍用 🔔 / 🏷️ / 🆔）。右上角标签通常为「会话通知」，connect 入口为「会话已接入」、测试为「部署测试」，任务中止时标签和顶部色条改为警示色的「已中止」。左侧是 pi 的三色图标（官方 logo，SVG），头部和正文之间有一条分隔线。
- Linux 上中文粗体需要同目录下对应的 `-Bold` 字体文件（如 `NotoSansCJKsc-Bold.otf`）。正文里的 emoji 仍使用单色 `Noto Emoji`（Linux 可放到 `~/.local/share/fonts/noto-emoji/NotoEmoji.ttf`）；找不到时正文 emoji 可能显示为方框。彩色 emoji 字体（如 Noto Color Emoji）当前渲染不支持。

```text
/wecom-aibot config global set notificationMode=screenshot
/wecom-aibot config session set screenshotTheme=light
```

两项都在下次生成通知或截图时现读，无需重新 `connect`。

## 🧰 命令速查

| 命令                      | 作用                                                       |
| :------------------------ | :--------------------------------------------------------- |
| `/wecom-aibot`            | 查看连接状态、默认推送目标、通知设置和配置文件位置         |
| `/wecom-aibot config`     | 查看或修改配置：`[global\|session] <show\|edit\|set\|unset>`；不带动作时列出子命令供选择；只保存，不接入也不断开 |
| `/wecom-aibot whoami`     | 识别下一条消息所在的聊天，可设为全局默认推送目标           |
| `/wecom-aibot test`       | 发送一条部署测试消息                                       |
| `/wecom-aibot connect`    | 配置齐全后正式接入并发会话入口；接入配置改变后确认切换     |
| `/wecom-aibot disconnect` | 仅注销当前 session；不修改配置，最后一个 pi 注销后网关退出 |
| `/wecom-aibot log`        | 查看最近 20 条运行记录                                     |
| `/wecom-aibot reset`      | 删除全局配置并停止当前 pi 的接收（需交互确认）             |
| `/wecom-aibot --help`     | 查看全部命令；配置字段说明见 `/wecom-aibot config --help`  |

`/wecom-aibot disconnect` 只取消当前 session 的排队消息和待发通知，已开始的任务在电脑上照常跑完，但结果不再发回企业微信；其他已接入的 pi 不受影响。它不会改写配置文件；之后需要在当前或新 session 中手动 `/wecom-aibot connect` 才会接入，最后一个 pi 断开后共享网关自动退出。

`whoami` 等待或确认期间，如果机器人凭据被更换、配置被删除或当前注册被重启，旧识别结果不会写入配置，请重新识别。`reset` 若报告删除失败，当前 pi 已停止，但凭据可能仍在磁盘；请检查提示的文件权限后重试。

`reset` 删除全局配置文件：BotID、Secret、默认推送目标、通知设置和白名单一起删除，各 session 的覆盖文件保留；之后需要重新 `/wecom-aibot config global edit`。没有交互界面时 `reset` 不删除任何文件。它只停止当前 pi 的接入；其他已连接的 pi 仍会继续收发，直到它们各自 `disconnect` 或退出。

## 🔄 升级与卸载

### 升级

| 安装方式 | 命令                                                                     |
| :------- | :----------------------------------------------------------------------- |
| Git 仓库 | `pi update git:github.com/cobia68/pi-wecom-aibot`                            |
| 本地目录 | 在插件目录执行 `git pull`，再执行 `npm ci --omit=dev --legacy-peer-deps` |

`pi update <source>` 只更新这一个插件，等价于 `pi update --extension <source>`；`pi update --extensions` 更新所有已安装的插件；不带目标的 `pi update` 只更新 pi 本身。用 `@标签` 固定过版本的，`pi update` 不会移动它，换版本要用新标签再执行一次 `pi install`。

旧版本的字段 `sendMode`、`notifyEveryRun`、`enabled`、`welcome` 等不再读取，也不转换成新字段；下次保存同一层配置时从文件中删除。原来用截图通知或「每轮结束都通知」的，升级后重新设置：

```text
/wecom-aibot config global set notificationMode=screenshot notificationScope=all-runs
```

更新只替换磁盘上的文件，正在运行的 pi 和共享网关进程仍然持有旧代码，`/reload` 也换不掉已经在跑的网关。请关闭所有使用这个机器人的 pi 窗口（共享网关会在最后一个窗口退出后约 1.5 秒自行结束），再重新打开，并逐个执行 `/wecom-aibot connect`。

### 卸载

1. 在 pi 中执行 `/wecom-aibot reset`，删除全局配置里的 BotID 和 Secret；在 session 覆盖里保存过凭据的，再删除 `~/.pi/agent/wecom-aibot/sessions/`。
2. 移除插件：
   - Git 仓库：`pi remove git:github.com/cobia68/pi-wecom-aibot`，会一并删除克隆的仓库
   - 本地目录：在插件目录执行 `pi remove .`，只取消登记，不删除目录
3. 可选清理：各项目里的 `.pi-wecom-aibot-files/`，以及插件文件夹里的网关状态 `~/.pi/agent/wecom-aibot/gateway/`。

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

- 执行 `/wecom-aibot config global edit` 重新填写（凭据由 session 覆盖时用 `config session edit`）。
- 在企业微信管理后台确认机器人仍是「API 模式」+「长连接」。
- 连续被拒绝几次后插件停止重试；改好后执行 `/wecom-aibot connect` 重新连接。

</details>

<details>
<summary><b>更换 BotID 或 Secret 后连不上</b></summary>

保存配置不会切换已有的接入：已接入的 pi 窗口（包括当前窗口）在重新 `connect` 前仍使用接入时的凭据。在这些窗口执行 `/wecom-aibot connect` 确认切换，或者关闭所有 pi 窗口后重新打开，再逐个执行 `/wecom-aibot connect`。

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

执行 `/wecom-aibot whoami`，再让对方给机器人发一条消息（群聊需 @机器人）。离线时会临时连接识别，无需先 `connect`；pi 显示 chatid 和 userid，询问是否设为全局默认推送目标，只想查看时选否。默认等 2 分钟，可用 `/wecom-aibot whoami --wait 300` 延长，最长 600 秒。已连接时确认更换目标只保存配置，不断开当前接入；运行 `/wecom-aibot connect` 后改用新目标。

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
