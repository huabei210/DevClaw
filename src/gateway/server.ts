import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { URL } from "node:url";

import express, { Request, Response } from "express";
import multer from "multer";
import { WebSocketServer, WebSocket, RawData } from "ws";

import { buildDashboardCard, buildDirectoryCard, buildInfoCard, buildThreadDetailCard } from "./cards";
import { FeishuService } from "./feishu";
import { materializeBinaryReadResult, buildReadFilePreviewText } from "./file-preview";
import { GatewayStateStore } from "./state";
import { ResolvedThreadMatch, matchThreadByQuery } from "./thread-matching";
import {
  buildCompactThreadPrompt,
  buildCommandProgressText,
  buildDirectoryText,
  buildSessionStatusText,
  buildThreadDetailText,
  buildThreadListHeader,
  buildThreadShortcutText,
  DEFAULT_THREADS_LIST_LIMIT,
  formatThreadLabel,
  HISTORY_FETCH_PAGE_LIMIT,
  parseHistoryArgs,
  parseThreadsArgs,
  renderHelpText,
  renderTargetText,
  renderThreadsUsageText
} from "./text";
import { loadGatewayConfig } from "../shared/config";
import { makeId, nowIso, safeJsonParse } from "../shared/utils";
import {
  AgentEvent,
  AgentHelloEnvelope,
  AssistantKind,
  AttachmentMeta,
  CommandAction,
  CommandEnvelope,
  ConversationState,
  GatewayConfig,
  ReadFileResult,
  ResponseEnvelope,
  TargetRef,
  TranscriptItem,
  TranscriptPage,
  ThreadSummary,
  WorkspaceConfig
} from "../shared/types";

interface AgentConnection {
  socket: WebSocket;
  deviceId: string;
  deviceName: string;
  workspaces: WorkspaceConfig[];
  capabilities: string[];
  connectedAt: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RequestContext {
  conversationId?: string;
  action: CommandAction;
}

interface ThreadListOptions {
  title: string;
  threads: ResolvedThreadMatch[];
  workspaceId?: string;
  assistantKind?: AssistantKind;
  threadQuery?: string;
  limit?: number;
}

export class GatewayServer {
  private readonly config: GatewayConfig = loadGatewayConfig();
  private readonly app = express();
  private readonly httpServer = http.createServer(this.app);
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private readonly stateStore = new GatewayStateStore(this.config.dataDir);
  private readonly connections = new Map<string, AgentConnection>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly requestContexts = new Map<string, RequestContext>();
  private readonly conversationTasks = new Map<string, Promise<void>>();
  private readonly feishu = new FeishuService(this.config, {
    renderDashboard: async (conversationId) => this.renderDashboard(conversationId),
    handleConversationText: async (conversationId, text) =>
      this.enqueueConversationTask(conversationId, () => this.handleConversationText(conversationId, text)),
    handleConversationAttachments: async (conversationId, attachments) =>
      this.enqueueConversationTask(conversationId, () => this.handleConversationAttachments(conversationId, attachments)),
    handleCardAction: async (value) => {
      const conversationId = typeof value.conversationId === "string" ? value.conversationId : "";
      return conversationId
        ? this.enqueueConversationTask(conversationId, () => this.handleCardAction(value))
        : this.handleCardAction(value);
    },
    saveAttachment: (attachment) => this.stateStore.saveAttachment(attachment)
  });
  private readonly upload = multer({ dest: path.join(this.config.dataDir, "incoming") });

