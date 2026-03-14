import WebSocket, { RawData } from "ws";

import { CodexAdapter } from "../adapters/codex";
import { AssistantAdapter } from "../adapters/base";
import { ExecutionManager, RuntimeThreadState } from "./execution-manager";
import { loadAgentConfig } from "../shared/config";
import { listWorkspaceDirectory, readWorkspaceFile } from "../shared/fs-utils";
import { ensureCodexCommandReady } from "../shared/process-utils";
import { nowIso, safeJsonParse } from "../shared/utils";
import {
  AgentEvent,
  AgentEventEnvelope,
  AssistantKind,
  AttachmentMeta,
  CommandEnvelope,
  QueuedJob,
  ResponseEnvelope,
  WorkspaceConfig
} from "../shared/types";

export class AgentService {
  private readonly config = loadAgentConfig();
  private readonly adapters = new Map<string, AssistantAdapter>();
  private readonly runtimeStates = new Map<string, RuntimeThreadState>();
  private readonly executionManager: ExecutionManager;
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;

  constructor() {
    this.adapters.set(
      "codex",
      new CodexAdapter(this.config.codexPath, this.config.gatewayUrl, this.config.deviceToken, {
        url: this.config.codexAppServerUrl,
        reuseScope: this.config.codexAppServerReuseScope
      })
    );
    this.executionManager = new ExecutionManager(
      {
        config: this.config,
        resolveAdapter: (kind) => this.resolveAdapter(kind),
        resolveWorkspace: (workspaceId) => this.resolveWorkspace(workspaceId),
        emit: (requestId, event) => this.emitEvent(requestId, event),
        updateRuntimeState: (state) => this.runtimeStates.set(this.runtimeKey(state.assistantKind, state.threadId), state),
        clearRuntimeState: (assistantKind, threadId) => {
          if (threadId) {
            this.runtimeStates.delete(this.runtimeKey(assistantKind, threadId));
          }
        }
      }
    );
  }

  async start(): Promise<void> {
    ensureCodexCommandReady(this.config.codexPath);
    this.connect();
  }

