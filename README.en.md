# Feishu Thread Bridge

[中文](README.md)

Self-hosted bridge for sending Feishu messages into local Codex threads.

Project scope is direct:
- Frontend: Feishu
- Backend: local Codex
- Runtime shape: one `gateway` + one or more local `agent`s
- Primary environment: Windows

No GUI automation is used.
No public Feishu HTTP callback is required.
Feishu events are received through the Feishu WebSocket client.

---

## 1. What This Project Is

Feishu Thread Bridge sends Feishu messages into local Codex threads.

It lets you:
- continue an existing local Codex thread from Feishu
- create a new Codex thread from Feishu
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
with only your phone, you can send the idea to Codex running on the computer at home or in the office and start the session immediately, without waiting until you are back at the keyboard.

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

Current backend:
- Codex only

## 5. Not Supported

Not supported:
- voice messages
- speech-to-text
- Telegram / Discord / WeCom
- standalone Web UI
- non-Codex agent backends

## 6. Known Limits

These are current facts:

- The project supports Feishu + Codex only.
- Feishu voice messages do not work.
- A conversation created from Feishu does not appear in Codex Desktop immediately.
- You must restart Codex Desktop to see a newly created Feishu conversation there.
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
- talks to local Codex
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
- Windows
- Node.js 20+
- npm
- a Feishu bot app
- local Codex installed on the same machine as `agent`

## 9. Installation

Install dependencies:

```powershell
npm install
```

The project includes a Windows installer script that tries to copy the official Codex executable during `postinstall`.
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

### 8.1 gateway.json

Fields:
- `host`: bind host for the gateway HTTP server
- `port`: gateway HTTP port
- `baseUrl`: base URL used by the agent to download attachments
- `dataDir`: gateway data directory
- `devices`: allowed agent devices and tokens
- `feishu`: Feishu app config

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

### 8.2 agent.json

Fields:
- `deviceId`: must match a device configured in `gateway.json`
- `deviceName`: display name shown by the gateway
- `deviceToken`: must match the token configured in `gateway.json`
- `gatewayUrl`: gateway URL
- `dataDir`: agent data directory
- `maxQueuedJobs`: max queued jobs on this device
- `workspaces`: allowed workspace list

`codexPath` can be omitted. If omitted, the program uses the managed Codex executable under the current user's home directory.

Minimal example:

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

Start in this order:

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
- `npm run dev:gateway`
- `npm run dev:agent`

## 13. First-Time Check

After both processes are running, verify in this order:

1. Open the bot chat in Feishu.
2. Send `/workspaces`.
3. Send `/threads <workspaceId> 1`.
4. Send `/use <threadId>`.
5. Send a normal text message.
6. Send `/history 1`.

If image support matters to you, test images explicitly.
Do not assume image support is working just because text support is working.

## 14. Command Reference

### `/help`
Show command help.

### `/dashboard`
Show dashboard text or card view.

### `/workspaces`
List configured workspaces on the current online device.

### `/threads <workspaceId> [count]`
List recent threads in a workspace.

Rules:
- `/threads` without `workspaceId` prints usage help only.
- default count is 4.
- max count is 20.
- each thread reply starts with `/use <threadId>`.

Example:

```text
/threads dev-claw 1
```

### `/use <threadId>`
Switch the current target thread.

The success reply keeps the thread title only and does not repeat the thread ID at the end.

### `/new <workspaceId>`
Enter new-thread mode.
The next normal text message creates a new Codex thread in that workspace.

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
- message header: `[user MM-DD HH:mm]` or `[assistant MM-DD HH:mm]`

### `/ls [path]`
List files under the current workspace target path.

### `/open <path>`
Read a file from the current workspace target path.
If the file is binary, the bridge sends it back to Feishu as an image or file.

### `/cancel`
Cancel the running job on the current thread.

## 15. Images, Files, and Voice

### Images
Supported.
User-sent images are downloaded by the gateway and passed to Codex as local images.

### Files
Supported.
User-sent files are downloaded by the gateway and passed through the attachment pipeline.

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