  async start(): Promise<void> {
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    this.app.use(express.json({ limit: "20mb" }));
    this.registerRoutes();
    this.registerWebSocket();
    this.feishu.start(this.app);

    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.config.port, this.config.host, () => resolve());
    });
  }

  private registerRoutes(): void {
    this.app.get("/health", (_req: Request, res: Response) => {
      res.json({ ok: true, connectedDevices: this.connections.size });
    });

    this.app.get("/api/devices", (_req: Request, res: Response) => {
      res.json(
        this.config.devices.map((device) => ({
          id: device.id,
          name: device.name,
          online: this.connections.has(device.id),
          connectedAt: this.connections.get(device.id)?.connectedAt ?? null
        }))
      );
    });

    this.app.get("/api/workspaces/:deviceId", async (req: Request, res: Response) => {
      const workspaces = await this.dispatchCommand(String(req.params.deviceId), "list_workspaces", {});
      res.json(workspaces);
    });

    this.app.get("/api/threads", async (req: Request, res: Response) => {
      const deviceId = this.resolveDeviceId(req.query.deviceId as string | undefined);
      const payload = {
        workspaceId: String(req.query.workspaceId),
        assistantKind: req.query.assistantKind ? String(req.query.assistantKind) : undefined
      };
      const threads = await this.dispatchCommand(deviceId, "list_threads", payload);
      res.json(threads);
    });

    this.app.get("/api/threads/:threadId/transcript", async (req: Request, res: Response) => {
      const deviceId = this.resolveDeviceId(req.query.deviceId as string | undefined);
      const transcript = await this.dispatchCommand(deviceId, "open_thread", {
        workspaceId: String(req.query.workspaceId),
        assistantKind: String(req.query.assistantKind),
        threadId: req.params.threadId,
        cursor: req.query.cursor ? String(req.query.cursor) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : 20
      });
      res.json(transcript);
    });

    this.app.get("/api/current-target/:conversationId", (req: Request, res: Response) => {
      res.json(this.stateStore.getConversation(String(req.params.conversationId)));
    });

    this.app.post("/api/current-target", (req: Request, res: Response) => {
      const body = req.body as ConversationState;
      res.json(this.stateStore.saveConversation(body));
    });

    this.app.post("/api/attachments", this.upload.single("file"), (req: Request, res: Response) => {
      if (!req.file) {
        res.status(400).json({ error: "Missing file" });
        return;
      }

      const attachmentId = makeId("att");
      const finalPath = path.join(this.config.dataDir, "attachments", `${attachmentId}_${req.file.originalname}`);
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.renameSync(req.file.path, finalPath);

      const attachment: AttachmentMeta = this.stateStore.saveAttachment({
        id: attachmentId,
        name: req.file.originalname,
        kind: String(req.body.kind ?? "file") === "image" ? "image" : "file",
        mimeType: req.file.mimetype || "application/octet-stream",
        size: req.file.size,
        storedPath: finalPath,
        createdAt: nowIso(),
        source: "rest"
      });

      res.json(attachment);
    });

    this.app.get("/api/attachments/:attachmentId", (req: Request, res: Response) => {
      const attachment = this.stateStore.getAttachment(String(req.params.attachmentId));
      if (!attachment) {
        res.status(404).json({ error: "Attachment not found" });
        return;
      }

      const deviceToken = req.header("x-device-token");
      const tokenAllowed = this.config.devices.some((device) => device.token === deviceToken);
      if (!tokenAllowed) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      res.sendFile(path.resolve(attachment.storedPath));
    });

    this.app.post("/api/threads/create", async (req: Request, res: Response) => {
      const deviceId = this.resolveDeviceId(req.body.deviceId as string | undefined);
      const attachmentIds = Array.isArray(req.body.attachments) ? (req.body.attachments as string[]) : [];
      const attachments = attachmentIds
        .map((attachmentId) => this.stateStore.getAttachment(attachmentId))
        .filter((attachment): attachment is AttachmentMeta => Boolean(attachment));

      const result = await this.dispatchCommand(
        deviceId,
        "create_thread",
        {
          workspaceId: req.body.workspaceId,
          assistantKind: req.body.assistantKind,
          prompt: req.body.prompt,
          cwd: req.body.cwd,
          attachments
        },
        {
          conversationId: req.body.conversationId,
          action: "create_thread"
        }
      );

      res.json(result);
    });

    this.app.post("/api/threads/:threadId/send", async (req: Request, res: Response) => {
      const deviceId = this.resolveDeviceId(req.body.deviceId as string | undefined);
      const attachmentIds = Array.isArray(req.body.attachments) ? (req.body.attachments as string[]) : [];
      const attachments = attachmentIds
        .map((attachmentId) => this.stateStore.getAttachment(attachmentId))
        .filter((attachment): attachment is AttachmentMeta => Boolean(attachment));

      const result = await this.dispatchCommand(
        deviceId,
        "send_to_thread",
        {
          workspaceId: req.body.workspaceId,
          assistantKind: req.body.assistantKind,
          threadId: req.params.threadId,
          prompt: req.body.prompt,
          cwd: req.body.cwd,
          attachments
        },
        {
          conversationId: req.body.conversationId,
          action: "send_to_thread"
        }
      );

      res.json(result);
    });

    this.app.post("/api/threads/:threadId/cancel", async (req: Request, res: Response) => {
      const deviceId = this.resolveDeviceId(req.body.deviceId as string | undefined);
      const result = await this.dispatchCommand(deviceId, "cancel_run", {
        workspaceId: req.body.workspaceId,
        assistantKind: req.body.assistantKind,
        threadId: req.params.threadId
      });
      res.json(result);
    });

    this.app.post("/api/fs/list", async (req: Request, res: Response) => {
      const deviceId = this.resolveDeviceId(req.body.deviceId as string | undefined);
      const result = await this.dispatchCommand(deviceId, "list_dir", {
        workspaceId: req.body.workspaceId,
        path: req.body.path
      });
      res.json(result);
    });

    this.app.get("/api/fs/read", async (req: Request, res: Response) => {
      const deviceId = this.resolveDeviceId(req.query.deviceId as string | undefined);
      const result = await this.dispatchCommand(deviceId, "read_file", {
        workspaceId: req.query.workspaceId,
        path: req.query.path
      });
      res.json(result);
    });
  }

  private registerWebSocket(): void {
    this.httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "", `http://${request.headers.host}`);
      if (url.pathname !== "/agent/connect") {
        socket.destroy();
        return;
      }

      const deviceId = url.searchParams.get("deviceId") ?? "";
      const token = url.searchParams.get("token") ?? "";
      const device = this.config.devices.find((item) => item.id === deviceId && item.token === token);
      if (!device) {
        socket.destroy();
        return;
      }

      this.wsServer.handleUpgrade(request, socket, head, (websocket) => {
        this.wsServer.emit("connection", websocket, request, deviceId, device.name);
      });
    });

    this.wsServer.on("connection", (socket: WebSocket, _request: http.IncomingMessage, deviceId: string, deviceName: string) => {
      this.connections.set(deviceId, {
        socket,
        deviceId,
        deviceName,
        workspaces: [],
        capabilities: [],
        connectedAt: nowIso()
      });

      socket.on("message", (data) => {
        this.handleAgentSocketMessage(deviceId, data);
      });

      socket.on("close", () => {
        this.connections.delete(deviceId);
      });
    });
  }

  private handleAgentSocketMessage(deviceId: string, data: RawData): void {
    const message = safeJsonParse<any>(data.toString());
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.kind === "hello") {
      const hello = message as AgentHelloEnvelope;
      const connection = this.connections.get(deviceId);
      if (connection) {
        connection.deviceName = hello.deviceName;
        connection.workspaces = hello.workspaces;
        connection.capabilities = hello.capabilities;
      }
      return;
    }

    if (message.kind === "response") {
      const response = message as ResponseEnvelope;
      const pending = this.pendingRequests.get(response.requestId);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      this.pendingRequests.delete(response.requestId);
      if (response.ok) {
        pending.resolve(response.data);
      } else {
        pending.reject(new Error(response.error || "Agent command failed"));
      }
      return;
    }

    if (message.kind === "event") {
      const eventEnvelope = message as { requestId?: string; event: AgentEvent };
      void this.handleAgentEvent(eventEnvelope.requestId, eventEnvelope.event);
    }
  }

  private async handleAgentEvent(requestId: string | undefined, event: AgentEvent): Promise<void> {
    const context = requestId ? this.requestContexts.get(requestId) : undefined;

    if (event.type === "thread.created" && context?.conversationId) {
      const conversation = this.stateStore.getConversation(context.conversationId);
      conversation.currentTarget = {
        deviceId: event.deviceId,
        workspaceId: event.workspaceId,
        assistantKind: event.assistantKind,
        threadId: event.threadId,
        threadName: event.threadId
      } satisfies TargetRef;
      conversation.pendingCreateThread = undefined;
      conversation.updatedAt = nowIso();
      this.stateStore.saveConversation(conversation);
      await this.sendConversationReply(
        context.conversationId,
        `已创建 thread ${formatThreadLabel(event.threadId)}，并设为当前 target。发送普通文本会继续投递到这个 thread。\n\n可用命令：\n/history\n/status\n/compact\n/ls\n/open <path>\n/stop\n/target`
      );
      return;
    }

    if (event.type === "run.output") {
      for (const conversation of this.stateStore.listConversations()) {
        if (conversation.currentTarget?.threadId === event.threadId) {
          if (event.stream === "tool" && event.command && event.status !== "completed") {
            const progressText = buildCommandProgressText(event.command);
            if (progressText) {
              await this.feishu.sendText(conversation.conversationId, progressText);
            }
            continue;
          }

          if (event.stream === "text" && event.text) {
            await this.feishu.sendText(conversation.conversationId, event.text);
            continue;
          }

          if (event.stream === "error" && event.text) {
            await this.feishu.sendText(conversation.conversationId, `错误: ${event.text}`);
          }
        }
      }
      return;
    }

    if (event.type === "run.state" && (event.state === "completed" || event.state === "failed" || event.state === "cancelled")) {
      for (const conversation of this.stateStore.listConversations()) {
        if (conversation.currentTarget?.threadId === event.threadId) {
          await this.sendConversationReply(
            conversation.conversationId,
            event.state === "completed"
              ? "当前 thread 已完成。可发送新消息继续，或用 /history 查看最近记录。"
              : event.state === "cancelled"
                ? "当前 thread 已停止。可直接补充说明继续，或用 /history 查看最近记录。"
                : "当前 thread 执行失败。可直接补充说明继续，或用 /history 查看最近记录。"
          );
        } else if (event.threadId) {
          await this.feishu.sendText(
            conversation.conversationId,
            `后台 thread ${formatThreadLabel(event.threadId)} ${
              event.state === "completed" ? "已完成" : event.state === "cancelled" ? "已停止" : "执行失败"
            }`
          );
        }
      }
    }
  }

  private async dispatchCommand(
    deviceId: string,
    action: CommandAction,
    payload: Record<string, unknown>,
    context?: RequestContext,
    timeoutMs = 30000
  ): Promise<any> {
    const connection = this.connections.get(deviceId);
    if (!connection) {
      throw new Error(`Device is offline: ${deviceId}`);
    }

    const requestId = makeId("req");
    const envelope: CommandEnvelope = {
      kind: "command",
      requestId,
      action,
      payload
    };

    if (context) {
      this.requestContexts.set(requestId, context);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Timed out waiting for ${action}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      connection.socket.send(JSON.stringify(envelope));
    });
  }

  private resolveDeviceId(requestedDeviceId?: string): string {
    if (requestedDeviceId) {
      return requestedDeviceId;
    }

    const [firstConnection] = this.connections.keys();
    if (!firstConnection) {
      throw new Error("No online device available");
    }

    return firstConnection;
  }

  private async renderDashboard(conversationId: string): Promise<unknown> {
    const conversation = this.stateStore.getConversation(conversationId);
    const deviceId = conversation.currentTarget?.deviceId ?? this.resolveDeviceId();
    const connection = this.connections.get(deviceId);
    if (!connection) {
      return buildInfoCard("设备离线", "当前没有在线 agent");
    }

    const threadsByWorkspace: Record<string, ThreadSummary[]> = {};
    for (const workspace of connection.workspaces) {
      threadsByWorkspace[workspace.id] = await this.dispatchCommand(deviceId, "list_threads", {
        workspaceId: workspace.id
      });
    }

    return buildDashboardCard({
      conversation,
      deviceId,
      deviceName: connection.deviceName,
      workspaces: connection.workspaces,
      threadsByWorkspace
    });
  }

  private async renderDashboardText(conversationId: string): Promise<string> {
    const conversation = this.stateStore.getConversation(conversationId);
    const deviceId = conversation.currentTarget?.deviceId ?? this.resolveDeviceId();
    const connection = this.connections.get(deviceId);
    if (!connection) {
      return "当前没有在线 agent。";
    }

    const lines: string[] = [
      `设备: ${connection.deviceName} (${deviceId})`,
      `当前 target: ${conversation.currentTarget?.threadName ?? conversation.currentTarget?.threadId ?? "未选择"}`,
      "",
      "工作区："
    ];

    for (const workspace of connection.workspaces) {
      const threads = (await this.dispatchCommand(deviceId, "list_threads", {
        workspaceId: workspace.id
      })) as ThreadSummary[];
      lines.push(
        `- ${workspace.id}: ${workspace.name} [${workspace.assistants.join(", ")}], thread ${threads.length} 个, 查看: /threads ${workspace.id}`
      );
    }

    lines.push("");
    lines.push("接下来会分多条消息发送 thread 快捷项，每条第一行都是可直接复制的 /use <threadId>。");
    lines.push("");
    lines.push("常用命令：");
    lines.push("/help");
    lines.push("/dashboard");
    lines.push("/workspaces");
    lines.push("/target");
    lines.push("/use <threadId>");
    lines.push("/new <workspaceId> [assistantKind]");
    lines.push("/threads <workspaceId> [count]");
    lines.push("/threads <workspaceId> <keyword>");
    lines.push("/threads <workspaceId> <assistantKind>");
    lines.push("/threads <workspaceId> <assistantKind> [count]");
    lines.push("/threads <workspaceId> <assistantKind> [count] <keyword>");
    lines.push("/status");
    lines.push("/history [count]");
    lines.push("/history s");
    lines.push("/history <threadId> [count] [s]");
    lines.push("/compact");
    lines.push("/ls [path]");
    lines.push("/open <path>");
    lines.push("/cancel");
    lines.push("/stop");

    return lines.join("\n");
  }

  private async renderThreadDetail(conversationId: string, cursor?: string): Promise<unknown> {
    const conversation = this.stateStore.getConversation(conversationId);
    const target = conversation.currentTarget;
    if (!target) {
      return buildInfoCard("未选择 thread", "请先打开 dashboard 并切换到一个 thread");
    }

    const transcript = await this.dispatchCommand(target.deviceId, "open_thread", {
      workspaceId: target.workspaceId,
      assistantKind: target.assistantKind,
      threadId: target.threadId,
      cursor,
      limit: 12
    });

    return buildThreadDetailCard({
      conversation,
      transcript,
      targetTitle: `${target.assistantKind} | ${target.threadName ?? target.threadId}`
    });
  }

  private async renderThreadDetailText(
    conversationId: string,
    pairLimit?: number,
    compact = false
  ): Promise<string[]> {
    const conversation = this.stateStore.getConversation(conversationId);
    const target = conversation.currentTarget;
    if (!target) {
      return [[
        "当前没有 target thread。",
        "先发送 /workspaces 查看工作区，或发送 /threads <workspaceId> 获取 thread 快捷项。",
        "thread 列表会分多条消息返回，每条第一行都是 /use <threadId>，复制后直接发送即可。",
        "你也可以直接使用 /history <threadId> 查看并切换到指定 thread。"
      ].join("\n")];
    }

    const transcriptItems = await this.loadFullTranscriptItems(target);
    return buildThreadDetailText(target, transcriptItems, pairLimit, compact);
  }

  private async renderDirectory(conversationId: string, requestedPath = "."): Promise<unknown> {
    const conversation = this.stateStore.getConversation(conversationId);
    const target = conversation.currentTarget;
    if (!target) {
      return buildInfoCard("未选择 thread", "请先切换到目标 thread 后再浏览目录");
    }

    const nodes = await this.dispatchCommand(target.deviceId, "list_dir", {
      workspaceId: target.workspaceId,
      path: requestedPath
    });

    return buildDirectoryCard({
      conversation,
      cwdTitle: requestedPath,
      nodes
    });
  }

  private async renderDirectoryText(conversationId: string, requestedPath = "."): Promise<string> {
    const conversation = this.stateStore.getConversation(conversationId);
    const target = conversation.currentTarget;
    if (!target) {
      return "请先切换到目标 thread，再浏览目录。";
    }

    const nodes = (await this.dispatchCommand(target.deviceId, "list_dir", {
      workspaceId: target.workspaceId,
      path: requestedPath
    })) as Array<{ name: string; path: string; type: string; size?: number }>;

    return buildDirectoryText(requestedPath, nodes);
  }

  private async renderWorkspacesText(conversationId: string): Promise<string> {
    const conversation = this.stateStore.getConversation(conversationId);
    const deviceId = conversation.currentTarget?.deviceId ?? this.resolveDeviceId();
    const connection = this.connections.get(deviceId);
    if (!connection) {
      return "当前没有在线 agent。";
    }

    const lines = [`设备: ${connection.deviceName} (${deviceId})`, "", "工作区："];
    for (const workspace of connection.workspaces) {
      lines.push(`- ${workspace.id}: ${workspace.name} [${workspace.assistants.join(", ")}], 默认 ${workspace.defaultAssistant}`);
    }
    lines.push("");
    lines.push("新建 thread: /new <workspaceId> [assistantKind]");
    lines.push("列出 threads: /threads <workspaceId> [assistantKind] [count]");
    return lines.join("\n");
  }

  private async sendConversationReply(conversationId: string, text: string): Promise<void> {
    await this.feishu.sendText(conversationId, text);
  }

  private async sendConversationReplies(conversationId: string, messages: string[]): Promise<void> {
    for (const message of messages) {
      await this.sendConversationReply(conversationId, message);
    }
  }

  private async sendHistoryResponse(
    conversationId: string,
    pairLimit?: number,
    compact = false
  ): Promise<void> {
    const messages = await this.renderThreadDetailText(conversationId, pairLimit, compact);
    await this.sendConversationReplies(conversationId, messages);
  }

  private async sendStatusResponse(conversationId: string): Promise<void> {
    const conversation = this.stateStore.getConversation(conversationId);
    if (conversation.pendingCreateThread && !conversation.currentTarget) {
      await this.sendConversationReply(
        conversationId,
        [
          "当前会话状态",
          "模式: 新建 thread",
          `workspace: ${conversation.pendingCreateThread.workspaceId}`,
          `assistant: ${conversation.pendingCreateThread.assistantKind}`,
          `device: ${conversation.pendingCreateThread.deviceId}`,
          "说明: 下一条普通文本会创建新 thread。"
        ].join("\n")
      );
      return;
    }

    const target = conversation.currentTarget;
    if (!target) {
      await this.sendConversationReply(
        conversationId,
        "当前没有 target thread。先发送 /threads <workspaceId> 或 /dashboard 选择会话。"
      );
      return;
    }

    const [transcriptItems, threadSummary] = await Promise.all([
      this.loadFullTranscriptItems(target),
      this.findThreadSummary(target)
    ]);

    await this.sendConversationReply(
      conversationId,
      buildSessionStatusText({
        conversation,
        target,
        transcriptItems,
        threadSummary
      })
    );
  }

  private async sendThreadListResponse(conversationId: string, options: ThreadListOptions): Promise<void> {
    const limit = options.limit ?? options.threads.length;
    const sliced = options.threads.slice(0, limit);

    if (sliced.length === 0) {
      await this.sendConversationReply(conversationId, `${options.title}\n\n没有可用的 thread。`);
      return;
    }

    await this.sendConversationReply(
      conversationId,
      buildThreadListHeader({
        title: options.title,
        workspaceId: options.workspaceId,
        assistantKind: options.assistantKind,
        threadQuery: options.threadQuery,
        totalThreads: options.threads.length
      })
    );

    for (const thread of sliced) {
      await this.sendConversationReply(conversationId, buildThreadShortcutText(thread));
    }
  }

  private async loadFullTranscriptItems(target: TargetRef): Promise<TranscriptItem[]> {
    const pages: TranscriptPage[] = [];
    let cursor: string | undefined;

    do {
      const page = (await this.dispatchCommand(target.deviceId, "open_thread", {
        workspaceId: target.workspaceId,
        assistantKind: target.assistantKind,
        threadId: target.threadId,
        cursor,
        limit: HISTORY_FETCH_PAGE_LIMIT
      })) as TranscriptPage;
      pages.unshift(page);
      cursor = page.nextCursor;
    } while (cursor);

    return pages.flatMap((page) => page.items);
  }

  private async findThreadSummary(target: TargetRef): Promise<ThreadSummary | undefined> {
    const threads = (await this.dispatchCommand(target.deviceId, "list_threads", {
      workspaceId: target.workspaceId,
      assistantKind: target.assistantKind
    })) as ThreadSummary[];

    return threads.find((thread) => thread.threadId === target.threadId);
  }

  private applyCurrentTarget(conversation: ConversationState, match: ResolvedThreadMatch): void {
    conversation.currentTarget = {
      deviceId: match.deviceId,
      workspaceId: match.workspaceId,
      assistantKind: match.assistantKind,
      threadId: match.threadId,
      threadName: match.name
    };
    conversation.pendingCreateThread = undefined;
    conversation.updatedAt = nowIso();
    this.stateStore.saveConversation(conversation);
  }

  private async sendDashboardResponse(conversationId: string): Promise<void> {
    if (this.config.feishu.interactiveCardsEnabled) {
      await this.feishu.sendCard(conversationId, await this.renderDashboard(conversationId));
      return;
    }

    const conversation = this.stateStore.getConversation(conversationId);
    const deviceId = conversation.currentTarget?.deviceId ?? this.resolveDeviceId();
    const connection = this.connections.get(deviceId);
    if (!connection) {
      await this.sendConversationReply(conversationId, "当前没有在线 agent。");
      return;
    }

    await this.sendConversationReply(conversationId, await this.renderDashboardText(conversationId));

    for (const workspace of connection.workspaces) {
      const threads = ((await this.dispatchCommand(deviceId, "list_threads", {
        workspaceId: workspace.id
      })) as ThreadSummary[]).map((thread) => ({
        deviceId,
        ...thread
      }));

      await this.sendThreadListResponse(conversationId, {
        title: `工作区 ${workspace.id} | ${workspace.name}\n新建: /new ${workspace.id} ${workspace.defaultAssistant}`,
        threads,
        workspaceId: workspace.id,
        limit: DEFAULT_THREADS_LIST_LIMIT
      });
    }
  }

  private async findThreadByQuery(
    conversationId: string,
    threadIdQuery: string
  ): Promise<ResolvedThreadMatch | undefined> {
    const conversation = this.stateStore.getConversation(conversationId);
    const preferredDeviceId = conversation.currentTarget?.deviceId;
    const deviceIds = preferredDeviceId
      ? [preferredDeviceId, ...Array.from(this.connections.keys()).filter((item) => item !== preferredDeviceId)]
      : Array.from(this.connections.keys());

    const candidates: ResolvedThreadMatch[] = [];

    for (const deviceId of deviceIds) {
      const connection = this.connections.get(deviceId);
      if (!connection) {
        continue;
      }

      for (const workspace of connection.workspaces) {
        const threads = (await this.dispatchCommand(deviceId, "list_threads", {
          workspaceId: workspace.id
        })) as ThreadSummary[];

        for (const thread of threads) {
          candidates.push({
            deviceId,
            ...thread
          });
        }
      }
    }

    return matchThreadByQuery(threadIdQuery, candidates, conversation.currentTarget);
  }

  private async handleOpenFileText(conversationId: string, requestedPath: string): Promise<string> {
    const conversation = this.stateStore.getConversation(conversationId);
    const target = conversation.currentTarget;
    if (!target) {
      return "请先切换到目标 thread，再打开文件。";
    }

    const result = (await this.dispatchCommand(target.deviceId, "read_file", {
      workspaceId: target.workspaceId,
      path: requestedPath
    })) as ReadFileResult;

    if (result.isBinary && result.base64Content) {
      const outboxPath = materializeBinaryReadResult(
        this.config.dataDir,
        result,
        requestedPath,
        makeId("out")
      );

      if (result.mimeType.startsWith("image/")) {
        await this.feishu.sendLocalImage(conversationId, outboxPath);
      } else {
        await this.feishu.sendLocalFile(conversationId, outboxPath);
      }

      return `已发送文件 ${result.path} (${result.mimeType}, ${result.size} bytes)`;
    }

    return buildReadFilePreviewText(result);
  }

  private async handleCancelCommand(
    conversationId: string,
    conversation: ConversationState
  ): Promise<void> {
    if (!conversation.currentTarget) {
      await this.sendConversationReply(conversationId, "当前没有 target thread。");
      return;
    }

    const result = await this.dispatchCommand(conversation.currentTarget.deviceId, "cancel_run", {
      workspaceId: conversation.currentTarget.workspaceId,
      assistantKind: conversation.currentTarget.assistantKind,
      threadId: conversation.currentTarget.threadId
    });
    const details = result as { removedQueued?: boolean; active?: boolean; stoppedActive?: boolean };
    if (details.removedQueued) {
      await this.sendConversationReply(conversationId, "已取消排队中的任务。");
      return;
    }

    if (details.active && details.stoppedActive) {
      await this.sendConversationReply(conversationId, "已向当前运行中的任务发送停止信号，并尝试终止相关子进程。");
      return;
    }

    await this.sendConversationReply(conversationId, "当前 thread 没有可取消的排队或运行任务。");
  }

  private async handleConversationText(conversationId: string, text: string): Promise<void> {
    const conversation = this.stateStore.getConversation(conversationId);
    const trimmedText = text.trim();

    if (trimmedText.startsWith("/")) {
      const [rawCommand, ...args] = trimmedText.split(/\s+/);
      const command = rawCommand.slice(1).toLowerCase();

      switch (command) {
        case "help":
          await this.sendConversationReply(conversationId, renderHelpText());
          return;
        case "dashboard":
          await this.sendDashboardResponse(conversationId);
          return;
        case "workspaces":
          await this.sendConversationReply(conversationId, await this.renderWorkspacesText(conversationId));
          return;
        case "threads":
          await this.sendThreadsCommandResponse(conversationId, args[0], args.slice(1));
          return;
        case "target":
          await this.sendConversationReply(conversationId, renderTargetText(conversation));
          return;
        case "use": {
          const threadIdQuery = args[0];
          if (!threadIdQuery) {
            await this.sendConversationReply(conversationId, "用法: /use <threadId>");
            return;
          }

          const match = await this.findThreadByQuery(conversationId, threadIdQuery);
          if (!match) {
            await this.sendConversationReply(conversationId, `未找到 thread: ${threadIdQuery}`);
            return;
          }

          this.applyCurrentTarget(conversation, match);
          await this.sendConversationReply(
            conversationId,
            `已切换到 ${match.assistantKind} thread ${formatThreadLabel(match.name || match.threadId)}`
          );
          return;
        }
        case "new": {
          const workspaceId = args[0];
          if (!workspaceId) {
            await this.sendConversationReply(conversationId, "用法: /new <workspaceId> [assistantKind]");
            return;
          }

          const deviceId = conversation.currentTarget?.deviceId ?? this.resolveDeviceId();
          const connection = this.connections.get(deviceId);
          if (!connection) {
            await this.sendConversationReply(conversationId, "当前没有在线 agent。");
            return;
          }

          const workspace = connection.workspaces.find((item) => item.id === workspaceId);
          if (!workspace) {
            await this.sendConversationReply(conversationId, `未找到工作区: ${workspaceId}`);
            return;
          }

          const requestedAssistant = this.parseAssistantKind(args[1]);
          if (args[1] !== undefined && !requestedAssistant) {
            await this.sendConversationReply(
              conversationId,
              `不支持的 assistant: ${args[1]}\n可选: ${workspace.assistants.join(", ")}`
            );
            return;
          }

          const assistantKind = requestedAssistant ?? workspace.defaultAssistant;
          if (!workspace.assistants.includes(assistantKind)) {
            await this.sendConversationReply(
              conversationId,
              `工作区 ${workspaceId} 未启用 assistant ${assistantKind}`
            );
            return;
          }

          conversation.pendingCreateThread = {
            deviceId,
            workspaceId: workspace.id,
            assistantKind
          };
          conversation.updatedAt = nowIso();
          this.stateStore.saveConversation(conversation);
          await this.sendConversationReply(
            conversationId,
            `已进入新建 thread 模式。下一条普通文本会在工作区 ${workspaceId} 中创建新的 ${assistantKind} thread。`
          );
          return;
        }
        case "history": {
          const parsedArgs = parseHistoryArgs(args);
          if (parsedArgs.error) {
            await this.sendConversationReply(conversationId, parsedArgs.error);
            return;
          }

          if (parsedArgs.threadQuery) {
            const match = await this.findThreadByQuery(conversationId, parsedArgs.threadQuery);
            if (!match) {
              await this.sendConversationReply(conversationId, `未找到 thread: ${parsedArgs.threadQuery}`);
              return;
            }
            this.applyCurrentTarget(conversation, match);
          }

          await this.sendHistoryResponse(conversationId, parsedArgs.pairLimit, parsedArgs.compact);
          return;
        }
        case "status":
          await this.sendStatusResponse(conversationId);
          return;
        case "compact":
          await this.handleCompactCommand(conversationId, conversation);
          return;
        case "ls":
          await this.sendConversationReply(
            conversationId,
            await this.renderDirectoryText(conversationId, args[0] ?? ".")
          );
          return;
        case "open": {
          const requestedPath = args.join(" ").trim();
          if (!requestedPath) {
            await this.sendConversationReply(conversationId, "用法: /open <path>");
            return;
          }

          const openResponse = await this.handleOpenFileText(conversationId, requestedPath);
          if (openResponse) {
            await this.sendConversationReply(conversationId, openResponse);
          }
          return;
        }
        case "cancel":
        case "stop": {
          await this.handleCancelCommand(conversationId, conversation);
          return;
        }
        default:
          await this.sendConversationReply(
            conversationId,
            `未知命令: ${rawCommand}\n\n${renderHelpText()}`
          );
          return;
      }
    }

    if (conversation.pendingCreateThread) {
      const createResult = (await this.dispatchCommand(
        conversation.pendingCreateThread.deviceId,
        "create_thread",
        {
          workspaceId: conversation.pendingCreateThread.workspaceId,
          assistantKind: conversation.pendingCreateThread.assistantKind,
          prompt: text,
          attachments: []
        },
        {
          conversationId,
          action: "create_thread"
        }
      )) as { queuePosition?: number };
      const queuePosition = Number(createResult.queuePosition ?? 0);
      await this.feishu.sendText(
        conversationId,
        queuePosition > 0
          ? `已接收首条消息，新 thread 已进入设备队列，位置 ${queuePosition}。`
          : "已接收首条消息，正在创建 thread..."
      );
      return;
    }

    if (!conversation.currentTarget) {
      await this.sendConversationReply(
        conversationId,
        `当前没有 target thread。\n\n${renderHelpText()}`
      );
      return;
    }

    const sendResult = (await this.dispatchCommand(
      conversation.currentTarget.deviceId,
      "send_to_thread",
      {
        workspaceId: conversation.currentTarget.workspaceId,
        assistantKind: conversation.currentTarget.assistantKind,
        threadId: conversation.currentTarget.threadId,
        prompt: text,
        attachments: []
      },
      {
        conversationId,
        action: "send_to_thread"
      }
    )) as { queuePosition?: number };
    const targetLabel = conversation.currentTarget.threadName ?? conversation.currentTarget.threadId;
    const queuePosition = Number(sendResult.queuePosition ?? 0);
    await this.feishu.sendText(
      conversationId,
      queuePosition > 0
        ? `thread ${formatThreadLabel(targetLabel)} 正在排队，当前位置 ${queuePosition}。`
        : `已投递到 thread ${formatThreadLabel(targetLabel)}`
    );
  }

  private async handleConversationAttachments(conversationId: string, attachments: AttachmentMeta[]): Promise<void> {
    const conversation = this.stateStore.getConversation(conversationId);
    if (conversation.pendingCreateThread) {
      await this.feishu.sendText(
        conversationId,
        "当前处于新建 thread 模式。请先发送首条文本创建 thread，再补充图片或文件。"
      );
      return;
    }

    if (!conversation.currentTarget) {
      await this.feishu.sendText(conversationId, "请先切换到目标 thread，再发送图片或文件。");
      return;
    }

    const sendResult = (await this.dispatchCommand(
      conversation.currentTarget.deviceId,
      "send_to_thread",
      {
        workspaceId: conversation.currentTarget.workspaceId,
        assistantKind: conversation.currentTarget.assistantKind,
        threadId: conversation.currentTarget.threadId,
        prompt: "",
        attachments
      },
      {
        conversationId,
        action: "send_to_thread"
      }
    )) as { queuePosition?: number };

    const queuePosition = Number(sendResult.queuePosition ?? 0);
    await this.feishu.sendText(
      conversationId,
      queuePosition > 0
        ? `${attachments.length} 个附件已进入队列，当前位置 ${queuePosition}。`
        : `已把 ${attachments.length} 个附件投递到当前 thread ${formatThreadLabel(
            conversation.currentTarget.threadName ?? conversation.currentTarget.threadId
          )}`
    );
  }

  private async sendThreadsCommandResponse(
    conversationId: string,
    workspaceId?: string,
    rawArgs: string[] = []
  ): Promise<void> {
    const conversation = this.stateStore.getConversation(conversationId);
    const deviceId = conversation.currentTarget?.deviceId ?? this.resolveDeviceId();
    const connection = this.connections.get(deviceId);
    if (!connection) {
      await this.sendConversationReply(conversationId, "当前没有在线 agent。");
      return;
    }

    if (!workspaceId) {
      await this.sendConversationReply(conversationId, renderThreadsUsageText(connection.workspaces));
      return;
    }

    const workspaces = workspaceId
      ? connection.workspaces.filter((workspace) => workspace.id === workspaceId)
      : connection.workspaces;
    if (workspaces.length === 0) {
      await this.sendConversationReply(
        conversationId,
        `未找到工作区: ${workspaceId}\n\n${renderThreadsUsageText(connection.workspaces)}`
      );
      return;
    }

    const parsedArgs = parseThreadsArgs(rawArgs);
    if (parsedArgs.error) {
      await this.sendConversationReply(conversationId, parsedArgs.error);
      return;
    }

    for (const workspace of workspaces) {
      if (parsedArgs.assistantKind && !workspace.assistants.includes(parsedArgs.assistantKind)) {
        await this.sendConversationReply(
          conversationId,
          `工作区 ${workspace.id} 未启用 assistant ${parsedArgs.assistantKind}\n\n${renderThreadsUsageText(connection.workspaces)}`
        );
        return;
      }

      const threads = ((await this.dispatchCommand(deviceId, "list_threads", {
        workspaceId: workspace.id,
        assistantKind: parsedArgs.assistantKind
      })) as ThreadSummary[]).map((thread) => ({
        deviceId,
        ...thread
      }));
      const normalizedQuery = parsedArgs.threadQuery?.trim().toLowerCase();
      const filteredThreads = normalizedQuery
        ? threads.filter((thread) => (thread.name || thread.threadId).toLowerCase().includes(normalizedQuery))
        : threads;

      await this.sendThreadListResponse(conversationId, {
        title: `工作区 ${workspace.id} 的 ${parsedArgs.assistantKind ?? "全部"} thread 列表${
          parsedArgs.threadQuery ? ` | 标题包含: ${parsedArgs.threadQuery}` : ""
        }`,
        threads: filteredThreads,
        workspaceId: workspace.id,
        assistantKind: parsedArgs.assistantKind,
        threadQuery: parsedArgs.threadQuery,
        limit: parsedArgs.limit
      });
    }
  }

  private enqueueConversationTask<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const previousTask = this.conversationTasks.get(conversationId) ?? Promise.resolve();
    const nextTask = previousTask.catch(() => undefined).then(task);
    const trackedTask = nextTask.then(
      () => undefined,
      () => undefined
    );

    this.conversationTasks.set(conversationId, trackedTask);
    void trackedTask.finally(() => {
      if (this.conversationTasks.get(conversationId) === trackedTask) {
        this.conversationTasks.delete(conversationId);
      }
    });

    return nextTask;
  }

  private async handleCardAction(value: Record<string, unknown>): Promise<unknown> {
    const action = String(value.action ?? "");
    const conversationId = String(value.conversationId ?? "");
    if (!conversationId) {
      return buildInfoCard("无效操作", "缺少 conversationId");
    }

    switch (action) {
      case "refresh_dashboard":
        return this.renderDashboard(conversationId);
      case "switch_thread": {
        const conversation = this.stateStore.getConversation(conversationId);
        conversation.currentTarget = {
          deviceId: String(value.deviceId),
          workspaceId: String(value.workspaceId),
          assistantKind: this.parseAssistantKind(value.assistantKind) ?? "codex",
          threadId: String(value.threadId),
          threadName: String(value.threadName)
        };
        conversation.pendingCreateThread = undefined;
        conversation.updatedAt = nowIso();
        this.stateStore.saveConversation(conversation);
        return this.renderThreadDetail(conversationId);
      }
      case "start_create_thread": {
        const conversation = this.stateStore.getConversation(conversationId);
        conversation.pendingCreateThread = {
          deviceId: String(value.deviceId),
          workspaceId: String(value.workspaceId),
          assistantKind: this.parseAssistantKind(value.assistantKind) ?? "codex"
        };
        conversation.updatedAt = nowIso();
        this.stateStore.saveConversation(conversation);
        return buildInfoCard("准备新建 thread", "请直接发送首条消息，收到后会在该工作区里创建新的 thread。");
      }
      case "refresh_thread":
        return this.renderThreadDetail(conversationId);
      case "paginate_thread":
        return this.renderThreadDetail(conversationId, String(value.cursor ?? ""));
      case "list_dir":
        return this.renderDirectory(conversationId, String(value.path ?? "."));
      case "read_file": {
        const conversation = this.stateStore.getConversation(conversationId);
        const target = conversation.currentTarget;
        if (!target) {
          return buildInfoCard("未选择 thread", "请先切换到一个 thread");
        }

        const result = (await this.dispatchCommand(target.deviceId, "read_file", {
          workspaceId: target.workspaceId,
          path: String(value.path)
        })) as ReadFileResult;

        if (result.isBinary && result.base64Content) {
          const outboxPath = materializeBinaryReadResult(this.config.dataDir, result, String(value.path));
          if (String(result.mimeType).startsWith("image/")) {
            await this.feishu.sendLocalImage(conversationId, outboxPath);
          } else {
            await this.feishu.sendLocalFile(conversationId, outboxPath);
          }
          return buildInfoCard("文件已发送", `已发送 ${result.path}`);
        }

        return buildInfoCard(`文件预览 | ${result.path}`, result.content || "空文件");
      }
      default:
        return buildInfoCard("未知动作", `未识别的 action: ${action}`);
    }
  }

  private parseAssistantKind(value: unknown): AssistantKind | undefined {
    if (value === "codex" || value === "claude") {
      return value;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "codex" || normalized === "claude") {
        return normalized;
      }
    }

    return undefined;
  }

  private async handleCompactCommand(conversationId: string, conversation: ConversationState): Promise<void> {
    const target = conversation.currentTarget;
    if (!target) {
      await this.sendConversationReply(
        conversationId,
        "当前没有 target thread。请先用 /use <threadId> 选中要压缩的会话。"
      );
      return;
    }

    const transcriptItems = await this.loadFullTranscriptItems(target);
    if (transcriptItems.length === 0) {
      await this.sendConversationReply(conversationId, "当前 thread 还没有可压缩的历史。");
      return;
    }

    const compactPrompt = buildCompactThreadPrompt(target, transcriptItems);
    const result = (await this.dispatchCommand(
      target.deviceId,
      "create_thread",
      {
        workspaceId: target.workspaceId,
        assistantKind: target.assistantKind,
        prompt: compactPrompt,
        attachments: []
      },
      {
        conversationId,
        action: "create_thread"
      }
    )) as { queuePosition?: number };

    const queuePosition = Number(result.queuePosition ?? 0);
    await this.sendConversationReply(
      conversationId,
      queuePosition > 0
        ? `已开始压缩当前上下文，新的 compact thread 已进入队列，位置 ${queuePosition}。完成后会自动切换到新 thread。`
        : "已开始压缩当前上下文，新的 compact thread 创建完成后会自动切换为当前 target。"
    );
  }
}
