export type AssistantKind = "codex" | "claude";
export type CodexAppServerReuseScope = "workspace" | "global";

export type ThreadStatus =
  | "idle"
  | "queued"
  | "running"
  | "blocked"
  | "error"
  | "offline";

export type CommandAction =
  | "list_workspaces"
  | "list_threads"
  | "open_thread"
  | "switch_thread"
  | "create_thread"
  | "send_to_thread"
  | "cancel_run"
  | "list_dir"
  | "read_file"
  | "upload_attachment";

export type RunState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type FsNodeType = "file" | "directory";

export type AttachmentKind = "image" | "file";

export interface WorkspaceConfig {
  id: string;
  name: string;
  rootPath: string;
  assistants: AssistantKind[];
  defaultAssistant: AssistantKind;
}

export interface GatewayDeviceConfig {
  id: string;
  name: string;
  token: string;
}

export interface FeishuConfig {
  enabled: boolean;
  interactiveCardsEnabled: boolean;
  appId: string;
  appSecret: string;
  encryptKey: string;
  verificationToken: string;
  allowChatIds: string[];
  notificationChatIds: string[];
}

export interface GatewayConfig {
  host: string;
  port: number;
  baseUrl: string;
  dataDir: string;
  devices: GatewayDeviceConfig[];
  feishu: FeishuConfig;
}

export interface AgentConfig {
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  gatewayUrl: string;
  dataDir: string;
  maxQueuedJobs: number;
  codexPath: string;
  claudePath: string;
  codexAppServerUrl?: string;
  codexAppServerReuseScope: CodexAppServerReuseScope;
  workspaces: WorkspaceConfig[];
}

export interface TargetRef {
  deviceId: string;
  workspaceId: string;
  assistantKind: AssistantKind;
  threadId: string;
  threadName?: string;
}

export interface PendingCreateThreadState {
  deviceId: string;
  workspaceId: string;
  assistantKind: AssistantKind;
  cwd?: string;
}

export interface ConversationState {
  conversationId: string;
  currentTarget?: TargetRef;
  pendingCreateThread?: PendingCreateThreadState;
  updatedAt: string;
}

export interface ThreadSummary {
  threadId: string;
  workspaceId: string;
  assistantKind: AssistantKind;
  name: string;
  updatedAt: string;
  cwd: string;
  status: ThreadStatus;
  source: string;
  preview?: string;
  queuePosition?: number;
}

export interface TranscriptItem {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  timestamp: string;
  rawType?: string;
}

export interface TranscriptPage {
  items: TranscriptItem[];
  nextCursor?: string;
}

export interface FsNode {
  path: string;
  name: string;
  type: FsNodeType;
  size?: number;
  modifiedAt: string;
  mimeType?: string;
}

export interface ReadFileResult {
  path: string;
  mimeType: string;
  size: number;
  encoding: "utf8" | "binary";
  content?: string;
  base64Content?: string;
  isBinary: boolean;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string;
  size: number;
  storedPath: string;
  createdAt: string;
  source: "rest" | "feishu";
}

export interface QueuedJob {
  requestId: string;
  action: "create_thread" | "send_to_thread";
  workspaceId: string;
  assistantKind: AssistantKind;
  prompt: string;
  threadId?: string;
  cwd?: string;
  attachments: AttachmentMeta[];
  createdAt: string;
}

export interface AgentHelloEnvelope {
  kind: "hello";
  deviceId: string;
  deviceName: string;
  workspaces: WorkspaceConfig[];
  capabilities: string[];
}

export interface CommandEnvelope<T = unknown> {
  kind: "command";
  requestId: string;
  action: CommandAction;
  payload: T;
}

export interface ResponseEnvelope<T = unknown> {
  kind: "response";
  requestId: string;
  ok: boolean;
  data?: T;
  error?: string;
}

export interface AgentEventEnvelope {
  kind: "event";
  requestId?: string;
  event: AgentEvent;
}

export type WireEnvelope =
  | AgentHelloEnvelope
  | CommandEnvelope
  | ResponseEnvelope
  | AgentEventEnvelope;

export type AgentEvent =
  | {
      type: "agent.online";
      deviceId: string;
      deviceName: string;
      ts: string;
    }
  | {
      type: "thread.created";
      deviceId: string;
      workspaceId: string;
      assistantKind: AssistantKind;
      threadId: string;
      ts: string;
    }
  | {
      type: "run.state";
      deviceId: string;
      workspaceId: string;
      assistantKind: AssistantKind;
      threadId?: string;
      state: RunState;
      queuePosition?: number;
      message?: string;
      ts: string;
    }
  | {
      type: "run.output";
      deviceId: string;
      workspaceId: string;
      assistantKind: AssistantKind;
      threadId?: string;
      stream: "text" | "tool" | "raw" | "error";
      text?: string;
      command?: string;
      status?: string;
      payload?: unknown;
      ts: string;
    };
