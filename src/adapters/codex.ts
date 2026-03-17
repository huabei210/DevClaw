import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline, { Interface } from "node:readline";
import WebSocket from "ws";

import { buildPromptWithAttachments, materializeAttachments } from "./attachment-utils";
import { AssistantAdapter, ContinueThreadInput, CreateThreadInput, paginateTranscript, StreamEventHandler } from "./base";
import {
  AttachmentMeta,
  CodexAppServerReuseScope,
  ThreadStatus,
  ThreadSummary,
  TranscriptItem,
  WorkspaceConfig
} from "../shared/types";
import { ensureInsideWorkspace } from "../shared/fs-utils";
import { shouldSpawnDetachedForCleanup, terminateChildProcessTree } from "../shared/process-control";
import { resolveCodexCommand } from "../shared/process-utils";
import { stripInjectedPromptPreamble } from "../shared/transcript";
import { nowIso, safeJsonParse, truncateText } from "../shared/utils";

type CodexSessionIndexRow = {
  id: string;
  thread_name?: string;
  updated_at?: string;
};

type CodexSessionMeta = {
  payload?: {
    id?: string;
    cwd?: string;
    timestamp?: string;
  };
};

interface SessionFileEntry {
  threadId: string;
  cwd: string;
  filePath: string;
  updatedAt: string;
}

type AppServerThreadStatus = {
  type?: string;
  activeFlags?: string[];
};

type AppServerThreadSource =
  | string
  | {
      subAgent?: string | { thread_spawn?: unknown; other?: string };
    };

type AppServerThreadItem = {
  id?: string;
  type?: string;
  text?: string;
  phase?: string | null;
  command?: string;
  status?: string;
  content?: unknown[];
};

type AppServerTurn = {
  id: string;
  status: string;
  error?: {
    message?: string;
  } | null;
  items: AppServerThreadItem[];
};

type AppServerThread = {
  id: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: AppServerThreadStatus;
  path?: string | null;
  cwd: string;
  source: AppServerThreadSource;
  name?: string | null;
  turns: AppServerTurn[];
};

type AppServerThreadListResponse = {
  data: AppServerThread[];
  nextCursor?: string | null;
};

type AppServerThreadReadResponse = {
  thread: AppServerThread;
};

type AppServerThreadStartResponse = {
  thread: AppServerThread;
};

type AppServerTurnStartResponse = {
  turn: AppServerTurn;
};

interface PendingRpcRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface CodexRpcClient {
  readonly closed: Promise<void>;
  setNotificationHandler(handler: ((method: string, params: unknown) => void) | undefined): void;
  start(): Promise<void>;
  request<T>(method: string, params?: unknown): Promise<T>;
  close(): Promise<void>;
}

interface CodexAppServerConnectionOptions {
  url?: string;
  reuseScope?: CodexAppServerReuseScope;
}

interface ActiveCodexRun {
  workspaceRoot: string;
  client?: CodexRpcClient;
  threadId?: string;
  cancelling: boolean;
}

const APP_SERVER_REQUEST_TIMEOUT_MS = 20_000;
const APP_SERVER_CLOSE_TIMEOUT_MS = 1_000;
const APP_SERVER_DIAGNOSTIC_LIMIT = 20;
const APP_SERVER_PAGE_LIMIT = 100;

class CodexAppServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerUnavailableError";
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve,
    reject
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codexHome(): string {
  return path.join(os.homedir(), ".codex");
}

function sessionIndexPath(): string {
  return path.join(codexHome(), "session_index.jsonl");
}

function sessionsRootPath(): string {
  return path.join(codexHome(), "sessions");
}

function findAllJsonlFiles(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const stack = [rootPath];
  const results: string[] = [];

  while (stack.length > 0) {
    const currentPath = stack.pop()!;
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const nextPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(nextPath);
      }
    }
  }

  return results;
}

function readFirstLine(filePath: string): string | undefined {
  const content = fs.readFileSync(filePath, "utf8");
  return content.split(/\r?\n/, 1)[0];
}

function buildSessionFileMap(): Map<string, SessionFileEntry> {
  const entries = new Map<string, SessionFileEntry>();
  for (const filePath of findAllJsonlFiles(sessionsRootPath())) {
    const firstLine = readFirstLine(filePath);
    if (!firstLine) {
      continue;
    }

    const parsed = safeJsonParse<CodexSessionMeta>(firstLine);
    const threadId = parsed?.payload?.id;
    const cwd = parsed?.payload?.cwd;
    if (!threadId || !cwd) {
      continue;
    }

    entries.set(threadId, {
      threadId,
      cwd,
      filePath,
      updatedAt: fs.statSync(filePath).mtime.toISOString()
    });
  }

  return entries;
}

function readSessionIndexRows(): CodexSessionIndexRow[] {
  if (!fs.existsSync(sessionIndexPath())) {
    return [];
  }

  return fs
    .readFileSync(sessionIndexPath(), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => safeJsonParse<CodexSessionIndexRow>(line))
    .filter((row): row is CodexSessionIndexRow => Boolean(row?.id));
}

