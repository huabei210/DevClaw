# Feishu Thread Bridge

[中文](README.md)


## 1. What This Project Is

Feishu Thread Bridge sends Feishu messages into local AI assistant threads.

It lets you:
- continue an existing local Codex / Claude thread from Feishu
- create a new local Codex / Claude thread from Feishu
- read recent thread history
- send text, images, and files into the current thread
- browse workspace files from Feishu

It is not:
- a generic messaging platform
- GUI automation
- a replacement for Codex Desktop

## 2. Why This Project Exists

For many developers, OpenClaw is too heavy.
Most of the time, what we actually need is not a large platform, but a lightweight way to operate the AI coding tool on our computer from a phone.

The real-world situations are simple:
- the computer is at home, but you are not
- you are outside eating, traveling, or commuting, and an idea suddenly appears
- you are with friends or family, and opening a laptop to start working on the spot is not appropriate
- you are in fragmented time such as childcare, waiting in line, a short break, or even sitting in the bathroom, and you want to start immediately

At that moment, the problem is not whether the idea is worth coding.
The problem is whether you can start it right now.

This project solves exactly that:
with only your phone, you can send the idea to Codex or Claude running on the computer at home or in the office and start the session immediately, without waiting until you are back at the keyboard.

## 3. Why It Is Called DevClaw

`DevClaw` can be read as “the developer's claw”.

The meaning is direct:
- it is an extension of the developer's hands
- it lets you reach back to your computer from anywhere
- you may not be sitting in front of the keyboard, but you can still start coding immediately

## 4. Current Support

Supported input types:
- text
- image
- file

Supported commands:
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

Notes:
- the real commands are `/workspaces` and `/threads`
- there are no singular `/workspace` or `/thread` commands

Current backend:
- Codex
- Claude

## 5. Not Supported

Not supported:
- voice messages
- speech-to-text
- Telegram / Discord / WeCom
- standalone Web UI
- other agent backends that are not integrated yet

## 6. Known Limits

These are current facts:

- The project supports Feishu + local Codex / Claude.
- Feishu voice messages do not work.
- A Codex conversation created from Feishu does not appear in Codex Desktop immediately.
- You must restart Codex Desktop to see a newly created Feishu Codex conversation there.
- The bridge can continue using that conversation from Feishu before the desktop client sees it.

## 7. Architecture

There are two processes.

### gateway
- receives Feishu events
- stores conversation state
- stores uploaded attachments
- sends commands to agents over WebSocket
- sends replies back to Feishu

### agent
- runs on the local machine
- exposes local workspaces to the bridge
- talks to local Codex / Claude
- lists threads, opens history, creates threads, continues threads
- reads files and directories inside allowed workspaces

Message flow:
1. A user sends a message in Feishu.
2. `gateway` receives the event.
3. `gateway` resolves the current target thread.
4. `gateway` sends a command to `agent`.
5. `agent` calls Codex.
6. Output and state changes go back to `gateway`.
7. `gateway` sends the result back to Feishu.

## 8. Requirements

Recommended environment:
- Windows / macOS
- Node.js 20+
- npm
- a Feishu bot app
- local Codex / Claude available on the same machine as `agent`, from desktop app, CLI, or VS Code / Cursor style plugins

Platform compatibility:
- Windows + Codex: official desktop app, `codex` CLI / npm shim, built-in binaries from VS Code / Cursor / Windsurf plugins
- Windows + Claude: `claude` CLI, built-in binaries from VS Code / Cursor / Windsurf Claude Code plugins
- macOS + Codex: `Codex.app`, `codex` CLI, built-in binaries from VS Code / Cursor / Windsurf plugins
- macOS + Claude: `Claude.app`, `claude` CLI, built-in binaries from VS Code / Cursor / Windsurf Claude Code plugins

## 9. Installation

Install dependencies:

```powershell
npm install
```

