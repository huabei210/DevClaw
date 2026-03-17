# Feishu Thread Bridge

[English](README.en.md)

Self-hosted bridge for sending Feishu messages into local AI assistant threads.

## 1. 这是什么

Feishu Thread Bridge 用来把飞书消息转发到本地 AI 编程助手 thread。

它能做的事情：
- 在飞书里继续本地已有的 Codex / Claude thread
- 在飞书里新建 Codex / Claude thread
- 查看最近历史记录
- 向当前 thread 发送文本、图片、文件
- 在飞书里浏览工作区目录和打开文件

它不做这些事情：
- 不做通用聊天平台
- 不做 GUI 自动化
- 不替代 Codex Desktop

## 2. 为什么做这个项目

对很多程序员来说，OpenClaw 太重了。
大多数时候，我们真正需要的不是一整套复杂平台，而是一个可以让手机直接操作电脑上 AI 编程工具的轻量方法。

现实场景很简单：
- 电脑在家，人不在电脑前
- 正在外面吃饭、旅游、通勤，突然有了一个想法
- 和朋友、家人待在一起，当场掏出电脑开始办公并不合适
- 在带娃、排队、短暂休息，甚至蹲坑这种碎片时间里，灵感突然来了

这些时候，问题不是“要不要写代码”，而是“能不能马上把这件事开始掉”。

这个项目解决的就是这个问题：
让你只用手机，就能随时把想法发到家里或办公室那台电脑上的 Codex 或 Claude，会话可以立刻开始，不用等你重新坐回电脑前。

## 3. 为什么叫 DevClaw

`DevClaw` 可以理解成“开发者的爪子”。

这个名字表达的意思很直接：
- 它是开发者双手的延伸
- 它让你在任何地方，都能把手伸到电脑前开始写代码
- 你不一定坐在键盘前，但你依然可以立刻启动开发流程

## 4. 当前支持什么

当前支持的输入类型：
- 文本
- 图片
- 文件

当前支持的命令：
- `/help`
- `/dashboard`
- `/target`
- `/workspaces`
- `/threads <workspaceId> [count]`
- `/threads <workspaceId> <keyword>`
- `/threads <workspaceId> <assistantKind>`
- `/threads <workspaceId> <assistantKind> [count]`
- `/threads <workspaceId> <assistantKind> [count] <keyword>`
- `/use <threadId>`
- `/new <workspaceId> [assistantKind]`
- `/history`
- `/history [count]`
- `/history s`
- `/history <threadId> [count] [s]`
- `/status`
- `/compact`
- `/ls [path]`
- `/open <path>`
- `/cancel`
- `/stop`

注意：
- 实际命令是 `/workspaces` 和 `/threads`
- 没有 `/workspace` 或 `/thread` 这两个单数命令

当前后端：
- Codex
- Claude

## 5. 当前不支持什么

当前不支持：
- 语音消息
- 语音转文字
- Telegram / Discord / 企业微信
- 独立 Web UI
- 其他尚未接入的 Agent 后端

## 6. 当前缺陷 / 已知限制

下面这些都是当前事实，不是模糊描述：

- 项目当前支持 飞书 + 本地 Codex / Claude。
- 飞书语音消息不能用。
- 从飞书新建的 Codex 会话，不会立刻出现在 Codex Desktop 里。
- 如果你要在 Codex Desktop 里看到这个新会话，必须重启 Codex Desktop。
- 在重启桌面客户端之前，这个会话仍然可以继续在飞书里使用。

## 7. 架构

系统里有两个进程。

### gateway
- 接收飞书事件
- 保存会话状态
- 保存上传的附件
- 通过 WebSocket 向 agent 发送命令
- 把结果回发到飞书

### agent
- 运行在本地机器上
- 向 bridge 暴露本地工作区
- 调用本地 Codex / Claude
- 列出 thread、打开历史、新建 thread、继续 thread
- 在允许的工作区内读取目录和文件