function normalizeThreadName(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return truncateText(normalized || fallback, 80);
}

function isBootstrapThreadText(value: string | undefined): boolean {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  return (
    normalized.startsWith("# AGENTS.md instructions for ") ||
    normalized.includes("<INSTRUCTIONS>") ||
    normalized.includes("<environment_context>")
  );
}

function findPreferredMessageText(filePath: string, role: "user" | "assistant"): string | undefined {
  let fallback: string | undefined;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const parsed = safeJsonParse<{
      type?: string;
      payload?: {
        type?: string;
        role?: string;
        content?: unknown[];
      };
    }>(line);

    if (parsed?.type !== "response_item" || parsed.payload?.type !== "message" || parsed.payload.role !== role) {
      continue;
    }

    const text = extractMessageText(parsed.payload.content ?? []);
    if (text) {
      if (!fallback) {
        fallback = text;
      }

      if (!isBootstrapThreadText(text)) {
        return text;
      }
    }
  }

  return fallback;
}

export function deriveCodexThreadName(prompt: string, fallback: string): string {
  return normalizeThreadName(prompt, fallback);
}

export function upsertCodexSessionIndexRow(entry: CodexSessionIndexRow): void {
  const targetPath = sessionIndexPath();
  const nextEntry = {
    id: entry.id,
    thread_name: normalizeThreadName(entry.thread_name, entry.id),
    updated_at: entry.updated_at ?? nowIso()
  } satisfies CodexSessionIndexRow;
  const nextLine = JSON.stringify(nextEntry);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, `${nextLine}${os.EOL}`, "utf8");
    return;
  }

  const lines = fs
    .readFileSync(targetPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  let replaced = false;
  const mergedLines = lines.flatMap((line) => {
    const parsed = safeJsonParse<CodexSessionIndexRow>(line);
    if (parsed?.id !== nextEntry.id) {
      return [line];
    }

    if (replaced) {
      return [];
    }

    const existingName = typeof parsed.thread_name === "string" ? parsed.thread_name.trim() : "";
    const mergedEntry = {
      id: nextEntry.id,
      thread_name: normalizeThreadName(
        existingName && existingName !== parsed.id && !isBootstrapThreadText(existingName)
          ? existingName
          : nextEntry.thread_name,
        nextEntry.id
      ),
      updated_at: nextEntry.updated_at
    } satisfies CodexSessionIndexRow;

    replaced = true;
    return [JSON.stringify(mergedEntry)];
  });

  if (!replaced) {
    mergedLines.push(nextLine);
  }

  fs.writeFileSync(targetPath, `${mergedLines.join(os.EOL)}${os.EOL}`, "utf8");
}

function extractMessageText(content: unknown[]): string {
  return content
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const candidate = item as { text?: string; type?: string };
      if (candidate.type === "input_text" || candidate.type === "output_text" || candidate.type === "text") {
        return candidate.text ?? "";
      }

      return [];
    })
    .join("\n")
    .trim();
}

function parseTranscript(filePath: string): TranscriptItem[] {
  const transcript: TranscriptItem[] = [];

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const parsed = safeJsonParse<{
      timestamp?: string;
      type?: string;
      payload?: {
        type?: string;
        role?: string;
        content?: unknown[];
      };
    }>(line);

    if (parsed?.type !== "response_item" || parsed.payload?.type !== "message") {
      continue;
    }

    const role = parsed.payload.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const text = stripInjectedPromptPreamble(extractMessageText(parsed.payload.content ?? []));
    if (!text) {
      continue;
    }

    transcript.push({
      id: `${role}_${transcript.length + 1}`,
      role,
      text,
      timestamp: parsed.timestamp ?? nowIso(),
      rawType: parsed.type
    });
  }

  return transcript;
}