The project includes a Windows installer script that tries to copy the official Codex executable during `postinstall`.
On macOS the bridge does not depend on that installer; it directly detects local Codex / Claude CLI, app, or plugin binaries.
If you enable Claude, the machine also needs a working `claude` command and a local `~/.claude/projects` session directory.
In most setups, you should leave `codexPath` and `claudePath` out of `agent.json` and let the bridge auto-detect them.
You can also run it manually:

```powershell
npm run install:codex
```

## 10. Configuration

Default config files:
- `config/gateway.json`
- `config/agent.json`

Optional environment overrides:
- `FTB_GATEWAY_CONFIG`
- `FTB_AGENT_CONFIG`

Recommended config strategy:
- if you use the default desktop app, CLI, or VS Code / Cursor / Windsurf plugin install, you usually do not need to set `codexPath` or `claudePath`
- only set explicit absolute paths when you installed the executable in a custom location
- `workspaces[].assistants` decides which assistants are included in `/threads <workspaceId>`

### 10.1 gateway.json

Fields:
- `host`: bind host for the gateway HTTP server
- `port`: gateway HTTP port
- `baseUrl`: base URL used by the agent to download attachments
- `dataDir`: gateway data directory
- `devices`: allowed agent devices and tokens
- `feishu.enabled`: whether Feishu is enabled
- `feishu.interactiveCardsEnabled`: whether interactive Feishu cards are enabled
- `feishu.appId`: Feishu app ID
- `feishu.appSecret`: Feishu app secret
- `feishu.encryptKey`: event encryption key, can be empty
- `feishu.verificationToken`: event verification token, can be empty
- `feishu.allowChatIds`: allowed chat ID whitelist, can be empty
- `feishu.notificationChatIds`: notification chat ID list, can be empty

Minimal example:

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

Fields:
- `deviceId`: must match a device configured in `gateway.json`
- `deviceName`: display name shown by the gateway
- `deviceToken`: must match the token configured in `gateway.json`
- `gatewayUrl`: gateway URL
- `dataDir`: agent data directory
- `maxQueuedJobs`: max queued jobs on this device
- `codexPath`: optional Codex executable or command
- `claudePath`: optional Claude CLI executable or command, defaults to `claude`
- `codexAppServerUrl`: optional remote Codex app-server `ws://` / `wss://` URL
- `codexAppServerReuseScope`: optional, `workspace` or `global`, defaults to `workspace`
- `workspaces`: allowed workspace list

`codexPath` can be omitted. If omitted, the program starts from the bare `codex` command and auto-detects in this order:
- official Codex Desktop
- `Codex.app` on macOS
- editor-bundled Codex binaries from VS Code / Cursor / Windsurf style installs
- `codex` CLI / npm shim from the system PATH

When official Codex Desktop is detected, the bridge still prefers copying it into the managed local cache before launch.
`claudePath` can be omitted. If omitted, the program directly invokes `claude` and auto-detects the local Claude CLI / app / plugin binary for the current platform.

Where session lists come from:
- `Codex` sessions are read from the local Codex app-server or `~/.codex` session data
- `Claude` sessions are read from the local `~/.claude/projects`
- so `/threads <workspaceId>` does not list only one assistant; it lists all enabled assistants for that workspace

Codex compatibility includes:
- the official desktop installation path
- `Codex.app` on macOS
- the `codex` CLI / npm shim
- editor-bundled Codex binaries from VS Code / Cursor / Windsurf style installs

Claude compatibility includes:
- the local `claude` CLI
- `Claude.app` on macOS
- editor-bundled Claude Code binaries from VS Code / Cursor / Windsurf style installs
- the local `~/.claude/projects` session store

Minimal example:

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

## 11. Feishu Setup

Your Feishu app must at least have:
- bot ability enabled
- event subscription `im.message.receive_v1`
- permission to receive messages sent to the bot
- permission to send text messages
- permission to send image messages
- permission to send file messages
- permission to download message resource files, including user-sent images and files

Operational requirements:
- the bot must already be in the target chat
- image and file handling depends on message resource download working correctly

## 12. Start Order

For development, the recommended way is to start both together:

```powershell
npm run dev
```

If you prefer separate logs, you can still start them in this order:

```powershell
npm run dev:gateway
```