消息链路：
1. 用户在飞书里发送消息。
2. `gateway` 收到事件。
3. `gateway` 解析当前目标 thread。
4. `gateway` 向 `agent` 发送命令。
5. `agent` 调用 Codex。
6. 输出和状态变化回传给 `gateway`。
7. `gateway` 把结果发回飞书。

## 8. 运行要求

推荐环境：
- Windows / macOS
- Node.js 20+
- npm
- 一个飞书机器人应用
- 与 `agent` 同机安装的本地 Codex / Claude，可来自桌面版、CLI 或 VS Code / Cursor 等插件

平台兼容范围：
- Windows + Codex：官方桌面版、`codex` CLI / npm shim、VS Code / Cursor / Windsurf 插件内置二进制
- Windows + Claude：`claude` CLI、VS Code / Cursor / Windsurf 的 Claude Code 插件内置二进制
- macOS + Codex：`Codex.app`、`codex` CLI、VS Code / Cursor / Windsurf 插件内置二进制
- macOS + Claude：`Claude.app`、`claude` CLI、VS Code / Cursor / Windsurf 的 Claude Code 插件内置二进制

## 9. 安装

安装依赖：

```powershell
npm install
```

项目包含一个 Windows 安装脚本，会在 `postinstall` 阶段尝试复制官方 Codex 可执行文件。
在 macOS 上不依赖这个安装脚本，bridge 会直接探测本机的 Codex / Claude CLI、App 或插件二进制。
如果你启用 Claude，还需要本机可直接执行 `claude` 命令，并且本地存在 `~/.claude/projects` 会话目录。
大多数场景下，`agent.json` 里的 `codexPath` 和 `claudePath` 建议直接省略，让 bridge 自动探测。
你也可以手动执行：

```powershell
npm run install:codex
```

## 10. 配置

默认配置文件路径：
- `config/gateway.json`
- `config/agent.json`

也支持环境变量覆盖：
- `FTB_GATEWAY_CONFIG`
- `FTB_AGENT_CONFIG`

推荐配置原则：
- 如果你装的是官方默认位置、CLI、或 VS Code / Cursor / Windsurf 插件，通常不用手填 `codexPath` / `claudePath`
- 只有在你把可执行文件装到自定义位置时，才建议显式填写绝对路径
- `workspaces[].assistants` 决定 `/threads <workspaceId>` 会列出哪些 assistant 的会话

### 10.1 gateway.json

字段说明：
- `host`：gateway HTTP 服务监听地址
- `port`：gateway HTTP 端口
- `baseUrl`：agent 下载附件时使用的 gateway 地址
- `dataDir`：gateway 数据目录
- `devices`：允许连接的 agent 设备和 token
- `feishu.enabled`：是否启用飞书
- `feishu.interactiveCardsEnabled`：是否启用飞书卡片
- `feishu.appId`：飞书应用 App ID
- `feishu.appSecret`：飞书应用 App Secret
- `feishu.encryptKey`：事件加密 Key，没有可留空
- `feishu.verificationToken`：事件校验 token，没有可留空
- `feishu.allowChatIds`：允许访问的会话 ID 白名单，可留空
- `feishu.notificationChatIds`：接收通知的会话 ID 列表，可留空

最小示例：

```json
{
  "host": "0.0.0.0",
  "port": 8787,
  "baseUrl": "http://127.0.0.1:8787",
  "dataDir": "./data/gateway",
  "devices": [
    {
      "id": "devbox-01",
      "name": "MyWinPC",
      "token": "123456"
    }
  ],
  "feishu": {
    "enabled": true,
    "appId": "your_app_id",
    "appSecret": "your_app_secret"
  }
}
```

### 10.2 agent.json

字段说明：
- `deviceId`：必须和 `gateway.json` 里的设备 ID 对应
- `deviceName`：gateway 展示用设备名
- `deviceToken`：必须和 `gateway.json` 里的 token 对应
- `gatewayUrl`：gateway 地址
- `dataDir`：agent 数据目录
- `maxQueuedJobs`：本机最大排队任务数
- `codexPath`：可选，Codex 可执行文件或命令
- `claudePath`：可选，Claude CLI 可执行文件或命令，默认 `claude`
- `codexAppServerUrl`：可选，远端 Codex app-server 的 `ws://` / `wss://` 地址
- `codexAppServerReuseScope`：可选，`workspace` 或 `global`，默认 `workspace`
- `workspaces`：允许暴露的工作区列表

