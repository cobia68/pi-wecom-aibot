# 🤖 pi-wecom-aibot

在企业微信里给 [pi](https://pi.dev) 发任务，用卡片查看结果、切换模型和中止任务。采用长连接，无需公网回调地址

## 📦 安装

```bash
pi install npm:@cobia/pi-wecom-aibot
```

安装后重新打开 pi，或执行 `/reload`，再输入 `/wecom-aibot` 检查插件是否加载

## 🔌 连接机器人

### 1. 创建机器人

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/)，创建或打开一个「智能机器人」
2. 开启「API 模式」，连接方式选「长连接」
3. 记下 **BotID** 和 **Secret**

### 2. 配置并接入

在 pi 中执行：

```text
/wecom-aibot config edit
```

1. 填入 BotID 和 Secret
2. 「默认推送目标」选「发验证码识别」，在接收通知的聊天里把 pi 显示的 6 位验证码发给机器人，群聊需 @机器人
3. 确认识别到的聊天并保存。知道 userid／chatid 时也可以选「手动填写」

识别只会临时连接，不接收任务。保存后正式接入并测试：

```text
/wecom-aibot connect
/wecom-aibot test
```

收到「🧪 部署测试」控制卡后，点「刷新卡片」验证按钮回调

**每个会话都要手动 `connect`**，新建、恢复、分叉和 `/reload` 后也一样。修改配置不会自动接入；退出或切换会话时自动断开

同一个机器人同一时间只能在一台电脑、一个系统用户下连接。多个 pi 会话共用网关，无需单独启动；最后一个 pi 断开后，网关约 1.5 秒自动退出

## 🔐 设置白名单

> [!CAUTION]
> 不设置 `allowedUserIds` 或留空时，任何能给机器人发消息的人都能让 pi 读写文件、执行命令。强烈建议只允许自己和信任的同事