```powershell
npm run dev:agent
```

Production mode:

```powershell
npm run build
npm run start:gateway
npm run start:agent
```

Current development scripts already run in watch mode:
- `npm run dev`
- `npm run dev:gateway`
- `npm run dev:agent`

The watch configuration now explicitly includes the related source directories:
- `gateway` watches `src/gateway` and `src/shared`
- `agent` watches `src/agent`, `src/adapters`, and `src/shared`

So changes in dependency files, not only the entry files, also trigger automatic restarts.

## 13. First-Time Check

After both processes are running, verify in this order:

1. Open the bot chat in Feishu.
2. Send `/workspaces`.
3. Send `/threads <workspaceId> 1` or `/threads <workspaceId> claude 1`.
4. Send `/use <threadId>`.
5. Send a normal text message.
6. Send `/history 1`.

If image support matters to you, test images explicitly.
Do not assume image support is working just because text support is working.

If one workspace enables both `codex` and `claude`, step 3 returns a merged recent-session list for both assistants, sorted by update time.

## 14. Command Reference

### `/help`
Show command help.

### `/dashboard`
Show dashboard text or card view.
It summarizes the current target, the workspace list, and thread shortcuts.

### `/target`
Show the current target:
- current device
- current workspace
- current assistant
- current thread

### `/workspaces`
List configured workspaces on the current online device.

The output tells you:
- the `workspaceId`
- the workspace name
- which assistants are enabled in that workspace
- which `/threads <workspaceId>` command to send next

### `/threads`
List recent threads in a workspace.

Rules:
- `/threads` without `workspaceId` prints usage help only.
- default count is 4.
- `count` can be any positive integer; if you request 40, the bridge returns up to 40 items, or all items when fewer than 40 exist.
- each thread reply starts with `/use <threadId>`.
- if the workspace enables both `codex` and `claude`, the result includes both assistants and sorts them by most recent update time
- you can also explicitly filter by assistant and show only `codex` or only `claude`
- you can also append a keyword and filter by thread title containing that keyword

Supported forms:

```text
/threads <workspaceId>
/threads <workspaceId> <count>
/threads <workspaceId> <keyword>
/threads <workspaceId> <assistantKind>
/threads <workspaceId> <assistantKind> <count>
/threads <workspaceId> <assistantKind> <keyword>
/threads <workspaceId> <assistantKind> <count> <keyword>
```

Example:

```text
/threads dev-claw 1
/threads repo migration
/threads repo claude
/threads repo claude 20
/threads repo claude migration
/threads repo claude 20 migration
/threads dev-claw 20
```

If you want to see almost all recent sessions for one workspace, use:

```text
/threads <workspaceId> 40
```

If you want to see only Claude sessions for one project, use:

```text
/threads <workspaceId> claude
/threads <workspaceId> claude 40
/threads <workspaceId> claude migration
/threads <workspaceId> claude 40 migration
```

For Codex-only results, replace `claude` with `codex`.

### `/use <threadId>`
Switch the current target thread.

The success reply keeps the thread title only and does not repeat the thread ID at the end.

### `/new <workspaceId> [assistantKind]`
Enter new-thread mode.
The next normal text message creates a new thread in that workspace.
Without `assistantKind`, the workspace `defaultAssistant` is used.

Example:

```text
/new dev-claw
/new dev-claw claude
```

### `/history`
Show the full history for the current target thread.
If one Feishu message is not large enough, the bridge splits the output into multiple messages instead of truncating the body.

### `/history [count]`
Show recent history for the current target thread.
Here `count` means recent question-answer pairs, but each message body is still shown in full; long output is split across multiple messages instead of truncated.

### `/history s`
Show a compact preview for the current target thread.
It covers the full history range, but keeps only the first 30 characters of each user and assistant message.

### `/history <threadId> [count] [s]`
Switch to the target thread and show its history.