`codexPath` 可以省略。省略时，程序默认使用 `codex` 命令，并按这个优先级自动探测：
- 官方 Codex Desktop
- macOS `Codex.app`
- VS Code / Cursor / Windsurf 等编辑器内置的 Codex 二进制
- 系统 PATH 里的 `codex` CLI / npm shim

如果探测到官方 Codex Desktop，bridge 仍会优先复制到本地托管路径后再启动。
`claudePath` 可以省略。省略时，程序默认直接调用 `claude`，并按当前平台自动探测 Claude CLI / App / 插件二进制。

会话来源说明：
- `Codex` 的会话列表来自本机 Codex app-server 或 `~/.codex` 会话数据
- `Claude` 的会话列表来自本机 `~/.claude/projects`
- 也就是说，`/threads <workspaceId>` 不是只列当前 assistant，而是会列这个工作区里已启用 assistant 的全部会话

Codex 兼容范围：
- 官方桌面版安装路径
- macOS `Codex.app`
- `codex` CLI / npm shim
- VS Code / Cursor / Windsurf 等编辑器内置的 Codex 可执行文件

Claude 兼容范围：
- 本机 `claude` CLI
- macOS `Claude.app`
- VS Code / Cursor / Windsurf 等编辑器内置的 Claude Code 可执行文件
- 本机 `~/.claude/projects` 会话目录

最小示例：

```json
{
  "deviceId": "devbox-01",
  "deviceName": "MyWinPC",
  "deviceToken": "123456",
  "gatewayUrl": "http://127.0.0.1:8787",
  "dataDir": "./data/agent",
  "maxQueuedJobs": 50,
  "claudePath": "claude",
  "workspaces": [
    {
      "id": "dev-claw",
      "name": "dev-claw",
      "rootPath": "D:/dev-claw",
      "assistants": ["codex", "claude"],
      "defaultAssistant": "codex"
    }
  ]
}
```

## 11. 飞书侧需要开通什么

这部分必须写清楚，不要省略。

你的飞书应用至少要具备这些能力：
- 已开启机器人能力
- 已订阅事件 `im.message.receive_v1`
- 可以接收用户发给机器人的消息
- 可以发送文本消息
- 可以发送图片消息
- 可以发送文件消息
- 可以下载消息里的资源文件，包括用户发送的图片和文件

运行条件：
- 机器人必须已经在目标会话里
- 图片和文件链路是否能用，取决于飞书消息资源下载是否正常

## 12. 启动顺序

开发时推荐直接一起启动：

```powershell
npm run dev
```

如果你要分开看日志，也可以按这个顺序分别启动：

```powershell
npm run dev:gateway
```

```powershell
npm run dev:agent
```

生产模式：

```powershell
npm run build
npm run start:gateway
npm run start:agent
```

当前开发脚本已经是 watch 模式：
- `npm run dev`
- `npm run dev:gateway`
- `npm run dev:agent`

当前 watch 会显式监听相关源码目录：
- `gateway` 会监听 `src/gateway` 和 `src/shared`
- `agent` 会监听 `src/agent`、`src/adapters` 和 `src/shared`

所以修改入口文件之外的依赖文件后，也会自动重启。

## 13. 第一次连通性检查

两个进程都启动后，按这个顺序验证：

1. 在飞书里打开机器人会话。
2. 发送 `/workspaces`。
3. 发送 `/threads <workspaceId> 1` 或 `/threads <workspaceId> claude 1`。
4. 发送 `/use <threadId>`。
5. 发送一条普通文本。
6. 发送 `/history 1`。

如果你在意图片能力，就单独测图片。
不要因为文本能通，就默认图片也能通。

如果一个工作区同时启用了 `codex` 和 `claude`，第 3 步返回的是两边合并后的最近会话，按更新时间排序。

## 14. 命令说明