function stripWindowsLongPathPrefix(value: string): string {
  return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

function normalizeCodexPath(value: string): string {
  return stripWindowsLongPathPrefix(value);
}

function normalizePathForMatch(value: string): string {
  const resolved = path.resolve(normalizeCodexPath(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWorkspaceMatch(workspace: WorkspaceConfig, cwd: string): boolean {
  const workspaceRoot = normalizePathForMatch(workspace.rootPath);
  const target = normalizePathForMatch(cwd);
  return target === workspaceRoot || target.startsWith(`${workspaceRoot}${path.sep}`);
}

function toIsoFromUnixSeconds(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return nowIso();
  }

  return new Date(value * 1000).toISOString();
}

function mapAppServerThreadStatus(status: AppServerThreadStatus | undefined): ThreadStatus {
  if (!status || typeof status !== "object") {
    return "idle";
  }

  switch (status.type) {
    case "active":
      return status.activeFlags?.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput")
        ? "blocked"
        : "running";
    case "systemError":
      return "error";
    case "idle":
    case "notLoaded":
    default:
      return "idle";
  }
}

function mapAppServerThreadSource(source: AppServerThreadSource | undefined): string {
  if (!source) {
    return "unknown";
  }

  if (typeof source === "string") {
    return source;
  }

  const subAgent = source.subAgent;
  if (typeof subAgent === "string") {
    return `subAgent:${subAgent}`;
  }

  if (subAgent && typeof subAgent === "object") {
    if ("thread_spawn" in subAgent) {
      return "subAgent:thread_spawn";
    }

    if (typeof subAgent.other === "string" && subAgent.other.trim()) {
      return `subAgent:${subAgent.other}`;
    }
  }

  return "unknown";
}

function isExecThreadSource(source: AppServerThreadSource | undefined): boolean {
  return source === "exec";
}

function pickPreferredThreadText(...candidates: Array<string | null | undefined>): string | undefined {
  let fallback: string | undefined;

  for (const candidate of candidates) {
    const normalized = (candidate ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) {
      continue;
    }

    if (!fallback) {
      fallback = normalized;
    }

    if (!isBootstrapThreadText(normalized)) {
      return normalized;
    }
  }

  return fallback;
}

function resolveAppServerThreadName(thread: AppServerThread, sessionIndexRow: CodexSessionIndexRow | undefined): string {
  const normalizedPath = thread.path ? normalizeCodexPath(thread.path) : undefined;
  const preferredUserText = normalizedPath && fs.existsSync(normalizedPath)
    ? findPreferredMessageText(normalizedPath, "user")
    : undefined;

  const preferred = pickPreferredThreadText(thread.name, sessionIndexRow?.thread_name, preferredUserText, thread.preview);
  return normalizeThreadName(preferred, thread.id);
}

function flattenTurnUserInput(content: unknown[]): string {
  return content
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const candidate = item as {
        type?: string;
        text?: string;
        path?: string;
        url?: string;
        name?: string;
      };

      switch (candidate.type) {
        case "text":
          return candidate.text ?? "";
        case "localImage":
          return candidate.path ? `[image] ${candidate.path}` : "[image]";
        case "image":
          return candidate.url ? `[image] ${candidate.url}` : "[image]";
        case "skill":
          return candidate.name ? `[skill] ${candidate.name}` : "[skill]";
        case "mention":
          return candidate.name ? `@${candidate.name}` : "@mention";
        default:
          return [];
      }
    })
    .join("\n")
    .trim();
}

function mapThreadTurnsToTranscript(thread: AppServerThread): TranscriptItem[] {
  const turns = thread.turns ?? [];
  if (turns.length === 0) {
    return [];
  }

  const startMs = thread.createdAt * 1000;
  const endMs = Math.max(startMs, thread.updatedAt * 1000);
  const step = turns.length > 1 ? (endMs - startMs) / (turns.length - 1) : 0;
  const transcript: TranscriptItem[] = [];

  turns.forEach((turn, turnIndex) => {
    const timestamp = new Date(startMs + step * turnIndex).toISOString();
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = stripInjectedPromptPreamble(flattenTurnUserInput(item.content ?? []));
        if (text) {
          transcript.push({
            id: item.id ?? `user_${transcript.length + 1}`,
            role: "user",
            text,
            timestamp,
            rawType: item.type
          });
        }
        continue;
      }

      if (item.type === "agentMessage") {
        const text = (item.text ?? "").trim();
        if (text) {
          transcript.push({
            id: item.id ?? `assistant_${transcript.length + 1}`,
            role: "assistant",
            text,
            timestamp,
            rawType: item.phase ? `${item.type}:${item.phase}` : item.type
          });
        }
      }
    }
  });

  return transcript;
}

function isAppServerUnavailableError(error: unknown): error is CodexAppServerUnavailableError {
  return error instanceof CodexAppServerUnavailableError;
}

class SpawnedCodexAppServerClient implements CodexRpcClient {
  private child?: ChildProcessWithoutNullStreams;
  private stdout?: Interface;
  private stderr?: Interface;
  private readonly pending = new Map<number, PendingRpcRequest>();
  private readonly diagnostics: string[] = [];
  private readonly closedDeferred = createDeferred<void>();
  private nextId = 1;
  private started = false;
  private closing = false;
  private notificationHandler?: (method: string, params: unknown) => void;

  constructor(
    private readonly codexPath: string,
    private readonly launchCwd: string
  ) {}

  get closed(): Promise<void> {
    return this.closedDeferred.promise;
  }