Rules:
- `count` means recent question-answer pairs
- `/history 1` means 1 user turn + 1 assistant turn
- `/history 2` means 2 user turns + 2 assistant turns
- without `count`, the bridge shows the full history
- with `s`, the bridge uses compact preview mode
- if `count` is larger than available history, the bridge prints everything it has
- if the output is too long, the bridge sends multiple Feishu messages instead of truncating the body

Output format:
- title line: `标题: ...`
- message header: `[user MM-DD HH:mm:ss]` or `[assistant MM-DD HH:mm:ss]`

### `/status`
Show the current session status.

Current output includes:
- current target device / workspace / assistant / thread
- current thread status
- message count and exchange count
- context text size (`chars` / UTF-8 bytes / rough token estimate)
- preview of the latest user and assistant messages

### `/compact`
Create a new compacted thread from the current target thread and switch to it automatically when ready.

Current behavior:
- the bridge reads the current thread history
- the bridge builds a local handoff-style compact prompt
- it creates a new thread with the same workspace + assistant
- once that new thread is created, it becomes the current target

The old thread is kept and you can switch back with `/use <threadId>`.

### `/ls [path]`
List files under the current workspace target path.

### `/open <path>`
Read a file from the current workspace target path.
If the file is binary, the bridge sends it back to Feishu as an image or file.

### `/cancel`
Cancel the job on the current thread.
- If the job is still queued, it is removed from the queue
- If the job is already running, the bridge sends a stop signal to the current assistant process and tries to terminate its child-process tree

### `/stop`
Compatibility alias for `/cancel`.
Its behavior is exactly the same as `/cancel`, including trying to stop the active child process instead of only cancelling queued work.

## 15. Images, Files, and Voice

### Images
Supported.
User-sent images are downloaded by the gateway and passed through the assistant-specific attachment path.

### Files
Supported.
User-sent files are downloaded by the gateway and passed through the attachment pipeline for the current assistant.

### Voice
Not supported.
If you need voice, add a separate speech-to-text path.

## 16. Codex Desktop Behavior

Current behavior:
- A thread created from Feishu can continue inside Feishu.
- Codex Desktop does not show that new thread immediately.
- If you want to see it in Codex Desktop, restart Codex Desktop.

Do not describe this as real-time sync. It is not.

## 17. Progress Messages During Local Command Execution

When Codex runs a local command, the gateway forwards short progress messages to Feishu.

Current rule:
- only the command start phase is forwarded
- the text is `已运行 ` + the first 10 characters of the command preview
- no separate completion progress line is sent when the command finishes

This is to reduce message spam.

## 18. Data Directories

Common runtime directories:
- `data/gateway/attachments`
- `data/gateway/incoming`
- `data/gateway/state.json`
- `data/agent`

## 19. Repository Layout

```text
config/          example and actual config files
scripts/         install and utility scripts
src/gateway/     Feishu-facing gateway
src/agent/       local agent
src/adapters/    Codex adapter layer
src/shared/      shared types, config, and utils
data/            runtime data
```

## 20. Security Boundaries

Current hard boundaries:
- the agent can access only configured workspaces
- file browsing and file open stay inside those workspaces
- the agent must send the device token when downloading attachments from the gateway

This does not make the system inherently safe.
If you connect the bot to a machine, you are exposing the configured workspace access on that machine to anyone allowed to use the bot.

## 21. Troubleshooting

### Text works, image does not
Check in this order:
- can the Feishu bot receive image messages
- can the Feishu app download message resources
- does the `gateway` log show an incoming `image` event
- does `data/gateway/attachments` contain a new file
- is the current target thread selected before sending the image

### `/threads` works but `/use` does not
Check:
- the thread ID was copied correctly
- the target device is online
- the thread still belongs to a configured workspace

### `/history 50` looks empty
Current behavior is simple:
- if the thread has history, the bridge prints all existing pairs
- if the thread has no saved history, it prints `暂无聊天记录`
- if one message is not enough, the bridge sends multiple messages

### A Feishu-created thread is missing in Codex Desktop
Current direct answer:
- restart Codex Desktop

## 22. Development

Common commands:

```powershell
npm run typecheck
npm test
npm run build
```

## 23. License

Apache-2.0.
See `LICENSE`.