### `/help`
显示命令帮助。

### `/dashboard`
显示 dashboard 文本或卡片视图。
它会汇总当前 target、工作区列表，以及最近 thread 的快捷切换项。

### `/target`
显示当前 target：
- 当前 device
- 当前 workspace
- 当前 assistant
- 当前 thread

### `/workspaces`
列出当前在线设备上配置的工作区。

输出里会告诉你：
- `workspaceId`
- 工作区名称
- 该工作区启用了哪些 assistant
- 查看该工作区会话列表应该发送什么 `/threads <workspaceId>` 命令

### `/threads`
列出某个工作区最近的 thread。

规则：
- `/threads` 不带 `workspaceId` 时，只输出用法说明，不直接列 thread。
- 默认数量是 4。
- `count` 可以填写任意正整数；如果你写 40，就最多返回 40 条；如果实际不足 40 条，就把现有结果全部返回。
- 每条 thread 消息第一行都是 `/use <threadId>`。
- 如果这个工作区同时启用了 `codex` 和 `claude`，返回结果会把两边会话一起列出，并按最近更新时间排序。
- 你也可以显式指定 assistant 过滤，只看 `codex` 或只看 `claude`。
- 你也可以追加关键字，只按标题包含关系筛选结果。

支持写法：

```text
/threads <workspaceId>
/threads <workspaceId> <count>
/threads <workspaceId> <keyword>
/threads <workspaceId> <assistantKind>
/threads <workspaceId> <assistantKind> <count>
/threads <workspaceId> <assistantKind> <keyword>
/threads <workspaceId> <assistantKind> <count> <keyword>
```

示例：

```text
/threads dev-claw 1
/threads repo migration
/threads repo claude
/threads repo claude 20
/threads repo claude migration
/threads repo claude 20 migration
/threads dev-claw 20
```

想看某个工作区下几乎全部近期会话，直接用：

```text
/threads <workspaceId> 40
```

想只看某个项目里的 Claude 会话，直接用：

```text
/threads <workspaceId> claude
/threads <workspaceId> claude 40
/threads <workspaceId> claude migration
/threads <workspaceId> claude 40 migration
```

想只看 Codex，会把 `claude` 改成 `codex`。

### `/use <threadId>`
切换当前目标 thread。

当前成功提示只保留标题，不在末尾重复 thread ID。

### `/new <workspaceId> [assistantKind]`
进入新建 thread 模式。
下一条普通文本会在该工作区中创建一个新的 thread。
不带 `assistantKind` 时，使用工作区的 `defaultAssistant`。

示例：

```text
/new dev-claw
/new dev-claw claude
```

### `/history`
查看当前目标 thread 的全部历史。
如果单条飞书消息放不下，bridge 会自动拆成多条消息发送，不截断正文。

### `/history [count]`
查看当前目标 thread 的最近历史。
这里的 `count` 表示最近多少轮问答，但每条消息正文仍然完整显示；如果过长会拆成多条消息，而不是截断。

### `/history s`
查看当前目标 thread 的简洁预览。
它会覆盖完整历史范围，但用户和 assistant 的正文都只保留前 30 个字符，适合快速扫一遍。

### `/history <threadId> [count] [s]`
切到指定 thread，并查看它的历史。

规则：
- `count` 表示最近多少轮问答
- `/history 1` 表示 1 问 1 答
- `/history 2` 表示 2 问 2 答
- 不带 `count` 时，输出完整历史
- 带 `s` 时，进入简洁预览模式
- 如果 `count` 大于现有历史，bridge 会把已有内容全部输出
- 如果内容太长，bridge 会自动拆成多条飞书消息，不截断正文

输出格式：
- 标题行：`标题: ...`
- 消息头：`[user MM-DD HH:mm:ss]` 或 `[assistant MM-DD HH:mm:ss]`

### `/status`
查看当前会话状态。

当前会输出：
- 当前 target 的 device / workspace / assistant / thread
- 当前 thread 状态
- 消息数、问答轮数
- 上下文文本体积（chars / UTF-8 bytes / 粗略 token 估算）
- 最近一条用户消息和 assistant 消息预览