1. 用 `/wecom-aibot config whoami` 识别 userid：让本人把 pi 显示的验证码发给机器人。未指定 `--scope` 时不修改默认推送目标
2. 在[全局配置文件](#-配置文件)中添加 `"allowedUserIds": ["你的 userid", "同事的 userid"]`。此字段只能写在全局配置中，首次设置需手动编辑
3. 在**每个已接入的 pi 窗口**执行 `/wecom-aibot connect`，新名单才会生效；未重新接入的窗口仍按旧名单放行

识别不受白名单限制，也不等于授权。已有名单时，`whoami` 识别到新成员会询问是否加入。userid 以识别结果为准，可能与通讯录账号不同

## 💬 日常使用

### 发送任务

在单聊里直接发消息，群聊先 @机器人：

- **普通消息**：机器人询问「这条消息发给哪个会话？」，选好后点「确认发送」。只有一个会话在线也要确认；不改下拉框就确认，会发给第一个候选
- **引用文字消息**：引用开头带 `🆔 session: <ID>` 的机器人文字回复，可以直接发给那个会话；会话已离线时重新询问目标
- **引用卡片、图片或文件**：无法定位会话，仍需选择。企业微信不会把被引用卡片的内容传给机器人

**选择只对当前消息有效，不会记住上一次的目标**。选择卡有效期为 4 分钟；同一人在同一聊天又发一条需要选择目标的消息时，上一条待选消息取消。群聊里只有发送者能确认

运行期间不发送「执行中…」状态消息，完成后发一张新的结果卡；消息未能执行时会回复原因。想继续，可在结果卡上点「发提示词」，或重新发消息并选择会话

| 发送内容 | pi 收到的内容 |
| :--- | :--- |
| 文字 | 消息正文 |
| 语音 | 转写后的文字 |
| 图片 | 图片本身，需要模型支持看图 |
| 文件、视频 | 保存到项目的 `.pi-wecom-aibot-files/`，通过 `[attachments]` 告知文件位置 |
| 引用消息 | 被引用的文字放在 `[quote]` 中；引用的图片、文件不会附带 |

模型只收到上表里的内容，不知道是谁发的、从哪个聊天发的。只有一个 @ 没有文字也没有图片的群消息，模型收到「（空消息）」。来源只显示在 pi 终端里：每条企微消息上方有一行暗色的 `[wecom|from:<userid>|chat:单聊]`，群聊写 `chat:群聊`，不写聊天的 chatid。这行记在会话里，重新打开会话也看得到，但不发给模型，也不占上下文。「发提示词」发出的任务没有这一行。这一轮的系统提示里还会加一段说明：结果会以控制卡发回这个聊天、在手机上看、不要写密钥、怎样给出下一步

语音、图片、文件和视频仅支持单聊，单个文件不超过 50 MB。附件目录不会自动清理，也不会被提交到 Git。每个 pi 最多排队 50 条任务，大量图片请分批发送

### 每个 session 的控制卡

控制卡显示工作目录、模型、完整 session ID、正文摘要或文档入口，以及最近一次操作的结果：

| 按钮 | 作用 |
| :--- | :--- |
| 刷新卡片 | 读取终端当前画面；启用文档时同步更新会话文档，不调用模型 |
| 发提示词 | 从本卡的下一步或 `controlPrompts` 中选择，确认后发送；忙时排队，无候选时提示先配置 |
| 切换模型 | 选择并确认，仅影响当前会话的后续运行，不修改 pi 默认模型；模型多时可翻页 |
| 中止任务 | 由同一人在 60 秒内确认；有排队时还可选「全部中止」或「清空排队」 |

- **切换会话**：在下拉框选另一个会话，再点任一按钮。这次只切换卡片，不执行按钮动作；确认会话后再操作
- **找回控制卡**：在企微发 `/wa s`，选会话后点「打开会话」。列表每页 5 个，可刷新和翻页；当天首次进入机器人单聊时也会收到这张列表，只显示白名单允许访问的会话
- **候选太多**：任务选择卡最多列最近使用的 10 个会话。需要的会话不在其中时，先用 `/wa s` 打开它的控制卡，再重新发送任务；打开控制卡不会自动定向后续消息
- **发送与刷新**：每次 `connect`、任务完成和通知都发新卡，旧卡不撤回。网络重连、网关替换不重发；卡片内容是快照，不会自动刷新，新接入的会话也要点按钮才出现在旧卡列表里

结果可以在末尾附上 `<!-- wecom_next ["运行测试", "提交改动"] -->`，作为本卡「发提示词」的优先候选，最多 10 条、每条最多 500 字。注释不会出现在企业微信正文中。下一步和正文摘要仅在当前接入期间保留最近 50 张卡，断开或重启后不保留；配置的 `controlPrompts` 不受影响

### 会话文档

默认 `contentDisplay=inline`：卡片只显示正文开头的纯文本摘要，**手机最多三行，不能点击展开全文**。需要阅读更多内容时启用 `linked`：

1. 在企业微信「工作台 → 智能机器人 → 找到机器人 → 编辑 → 可使用权限」授权「文档」，点「查看使用方式」，复制 **streamableHTTP URL**，不是 JSON Config
2. 在 pi 中执行 `/wecom-aibot config edit`，选「会话文档」并粘贴地址。地址必须为 `https://…qq.com/…`，含 apikey，需像密码一样保管
3. 将「正文展示方式」设为 `linked`，再执行 `/wecom-aibot connect`；页面写入成功后，卡片引用区可打开会话文档

也可以只为当前会话启用：

```text
/wecom-aibot config --scope session set contentDisplay=linked
```

- 每台电脑、每个机器人一份文档，每个 session 一页，保留最近 3 轮提问与回复、最近 3 条带正文的 `wecom_send` 通知。长内容会截断，不是永久归档；正文不包含终端画面或附件
- **只配置 `docMcpUrl` 不会启用文档**。`linked` 不回退到卡片正文摘要：未配置地址、写入失败或超时时，引用区显示原因和处理提示，不显示正文或终端内容，不保留失效链接
- **授权失效或权限不足**：引用区提示「文档权限不足或授权已到期」，并提示到「工作台 → 智能机器人 → 可使用权限」重新授权。网络、超时等错误不冒充权限到期；修复后点「刷新卡片」，成功写入即可恢复文档入口，旧卡不自动更新
- 文档默认企业内需申请、企业外拒绝。默认目标为单聊时，该用户会加入只读成员；第一次点「刷新卡片」的人也会加入。群里其他人需要申请访问
- 授权有效期为 7 天，过期后重新授权；地址变更时重新填写。新建页面时清理 7 天未刷新的页面，`reset` 删除本机登记的全部页面；文档本身需在企业微信里手动删除

### 完成后通知

- **企业微信发起的任务**：结果以一张结果卡发回原聊天，不回复原消息；模型拿到的是用户正文和图片/文件说明，不带发送人和 chatid；发送人只显示在 pi 终端的来源行里
- **电脑上布置的任务**：当前会话接入后，告诉 pi「完成后发企业微信通知我」，推送到默认目标。希望每轮都通知，可设置 `notificationScope=all-runs`
- **指定目标**：告诉 pi 对方的 userid 或群 chatid。`wecom_send` 未指定目标时，企微任务优先回来源聊天，本地任务使用接入时采用的默认目标

主动推送要求对方先给机器人发过消息；暂不支持发送图片或文件。通知正文按 `contentDisplay` 展示；`wecom_send` 自定义正文的第一行用作标题，重要结论应放在开头

确定尚未发送的结果和完成通知会在断线恢复后补发；已被服务端拒绝或发送结果未知时，不自动重复发送。`inline` 卡片明确被拒收时，任务结果和通知会改发 Markdown 正文；`linked` 不回退：文档失败在卡片引用区提示原因，卡片本身无法生成或被拒收则报告发送失败，不另发正文。断开或退出当前 pi 会清除待发通知

### pi 状态栏

首次连接成功后，底部显示 `wecom-aibot`：默认主题下绿色表示正常，黄色表示正在重连，红色表示需处理；自定义主题颜色可能不同。首次连接未就绪前不显示，断开后隐藏

出现「待重新接入」说明接入配置已变更，需要运行 `/wecom-aibot connect`。详细原因用 `status` 或 `log` 查看；RPC、JSON、print 模式不显示状态栏

## 📝 配置文件

用 `/wecom-aibot config` 打开菜单，或直接执行：

```text
/wecom-aibot config show                                  # 查看合并结果及每项来源
/wecom-aibot config edit                                  # 交互编辑全局配置
/wecom-aibot config --scope project set defaultChatId=your-group-chatid defaultChatType=2
/wecom-aibot config --scope session set controlPrompts=继续,运行测试
/wecom-aibot config set controlPrompts+=部署到测试环境
/wecom-aibot config set controlPrompts-=运行测试
/wecom-aibot config --scope session unset controlPrompts   # 删除覆盖，恢复继承
/wecom-aibot config --scope global whoami                  # 识别并保存默认推送目标
```

### 作用域与位置

优先级：**内置默认值 < 全局 < 项目 < session**

| 作用域 | 适用范围 | 配置文件 |
| :--- | :--- | :--- |
| `global` | 同一系统用户下的所有 pi | `config.json` |
| `project` | 启动 pi 的目录，同目录会话共用 | `projects/<目录编码>.json`，如 `--home-me-repo--.json` |
| `session` | 当前会话 | `sessions/<session ID>.json` |

这些文件都在插件目录下，不在项目仓库内，以免误提交凭据：

- Linux / macOS：`~/.pi/agent/wecom-aibot/`
- Windows：`C:\Users\你的用户名\.pi\agent\wecom-aibot\`

实际位置以 `/wecom-aibot status` 为准，随 `PI_CODING_AGENT_DIR` 移动。项目和 session 只保存显式覆盖的字段；分叉会话首次启动时复制父会话的覆盖，之后各自独立

- `--scope` 写在动作前。不写时：`edit`、`set`、`unset` 改全局，`show` 显示合并结果，`whoami` 只识别不保存目标；指定作用域后，只查看或修改那一层
- `set` 支持一次修改多个字段，全部校验通过才保存。`unset` 删除本层设置，恢复继承值
- BotID 与 Secret、默认目标与类型各自成组，不能跨层拼接
- BotID、Secret、`docMcpUrl` 只能通过 `edit` 或直接编辑文件填写，不能用会留在输入历史里的 `set`。没有交互界面时请直接编辑文件

### 全局配置示例

```json
{
  "$schema": "https://raw.githubusercontent.com/cobia68/pi-wecom-aibot/main/config.schema.json",
  "botId": "your-bot-id",
  "secret": "your-secret",
  "defaultChatId": "your-userid",
  "defaultChatType": 1,
  "notificationScope": "wecom-tasks",
  "allowedUserIds": ["your-userid"]
}
```

`$schema` 用于编辑器补全和校验；实际是否可用以 `config show` 为准

| 字段 | 含义 |
| :--- | :--- |
| `botId` / `secret` | 机器人凭据 |
| `defaultChatId` / `defaultChatType` | 默认目标：userid + `1` 单聊，群 chatid + `2` 群聊；省略类型时为单聊 |
| `notificationScope` | `wecom-tasks`（默认）只自动回传企微任务；`all-runs` 也通知本地运行结果 |
| `contentDisplay` | `inline`（默认）显示摘要；`linked` 仅使用[会话文档](#会话文档)，不可用时在引用区提示原因，不回退正文 |
| `controlPrompts` | 「发提示词」候选，默认空，最多 10 条、每条最多 500 字 |
| `docMcpUrl` | 会话文档的 streamableHTTP URL，仅限全局，含密钥 |
| `allowedUserIds` | 用户白名单，仅限全局；不写或留空表示不限制 |

`controlPrompts` 用英文逗号分隔，`=` 替换整份，`+=` 追加，`-=` 按原文删除。含空格或英文逗号的提示词用 `edit` 一行一条填写。项目或 session 首次用 `+=`、`-=` 时会复制继承来的列表，此后不再跟随上层变化，`unset` 后恢复继承

### 修改何时生效

- `notificationScope`、`contentDisplay`、`controlPrompts`、`docMcpUrl`：下次使用时生效，无需重连；已经生成的待发通知保留原快照
- 凭据、默认目标、白名单：**各窗口重新 `connect` 后生效**，此前继续用旧配置。切换会清除当前接入的排队任务和待发通知；已开始的任务继续运行，但结果不再回传。没有交互界面且有待处理工作时拒绝切换
- 未知字段或无效值会报错，不会静默忽略；已接入的会话继续使用上一次有效配置

Secret 以明文保存，编辑时也会显示在屏幕上，请勿分享或提交到仓库。删除 pi 会话或项目目录不会清理其覆盖文件，不需要时手动删除 `sessions/`、`projects/` 中的对应文件

## 🧰 命令速查

### 企业微信

| 完整命令 | 缩写 | 作用 |
| :--- | :--- | :--- |
| `/wecom-aibot sessions` | `/wa s` | 打开在线会话卡 |
| `/wecom-aibot --help` | `/wa -h` | 显示全部用法 |

不能只发命令前缀，必须指定子命令或帮助选项。前缀、子命令和帮助选项可分别缩写，也可混用，例如 `/wa sessions`、`/wecom-aibot -h`；全部区分大小写。`sessions` 不接受任何后续参数，不再支持 `sessions --help`；多余参数会报错，不执行也不转交模型

### pi 终端

以下命令在 **pi 终端**执行，不支持上述企微缩写；命令、选项、字段名和取值均区分大小写

| 命令 | 作用 |
| :--- | :--- |
| `/wecom-aibot` | 打开子命令菜单 |
| `/wecom-aibot status` | 查看连接状态、默认目标和配置位置 |
| `/wecom-aibot config` | 查看、编辑配置或识别聊天，详见上节 |
| `/wecom-aibot connect` | 接入当前会话，或确认切换接入配置 |
| `/wecom-aibot disconnect` | 断开当前会话，不影响其他 pi |
| `/wecom-aibot test` | 向默认目标发部署测试卡 |
| `/wecom-aibot log` | 查看最近 20 条日志 |
| `/wecom-aibot reset` | 确认后删除全局配置和本机登记的文档页，断开当前会话 |
| `/wecom-aibot --help` | 查看完整用法；配置帮助用 `config --help` |

`disconnect` 不修改配置，会取消当前会话的排队任务和待发通知；已开始的任务继续在电脑上运行，但不再回传结果

`reset` 需要交互确认，**不会删除项目级和 session 覆盖，也不会停止其他已接入的 pi**。文档本身需手动删除；若提示删除失败，检查文件权限后重试，凭据可能仍在磁盘

## 🔄 升级与卸载

### 升级

```bash
pi update npm:@cobia/pi-wecom-aibot
```

更新后关闭所有使用这个机器人的 pi 窗口，等共享网关退出，再重新打开并逐个 `connect`。仅 `/reload` 无法替换已运行的网关。0.4.0 的文档专用投递使用新版网关协议，不能与旧版本混用。**从 0.4.0 起，`linked` 不再回退正文**；需要卡片正文摘要，请显式切换为 `inline`

用 `pi install npm:@cobia/pi-wecom-aibot@版本号` 固定版本后，`pi update` 不会更新它；换版本需重新 `install`。旧配置、命令和卡片不自动迁移：遇到未知字段按 `config --help` 调整，旧卡失效时重新 `connect` 或在企微发 `/wa s` 打开新卡

### 卸载

1. 在 pi 执行 `/wecom-aibot reset`；其他已接入窗口也要断开。若项目或 session 中存过凭据，清理插件目录的 `projects/`、`sessions/`
2. 执行 `pi remove npm:@cobia/pi-wecom-aibot`
3. 按需清理项目中的 `.pi-wecom-aibot-files/`、插件目录中的 `gateway/` 和 `session-doc.json`；在企业微信撤销「文档」授权并删除会话文档

## ❓ 常见问题

**发消息没有反应？**

用 `status` 确认当前会话已接入，再检查群聊是否 @机器人、发送者是否在白名单。普通消息需要在选择卡上确认。用 `log` 查看错误；`gateway launch failed` 或 `gateway process exited` 时检查 Node.js 是否在 PATH 中、插件是否安装完整

**提示连接被其他机器或旧客户端接管？**

同一机器人只能在一处连接。关闭另一台电脑或另一系统用户下的连接，再执行 `connect`

**凭据错误，或改了配置仍不生效？**

用 `config show` 查看生效值及其来源，在对应作用域执行 `config edit`。确认机器人仍是「API 模式」＋「长连接」，然后在各窗口重新 `connect`

**收不到主动推送？**

确认对方先给机器人发过消息，用 `config --scope global whoami` 设置默认目标并重新 `connect`。企业微信限制每个聊天每分钟 30 条、每小时 1000 条消息，卡片更新也计入；具体原因看 `log`

**日志里经常出现 WebSocket closed？**

网关会自动重连，超过 30 秒未恢复会提醒。`1006` 只表示异常断开，无法据此判断是服务端还是网络问题。接收任务和卡片点击需要保持长连接，要暂停请用 `disconnect`
