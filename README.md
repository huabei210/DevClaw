# Feishu Thread Bridge

[English](README.en.md)

Self-hosted bridge for sending Feishu messages into local Codex threads.

项目范围很直接：
- 前端：飞书
- 后端：本地 Codex
- 运行形态：一个 `gateway` + 一个或多个本地 `agent`
- 当前主要环境：Windows

不使用 GUI 自动化。
不依赖公网 Feishu HTTP 回调。
飞书事件通过 Feishu WebSocket client 接收。

---

## 1. 这是什么

Feishu Thread Bridge 用来把飞书消息转发到本地 Codex thread。

它能做的事情：
- 在飞书里继续本地已有的 Codex thread
- 在飞书里新建 Codex thread
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
让你只用手机，就能随时把想法发到家里或办公室那台电脑上的 Codex，会话可以立刻开始，不用等你重新坐回电脑前。

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
- `/workspaces`
- `/threads <workspaceId> [count]`
- `/use <threadId>`
- `/new <workspaceId>`
- `/history`
- `/history [count]`
- `/history s`
- `/history <threadId> [count] [s]`
- `/ls [path]`
- `/open <path>`
- `/cancel`

当前后端：
- 只支持 Codex

## 5. 当前不支持什么

当前不支持：
- 语音消息
- 语音转文字
- Telegram / Discord / 企业微信
- 独立 Web UI
- 非 Codex 的其他 Agent 后端

## 6. 当前缺陷 / 已知限制

下面这些都是当前事实，不是模糊描述：

- 项目当前只支持 飞书 + Codex。
- 飞书语音消息不能用。
- 从飞书新建的会话，不会立刻出现在 Codex Desktop 里。
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
- 调用本地 Codex
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
- Windows
- Node.js 20+
- npm
- 一个飞书机器人应用
- 与 `agent` 同机安装的本地 Codex

## 9. 安装

安装依赖：

```powershell
npm install
```

项目包含一个 Windows 安装脚本，会在 `postinstall` 阶段尝试复制官方 Codex 可执行文件。
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

### 8.1 gateway.json

字段说明：
- `host`：gateway HTTP 服务监听地址
- `port`：gateway HTTP 端口
- `baseUrl`：agent 下载附件时使用的 gateway 地址
- `dataDir`：gateway 数据目录
- `devices`：允许连接的 agent 设备和 token
- `feishu`：飞书应用配置

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

### 8.2 agent.json

字段说明：
- `deviceId`：必须和 `gateway.json` 里的设备 ID 对应
- `deviceName`：gateway 展示用设备名
- `deviceToken`：必须和 `gateway.json` 里的 token 对应
- `gatewayUrl`：gateway 地址
- `dataDir`：agent 数据目录
- `maxQueuedJobs`：本机最大排队任务数
- `workspaces`：允许暴露的工作区列表

`codexPath` 可以省略。省略时，程序默认使用当前用户目录下的托管 Codex 可执行文件。

最小示例：

```json
{
  "deviceId": "devbox-01",
  "deviceName": "MyWinPC",
  "deviceToken": "123456",
  "gatewayUrl": "http://127.0.0.1:8787",
  "dataDir": "./data/agent",
  "maxQueuedJobs": 50,
  "workspaces": [
    {
      "id": "dev-claw",
      "name": "dev-claw",
      "rootPath": "D:/dev-claw",
      "assistants": ["codex"],
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

按这个顺序启动：

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
- `npm run dev:gateway`
- `npm run dev:agent`

## 13. 第一次连通性检查

两个进程都启动后，按这个顺序验证：

1. 在飞书里打开机器人会话。
2. 发送 `/workspaces`。
3. 发送 `/threads <workspaceId> 1`。
4. 发送 `/use <threadId>`。
5. 发送一条普通文本。
6. 发送 `/history 1`。

如果你在意图片能力，就单独测图片。
不要因为文本能通，就默认图片也能通。

## 14. 命令说明

### `/help`
显示命令帮助。

### `/dashboard`
显示 dashboard 文本或卡片视图。

### `/workspaces`
列出当前在线设备上配置的工作区。

### `/threads <workspaceId> [count]`
列出某个工作区最近的 thread。

规则：
- `/threads` 不带 `workspaceId` 时，只输出用法说明，不直接列 thread。
- 默认数量是 4。
- 最大数量是 20。
- 每条 thread 消息第一行都是 `/use <threadId>`。

示例：

```text
/threads dev-claw 1
```

### `/use <threadId>`
切换当前目标 thread。

当前成功提示只保留标题，不在末尾重复 thread ID。

### `/new <workspaceId>`
进入新建 thread 模式。
下一条普通文本会在该工作区中创建一个新的 Codex thread。

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
- 消息头：`[user MM-DD HH:mm]` 或 `[assistant MM-DD HH:mm]`

### `/ls [path]`
列出当前工作区目标路径下的文件。

### `/open <path>`
读取当前工作区目标路径下的文件。
如果文件是二进制，bridge 会把它作为图片或文件回发到飞书。

### `/cancel`
取消当前 thread 上正在执行的任务。

## 15. 图片、文件、语音

### 图片
支持。
用户从飞书发送的图片会被 gateway 下载，然后作为本地图片传给 Codex。

### 文件
支持。
用户从飞书发送的文件会被 gateway 下载，并走附件链路传给 Codex。

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