### `/compact`
为当前 target thread 创建一个新的压缩 thread，并在创建完成后自动切换过去。

当前行为：
- bridge 会读取当前 thread 历史
- bridge 本地生成一个压缩后的 handoff prompt
- 用同一个 workspace + assistant 新建一个 thread
- 新 thread 创建完成后，会自动设为当前 target

旧 thread 不会删除，仍然可以用 `/use <threadId>` 切回去。

### `/ls [path]`
列出当前工作区目标路径下的文件。

### `/open <path>`
读取当前工作区目标路径下的文件。
如果文件是二进制，bridge 会把它作为图片或文件回发到飞书。

### `/cancel`
取消当前 thread 的任务。
- 如果任务还在队列中，会直接移出队列
- 如果任务已经在运行，会向当前 assistant 进程发送停止信号，并尝试终止相关子进程树

### `/stop`
`/cancel` 的兼容别名。
当前行为与 `/cancel` 完全一致，也会尝试真正停止活动子进程，而不只是取消排队。

## 15. 图片、文件、语音

### 图片
支持。
用户从飞书发送的图片会被 gateway 下载，然后作为本地图片传给 Codex。

### 文件
支持。
用户从飞书发送的文件会被 gateway 下载，并走附件链路传给当前 assistant。

### 语音
不支持。
如果你要语音，必须单独补一条语音转文字链路。

## 16. Codex Desktop 的表现

当前行为要写死，不要写成“基本同步”这种废话：
- 从飞书创建的 thread，可以继续在飞书里使用。
- Codex Desktop 不会立刻看到这个新 thread。
- 如果你要在 Codex Desktop 里看到它，重启 Codex Desktop。

这就是当前项目行为。
不要把它写成“实时同步”。它不是。

## 17. 本地命令执行时的进度消息

当 Codex 在本地执行命令时，gateway 会把简短进度消息转发到飞书。

当前规则：
- 只转发命令开始阶段
- 文案是 `已运行 ` + 命令预览前 10 个字符
- 命令完成时，不再单独发一条完成进度消息

这样做是为了避免刷屏。

## 18. 数据目录

运行时常见目录：
- `data/gateway/attachments`
- `data/gateway/incoming`
- `data/gateway/state.json`
- `data/agent`

## 19. 仓库结构

```text
config/          示例配置和实际配置
scripts/         安装脚本和工具脚本
src/gateway/     面向飞书的 gateway
src/agent/       本地 agent
src/adapters/    Codex 适配层
src/shared/      共享类型、配置和工具函数
data/            运行时数据
```

## 20. 安全边界

当前明确的边界：
- agent 只能访问配置里声明的工作区
- 浏览目录和打开文件都限制在这些工作区内
- agent 从 gateway 下载附件时必须带 device token

这不等于系统天然安全。
如果你把机器人接到一台机器上，本质上就是把这台机器里已配置工作区的访问能力暴露给允许使用这个机器人的人。

## 21. 排障

### 文本能用，图片没反应
按这个顺序查：
- 飞书机器人能不能收到图片消息
- 飞书应用能不能下载消息资源
- `gateway` 日志里有没有收到 `image` 事件
- `data/gateway/attachments` 里有没有新增文件
- 发送图片前，当前 target thread 是否已经选中

### `/threads` 能用，但 `/use` 不生效
检查：
- thread ID 是否复制正确
- 对应设备是否在线
- 这个 thread 是否仍然属于某个已配置工作区

### `/history 50` 看起来没内容
当前行为很简单：
- 如果 thread 有历史，就输出它现有的全部轮次
- 如果 thread 没有已保存历史，就输出 `暂无聊天记录`
- 如果单条消息装不下，就自动拆成多条消息发送

### 飞书新建的 thread 在 Codex Desktop 看不到
当前答案也很直接：
- 重启 Codex Desktop

## 22. 开发

常用命令：

```powershell
npm run typecheck
npm test
npm run build
```

## 23. 开源协议

Apache-2.0。
见 `LICENSE`。