  setNotificationHandler(handler: ((method: string, params: unknown) => void) | undefined): void {
    this.notificationHandler = handler;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const launchCommand = resolveCodexCommand(this.codexPath);
    try {
      this.child = spawn(launchCommand.command, [...launchCommand.args, "app-server"], {
        cwd: this.launchCwd,
        env: process.env,
        detached: shouldSpawnDetachedForCleanup(),
        windowsHide: true
      });
    } catch (error) {
      throw this.createUnavailableError("Failed to launch codex app-server", error);
    }

    this.stdout = readline.createInterface({ input: this.child.stdout });
    this.stderr = readline.createInterface({ input: this.child.stderr });

    this.stdout.on("line", (line) => this.handleStdoutLine(line));
    this.stderr.on("line", (line) => {
      if (line.trim()) {
        this.pushDiagnostic(`stderr: ${line}`);
      }
    });

    this.child.once("error", (error) => {
      this.rejectAll(this.createUnavailableError("Codex app-server process error", error));
      this.closedDeferred.resolve();
    });

    this.child.once("close", (exitCode, signal) => {
      const error = this.closing
        ? undefined
        : this.createUnavailableError(
            `Codex app-server exited before the request completed (code=${String(exitCode)}, signal=${String(signal)})`
          );

      if (error) {
        this.rejectAll(error);
      }

      this.closedDeferred.resolve();
    });

    this.started = true;

    await this.request("initialize", {
      clientInfo: {
        name: "feishu-thread-bridge",
        version: "0.1.0"
      }
    });
    this.notify("initialized", {});
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.child || !this.started) {
      throw this.createUnavailableError(`Codex app-server is not ready for ${method}`);
    }

    if (!this.child.stdin.writable) {
      throw this.createUnavailableError(`Codex app-server stdin is not writable for ${method}`);
    }