  private connect(): void {
    const wsUrl = `${this.config.gatewayUrl.replace(/^http/i, "ws")}/agent/connect?deviceId=${encodeURIComponent(this.config.deviceId)}&token=${encodeURIComponent(this.config.deviceToken)}`;
    this.socket = new WebSocket(wsUrl);

    this.socket.on("open", () => {
      const hello = {
        kind: "hello",
        deviceId: this.config.deviceId,
        deviceName: this.config.deviceName,
        workspaces: this.config.workspaces,
        capabilities: [
          "list_threads",
          "open_thread",
          "create_thread",
          "send_to_thread",
          "list_dir",
          "read_file"
        ]
      };
      this.socket?.send(JSON.stringify(hello));
    });

    this.socket.on("message", async (data) => {
      await this.handleSocketMessage(data);
    });

    this.socket.on("close", () => {
      this.scheduleReconnect();
    });

    this.socket.on("error", () => {
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 2000);
  }

  private async handleSocketMessage(data: RawData): Promise<void> {
    const envelope = safeJsonParse<CommandEnvelope>(data.toString());
    if (!envelope || envelope.kind !== "command") {
      return;
    }

    try {
      const result = await this.handleCommand(envelope);
      this.sendResponse({
        kind: "response",
        requestId: envelope.requestId,
        ok: true,
        data: result
      });
    } catch (error) {
      this.sendResponse({
        kind: "response",
        requestId: envelope.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleCommand(envelope: CommandEnvelope): Promise<unknown> {
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;

    switch (envelope.action) {
      case "list_workspaces":
        return this.config.workspaces;
      case "list_threads":
        return this.listThreads(payload);
      case "open_thread":
        return this.openThread(payload);
      case "switch_thread":
        return { ok: true };
      case "create_thread":
        return this.executionManager.enqueue(this.buildQueuedJob("create_thread", envelope.requestId, payload));
      case "send_to_thread":
        return this.executionManager.enqueue(this.buildQueuedJob("send_to_thread", envelope.requestId, payload));
      case "cancel_run":
        return this.executionManager.cancel(envelope.requestId, payload.threadId ? String(payload.threadId) : undefined);
      case "list_dir":
        return this.listDirectory(payload);
      case "read_file":
        return this.readFile(payload);
      case "upload_attachment":
        return { ok: true };
      default:
        throw new Error(`Unsupported action: ${envelope.action}`);
    }
  }

  private async listThreads(payload: Record<string, unknown>) {
    const workspace = this.resolveWorkspace(String(payload.workspaceId));
    const requestedAssistant: AssistantKind | undefined = payload.assistantKind === "codex" ? "codex" : undefined;
    const assistants = requestedAssistant ? [requestedAssistant] : workspace.assistants;

    const threadSummaries = await Promise.all(
      assistants.map(async (assistantKind) => {
        const adapter = this.resolveAdapter(assistantKind);
        const items = await adapter.listThreads(workspace);
        return items.map((item) => {
          const runtime = this.runtimeStates.get(this.runtimeKey(item.assistantKind, item.threadId));
          return runtime
            ? {
                ...item,
                status: runtime.status,
                queuePosition: runtime.queuePosition
              }
            : item;
        });
      })
    );

    return threadSummaries
      .flat()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async openThread(payload: Record<string, unknown>) {
    const workspace = this.resolveWorkspace(String(payload.workspaceId));
    const assistantKind = this.requireAssistantKind(payload.assistantKind);
    const adapter = this.resolveAdapter(assistantKind);

    return adapter.getTranscript(
      workspace,
      String(payload.threadId),
      payload.cursor ? String(payload.cursor) : undefined,
      payload.limit ? Number(payload.limit) : 20
    );
  }

  private buildQueuedJob(
    action: QueuedJob["action"],
    requestId: string,
    payload: Record<string, unknown>
  ): QueuedJob {
    const workspace = this.resolveWorkspace(String(payload.workspaceId));
    const assistantKind = this.requireAssistantKind(payload.assistantKind);

    return {
      requestId,
      action,
      workspaceId: workspace.id,
      assistantKind,
      prompt: String(payload.prompt ?? ""),
      threadId: action === "send_to_thread" ? String(payload.threadId) : undefined,
      cwd: payload.cwd ? String(payload.cwd) : undefined,
      attachments: this.parseAttachments(payload.attachments),
      createdAt: nowIso()
    };
  }

  private listDirectory(payload: Record<string, unknown>) {
    const workspace = this.resolveWorkspace(String(payload.workspaceId));
    return listWorkspaceDirectory(workspace, payload.path ? String(payload.path) : ".");
  }

  private readFile(payload: Record<string, unknown>) {
    const workspace = this.resolveWorkspace(String(payload.workspaceId));
    return readWorkspaceFile(workspace, String(payload.path));
  }

  private parseAttachments(value: unknown): AttachmentMeta[] {
    return Array.isArray(value) ? (value as AttachmentMeta[]) : [];
  }

  private sendResponse(envelope: ResponseEnvelope): void {
    this.socket?.send(JSON.stringify(envelope));
  }

  private emitEvent(requestId: string | undefined, event: AgentEvent): void {
    const envelope: AgentEventEnvelope = {
      kind: "event",
      requestId,
      event
    };
    this.socket?.send(JSON.stringify(envelope));
  }

  private resolveWorkspace(workspaceId: string): WorkspaceConfig {
    const workspace = this.config.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    return workspace;
  }

  private resolveAdapter(kind: AssistantKind): AssistantAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new Error(`Assistant adapter unavailable: ${kind}`);
    }

    return adapter;
  }

  private requireAssistantKind(value: unknown): AssistantKind {
    if (value === "codex") {
      return value;
    }

    throw new Error(`Unsupported assistant kind: ${String(value ?? "")}`);
  }

  private runtimeKey(assistantKind: AssistantKind, threadId: string): string {
    return `${assistantKind}:${threadId}`;
  }
}