    const id = this.nextId++;
    const deferred = createDeferred<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      deferred.reject(this.createUnavailableError(`Timed out waiting for ${method}`));
    }, APP_SERVER_REQUEST_TIMEOUT_MS);

    this.pending.set(id, {
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer
    });

    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + os.EOL);
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(id);
      throw this.createUnavailableError(`Failed to write ${method} to codex app-server`, error);
    }

    return (await deferred.promise) as T;
  }

  notify(method: string, params?: unknown): void {
    if (!this.child?.stdin.writable) {
      return;
    }

    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + os.EOL);
  }

  async close(): Promise<void> {
    if (!this.child) {
      return;
    }

    this.closing = true;

    try {
      this.child.stdin.end();
    } catch {
      // ignore shutdown errors
    }

    await Promise.race([this.closed, delay(APP_SERVER_CLOSE_TIMEOUT_MS)]);

    if (!hasChildExited(this.child)) {
      await terminateChildProcessTree(this.child);
      await Promise.race([this.closed, delay(APP_SERVER_CLOSE_TIMEOUT_MS)]);
    }

    this.stdout?.close();
    this.stderr?.close();
    this.child = undefined;
  }

  private handleStdoutLine(line: string): void {
    const message = safeJsonParse<{
      id?: number;
      result?: unknown;
      error?: {
        message?: string;
      };
      method?: string;
      params?: unknown;
    }>(line);

    if (!message) {
      this.pushDiagnostic(`stdout: ${line}`);
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(this.createUnavailableError(message.error.message ?? "Codex app-server request failed"));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      this.notificationHandler?.(message.method, message.params);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private pushDiagnostic(line: string): void {
    this.diagnostics.push(line);
    if (this.diagnostics.length > APP_SERVER_DIAGNOSTIC_LIMIT) {
      this.diagnostics.splice(0, this.diagnostics.length - APP_SERVER_DIAGNOSTIC_LIMIT);
    }
  }

  private createUnavailableError(message: string, cause?: unknown): CodexAppServerUnavailableError {
    const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : undefined;
    const diagnosticText = this.diagnostics.length > 0 ? `${os.EOL}${this.diagnostics.join(os.EOL)}` : "";
    return new CodexAppServerUnavailableError(
      causeText ? `${message}: ${causeText}${diagnosticText}` : `${message}${diagnosticText}`
    );
  }
}

function hasChildExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

class WebSocketCodexAppServerClient implements CodexRpcClient {
  private socket?: WebSocket;
  private readonly pending = new Map<number, PendingRpcRequest>();
  private readonly diagnostics: string[] = [];
  private readonly closedDeferred = createDeferred<void>();
  private nextId = 1;
  private started = false;
  private closing = false;
  private notificationHandler?: (method: string, params: unknown) => void;

  constructor(private readonly url: string) {}

  get closed(): Promise<void> {
    return this.closedDeferred.promise;
  }

  setNotificationHandler(handler: ((method: string, params: unknown) => void) | undefined): void {
    this.notificationHandler = handler;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.socket = new WebSocket(this.url);

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = this.socket!;
        const handleOpen = () => {
          socket.off("error", handleError);
          resolve();
        };
        const handleError = (error: Error) => {
          socket.off("open", handleOpen);
          reject(error);
        };

        socket.once("open", handleOpen);
        socket.once("error", handleError);
      });
    } catch (error) {
      throw this.createUnavailableError(`Failed to connect to codex app-server at ${this.url}`, error);
    }

    this.socket.on("message", (data) => this.handleMessage(data));
    this.socket.on("error", (error) => {
      this.rejectAll(this.createUnavailableError("Codex app-server WebSocket error", error));
      this.closedDeferred.resolve();
    });
    this.socket.on("close", () => {
      const error = this.closing ? undefined : this.createUnavailableError("Codex app-server WebSocket closed unexpectedly");
      if (error) {
        this.rejectAll(error);
      }
      this.closedDeferred.resolve();
    });

    this.started = true;

    await this.request("initialize", {
      clientInfo: {
        name: "feishu-thread-bridge",
        version: "0.1.0"
      }
    });
    this.notify("initialized", {});
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.socket || !this.started || this.socket.readyState !== WebSocket.OPEN) {
      throw this.createUnavailableError(`Codex app-server WebSocket is not ready for ${method}`);
    }

    const id = this.nextId++;
    const deferred = createDeferred<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      deferred.reject(this.createUnavailableError(`Timed out waiting for ${method}`));
    }, APP_SERVER_REQUEST_TIMEOUT_MS);

    this.pending.set(id, {
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer
    });

    try {
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(id);
      throw this.createUnavailableError(`Failed to write ${method} to codex app-server WebSocket`, error);
    }

    return (await deferred.promise) as T;
  }

  async close(): Promise<void> {
    if (!this.socket) {
      return;
    }

    this.closing = true;
    this.socket.close();
    await Promise.race([this.closed, delay(APP_SERVER_CLOSE_TIMEOUT_MS)]);
    this.socket = undefined;
  }

  private notify(method: string, params?: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private handleMessage(data: WebSocket.RawData): void {
    const text = typeof data === "string" ? data : data.toString("utf8");
    const message = safeJsonParse<{
      id?: number;
      result?: unknown;
      error?: {
        message?: string;
      };
      method?: string;
      params?: unknown;
    }>(text);

    if (!message) {
      this.pushDiagnostic(`ws: ${text}`);
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(this.createUnavailableError(message.error.message ?? "Codex app-server request failed"));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (typeof message.method === "string") {
      this.notificationHandler?.(message.method, message.params);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private pushDiagnostic(line: string): void {
    this.diagnostics.push(line);
    if (this.diagnostics.length > APP_SERVER_DIAGNOSTIC_LIMIT) {
      this.diagnostics.splice(0, this.diagnostics.length - APP_SERVER_DIAGNOSTIC_LIMIT);
    }
  }

  private createUnavailableError(message: string, cause?: unknown): CodexAppServerUnavailableError {
    const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : undefined;
    const diagnosticText = this.diagnostics.length > 0 ? `${os.EOL}${this.diagnostics.join(os.EOL)}` : "";
    return new CodexAppServerUnavailableError(
      causeText ? `${message}: ${causeText}${diagnosticText}` : `${message}${diagnosticText}`
    );
  }
}

export class CodexAdapter implements AssistantAdapter {
  readonly kind = "codex" as const;
  private readonly appServers = new Map<string, Promise<CodexRpcClient>>();
  private readonly activeRuns = new Set<ActiveCodexRun>();
  private readonly activeRunsByThreadId = new Map<string, ActiveCodexRun>();
  private readonly appServerUrl?: string;
  private readonly appServerReuseScope: CodexAppServerReuseScope;

  constructor(
    private readonly codexPath: string,
    private readonly gatewayUrl?: string,
    private readonly deviceToken?: string,
    options: CodexAppServerConnectionOptions = {}
  ) {
    this.appServerUrl = options.url;
    this.appServerReuseScope = options.reuseScope ?? "workspace";
  }

  async listThreads(workspace: WorkspaceConfig): Promise<ThreadSummary[]> {
    try {
      return await this.withCodexAppServer(workspace.rootPath, workspace.rootPath, async (client) => {
        const sessionIndex = new Map(readSessionIndexRows().map((row) => [row.id, row] as const));
        const threads = await this.listInteractiveThreads(client);

        const items = threads
          .filter((thread) => isWorkspaceMatch(workspace, thread.cwd))
          .map<ThreadSummary>((thread) => {
            const name = resolveAppServerThreadName(thread, sessionIndex.get(thread.id));
            return {
              threadId: thread.id,
              workspaceId: workspace.id,
              assistantKind: this.kind,
              name,
              updatedAt: toIsoFromUnixSeconds(thread.updatedAt),
              cwd: normalizeCodexPath(thread.cwd),
              status: mapAppServerThreadStatus(thread.status),
              source: mapAppServerThreadSource(thread.source),
              preview: truncateText(pickPreferredThreadText(thread.preview, name) ?? name, 120)
            } satisfies ThreadSummary;
          });

        items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        return items;
      });
    } catch (error) {
      if (!isAppServerUnavailableError(error)) {
        throw error;
      }

      return this.listThreadsFromSessionFiles(workspace);
    }
  }

  async getTranscript(
    workspace: WorkspaceConfig,
    threadId: string,
    cursor?: string,
    limit = 20
  ) {
    try {
      return await this.withCodexAppServer(workspace.rootPath, workspace.rootPath, async (client) => {
        const response = await client.request<AppServerThreadReadResponse>("thread/read", {
          threadId,
          includeTurns: true
        });
        const thread = response.thread;

        if (!isWorkspaceMatch(workspace, thread.cwd)) {
          throw new Error(`Thread not found in workspace: ${threadId}`);
        }

        const transcriptPath = thread.path ? normalizeCodexPath(thread.path) : undefined;
        if (transcriptPath && fs.existsSync(transcriptPath)) {
          return paginateTranscript(parseTranscript(transcriptPath), cursor, limit);
        }

        return paginateTranscript(mapThreadTurnsToTranscript(thread), cursor, limit);
      });
    } catch (error) {
      if (!isAppServerUnavailableError(error)) {
        throw error;
      }

      return this.getTranscriptFromSessionFiles(workspace, threadId, cursor, limit);
    }
  }

  async createThread(input: CreateThreadInput, onEvent: StreamEventHandler): Promise<void> {
    await this.runCodex(undefined, input, onEvent);
  }

  async continueThread(input: ContinueThreadInput, onEvent: StreamEventHandler): Promise<void> {
    await this.runCodex(input.threadId, input, onEvent);
  }

  async cancelActiveRun(threadId?: string): Promise<void> {
    const runs = threadId
      ? [this.activeRunsByThreadId.get(threadId)].filter((run): run is ActiveCodexRun => Boolean(run))
      : Array.from(this.activeRuns);

    await Promise.all(
      runs.map(async (run) => {
        run.cancelling = true;
        if (run.client) {
          await this.disposeCodexAppServer(run.workspaceRoot, run.client);
        }
      })
    );
  }

  private async withCodexAppServer<T>(
    workspaceRoot: string,
    launchCwd: string,
    execute: (client: CodexRpcClient) => Promise<T>
  ): Promise<T> {
    const client = await this.acquireCodexAppServer(workspaceRoot, launchCwd);
    try {
      return await execute(client);
    } catch (error) {
      if (isAppServerUnavailableError(error)) {
        await this.disposeCodexAppServer(workspaceRoot, client);
      }
      throw error;
    }
  }

  private async acquireCodexAppServer(workspaceRoot: string, launchCwd: string): Promise<CodexRpcClient> {
    const key = this.getAppServerKey(workspaceRoot);
    const existing = this.appServers.get(key);
    if (existing) {
      return await existing;
    }

    const clientPromise = (async () => {
      const client = this.createCodexAppServerClient(launchCwd);
      try {
        await client.start();
      } catch (error) {
        this.appServers.delete(key);
        throw error;
      }

      void client.closed.finally(() => {
        const current = this.appServers.get(key);
        if (current === clientPromise) {
          this.appServers.delete(key);
        }
      });

      return client;
    })();

    this.appServers.set(key, clientPromise);

    try {
      return await clientPromise;
    } finally {
      if (this.appServers.get(key) !== clientPromise) {
        void clientPromise.then((client) => client.close()).catch(() => {});
      }
    }
  }

  private async disposeCodexAppServer(workspaceRoot: string, client?: CodexRpcClient): Promise<void> {
    const key = this.getAppServerKey(workspaceRoot);
    const existing = this.appServers.get(key);
    if (!existing) {
      return;
    }

    this.appServers.delete(key);

    try {
      const activeClient = client ?? (await existing);
      await activeClient.close();
    } catch {
      // ignore shutdown errors while replacing a broken app-server
    }
  }

  private async getActiveCodexAppServer(workspaceRoot: string): Promise<CodexRpcClient | undefined> {
    const existing = this.appServers.get(this.getAppServerKey(workspaceRoot));
    if (!existing) {
      return undefined;
    }

    try {
      return await existing;
    } catch {
      return undefined;
    }
  }

  private getAppServerKey(workspaceRoot: string): string {
    return this.appServerReuseScope === "global" ? "__global__" : normalizePathForMatch(workspaceRoot);
  }

  private createCodexAppServerClient(launchCwd: string): CodexRpcClient {
    if (this.appServerUrl) {
      return new WebSocketCodexAppServerClient(this.appServerUrl);
    }

    return new SpawnedCodexAppServerClient(this.codexPath, launchCwd);
  }

  private async listInteractiveThreads(client: CodexRpcClient): Promise<AppServerThread[]> {
    const threads: AppServerThread[] = [];
    let cursor: string | undefined;

    do {
      const response = await client.request<AppServerThreadListResponse>("thread/list", {
        sortKey: "updated_at",
        limit: APP_SERVER_PAGE_LIMIT,
        cursor
      });

      threads.push(...(response.data ?? []));
      cursor = response.nextCursor ?? undefined;
    } while (cursor);

    return threads;
  }

  private listThreadsFromSessionFiles(workspace: WorkspaceConfig): ThreadSummary[] {
    const sessionFiles = buildSessionFileMap();
    const sessionIndex = new Map(readSessionIndexRows().map((row) => [row.id, row] as const));

    const items = Array.from(sessionFiles.values())
      .filter((sessionFile) => isWorkspaceMatch(workspace, sessionFile.cwd))
      .map<ThreadSummary>((sessionFile) => {
        const sessionIndexRow = sessionIndex.get(sessionFile.threadId);
        const name = sessionIndexRow?.thread_name
          ? normalizeThreadName(sessionIndexRow.thread_name, sessionFile.threadId)
          : normalizeThreadName(findPreferredMessageText(sessionFile.filePath, "user"), sessionFile.threadId);

        return {
          threadId: sessionFile.threadId,
          workspaceId: workspace.id,
          assistantKind: this.kind,
          name,
          updatedAt: sessionIndexRow?.updated_at || sessionFile.updatedAt || nowIso(),
          cwd: normalizeCodexPath(sessionFile.cwd),
          status: "idle",
          source: sessionIndexRow ? "codex-session-index" : "codex-session-file",
          preview: truncateText(name, 120)
        } satisfies ThreadSummary;
      });

    items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return items;
  }

  private getTranscriptFromSessionFiles(
    workspace: WorkspaceConfig,
    threadId: string,
    cursor?: string,
    limit = 20
  ) {
    const sessionFiles = buildSessionFileMap();
    const sessionFile = sessionFiles.get(threadId);

    if (!sessionFile || !isWorkspaceMatch(workspace, sessionFile.cwd)) {
      throw new Error(`Thread not found in workspace: ${threadId}`);
    }

    return paginateTranscript(parseTranscript(sessionFile.filePath), cursor, limit);
  }

  private async runCodex(
    threadId: string | undefined,
    input: CreateThreadInput | ContinueThreadInput,
    onEvent: StreamEventHandler
  ): Promise<void> {
    const preparedAttachments = await materializeAttachments(
      input.workspace,
      input.attachments,
      this.gatewayUrl,
      this.deviceToken
    );
    const cwd = input.cwd ? ensureInsideWorkspace(input.workspace, input.cwd) : input.workspace.rootPath;
    const turnInput = this.buildTurnInput(input.prompt, preparedAttachments);
    let activeThreadId = threadId;
    const shouldEmitCreated = !threadId;
    let threadCreatedEmitted = !shouldEmitCreated;
    let terminalStateEmitted = false;
    const turnCompleted = createDeferred<void>();
    const activeRun: ActiveCodexRun = {
      workspaceRoot: input.workspace.rootPath,
      threadId,
      cancelling: false
    };
    this.activeRuns.add(activeRun);
    if (threadId) {
      this.activeRunsByThreadId.set(threadId, activeRun);
    }

    onEvent({
      type: "run.state",
      state: "running"
    });

    try {
      await this.withCodexAppServer(input.workspace.rootPath, cwd, async (client) => {
        activeRun.client = client;

        const registerThread = (candidateThreadId: string | undefined) => {
          if (!candidateThreadId) {
            return;
          }

          if (activeThreadId && activeThreadId !== candidateThreadId) {
            this.activeRunsByThreadId.delete(activeThreadId);
          }

          activeThreadId = candidateThreadId;
          activeRun.threadId = candidateThreadId;
          this.activeRunsByThreadId.set(candidateThreadId, activeRun);
        };

        client.setNotificationHandler((method, params) => {
          if (method === "thread/started") {
            const startedThreadId = (params as { thread?: { id?: string } } | undefined)?.thread?.id;
            registerThread(startedThreadId);

            if (shouldEmitCreated && startedThreadId && !threadCreatedEmitted) {
              threadCreatedEmitted = true;
              onEvent({
                type: "thread.created",
                threadId: startedThreadId
              });
            }
            return;
          }

          if (method === "item/started" || method === "item/completed") {
            this.handleItemNotification(params, method === "item/completed", onEvent);
            return;
          }

          if (method === "turn/completed") {
            const turn = (params as { turn?: AppServerTurn } | undefined)?.turn;
            if (!turn || terminalStateEmitted) {
              turnCompleted.resolve();
              return;
            }

            if (turn.status === "failed") {
              if (turn.error?.message) {
                onEvent({
                  type: "run.output",
                  stream: "error",
                  text: turn.error.message,
                  payload: params
                });
              }

              onEvent({
                type: "run.state",
                state: "failed"
              });
              terminalStateEmitted = true;
              turnCompleted.resolve();
              return;
            }

            onEvent({
              type: "run.state",
              state: turn.status === "interrupted" ? "cancelled" : "completed"
            });
            terminalStateEmitted = true;
            turnCompleted.resolve();
            return;
          }

          if (method === "error") {
            const message = (params as { message?: string } | undefined)?.message;
            if (message) {
              onEvent({
                type: "run.output",
                stream: "error",
                text: message,
                payload: params
              });
            }
          }
        });

        if (activeThreadId) {
          const existingThread = await client.request<AppServerThreadReadResponse>("thread/read", {
            threadId: activeThreadId
          });

          if (isExecThreadSource(existingThread.thread.source)) {
            const forked = await client.request<AppServerThreadStartResponse>("thread/fork", {
              threadId: activeThreadId,
              cwd,
              approvalPolicy: "never",
              sandbox: "danger-full-access"
            });
            registerThread(forked.thread.id);
            onEvent({
              type: "thread.created",
              threadId: activeThreadId
            });
          }

          const resumed = await client.request<AppServerThreadStartResponse>("thread/resume", {
            threadId: activeThreadId,
            cwd,
            approvalPolicy: "never",
            sandbox: "danger-full-access"
          });
          registerThread(resumed.thread.id);
        } else {
          const started = await client.request<AppServerThreadStartResponse>("thread/start", {
            cwd,
            approvalPolicy: "never",
            sandbox: "danger-full-access"
          });
          registerThread(started.thread.id);

          if (shouldEmitCreated && !threadCreatedEmitted) {
            threadCreatedEmitted = true;
            onEvent({
              type: "thread.created",
              threadId: started.thread.id
            });
          }
        }

        if (!activeThreadId) {
          throw new Error("Codex app-server did not provide a thread id");
        }

        const turnStart = await client.request<AppServerTurnStartResponse>("turn/start", {
          threadId: activeThreadId,
          input: turnInput,
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "dangerFullAccess"
          },
          cwd
        });
        if (turnStart.turn.status === "failed") {
          if (turnStart.turn.error?.message) {
            onEvent({
              type: "run.output",
              stream: "error",
              text: turnStart.turn.error.message,
              payload: turnStart
            });
          }

          onEvent({
            type: "run.state",
            state: "failed"
          });
          terminalStateEmitted = true;
          return;
        }

        if (turnStart.turn.status === "completed" || turnStart.turn.status === "interrupted") {
          onEvent({
            type: "run.state",
            state: turnStart.turn.status === "interrupted" ? "cancelled" : "completed"
          });
          terminalStateEmitted = true;
          return;
        }

        await Promise.race([
          turnCompleted.promise,
          client.closed.then(() => {
            if (!terminalStateEmitted) {
              throw new CodexAppServerUnavailableError("Codex app-server closed before the turn completed");
            }
          })
        ]);
      });
    } catch (error) {
      if (activeRun.cancelling) {
        if (!terminalStateEmitted) {
          onEvent({
            type: "run.state",
            state: "cancelled"
          });
          terminalStateEmitted = true;
        }
        return;
      }

      if (!terminalStateEmitted) {
        const message = error instanceof Error ? error.message : String(error);
        onEvent({
          type: "run.output",
          stream: "error",
          text: message
        });
        onEvent({
          type: "run.state",
          state: "failed"
        });
      }

      throw error;
    } finally {
      const client = await this.getActiveCodexAppServer(input.workspace.rootPath);
      client?.setNotificationHandler(undefined);
      if (activeThreadId) {
        this.activeRunsByThreadId.delete(activeThreadId);
      }
      this.activeRuns.delete(activeRun);
      if (activeThreadId) {
        upsertCodexSessionIndexRow({
          id: activeThreadId,
          thread_name: deriveCodexThreadName(input.prompt, activeThreadId),
          updated_at: nowIso()
        });
      }
    }
  }

  private buildTurnInput(prompt: string, attachments: AttachmentMeta[]): Array<Record<string, string>> {
    const fileAttachments = attachments.filter((attachment) => attachment.kind !== "image");
    const imageAttachments = attachments.filter((attachment) => attachment.kind === "image");

    return [
      {
        type: "text",
        text: buildPromptWithAttachments(prompt, fileAttachments)
      },
      ...imageAttachments.map((attachment) => ({
        type: "localImage",
        path: attachment.storedPath
      }))
    ];
  }

  private handleItemNotification(
    params: unknown,
    isCompleted: boolean,
    onEvent: StreamEventHandler
  ): void {
    const item = (params as { item?: AppServerThreadItem } | undefined)?.item;
    if (!item || typeof item !== "object") {
      return;
    }

    if (item.type === "commandExecution") {
      onEvent({
        type: "run.output",
        stream: "tool",
        command: typeof item.command === "string" ? item.command : undefined,
        status: typeof item.status === "string" ? item.status : isCompleted ? "completed" : "inProgress",
        payload: params
      });
      return;
    }

    if (item.type === "agentMessage" && isCompleted && typeof item.text === "string" && item.text.trim()) {
      onEvent({
        type: "run.output",
        stream: "text",
        text: item.text,
        payload: params
      });
    }
  }
}
