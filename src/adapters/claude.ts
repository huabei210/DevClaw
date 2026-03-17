import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";

import { AssistantAdapter, ContinueThreadInput, CreateThreadInput, paginateTranscript, StreamEventHandler } from "./base";
import { buildPromptWithAttachments, materializeAttachments } from "./attachment-utils";
import { ensureInsideWorkspace } from "../shared/fs-utils";
import { shouldSpawnDetachedForCleanup, terminateChildProcessTree } from "../shared/process-control";
import { resolveClaudeCommand } from "../shared/process-utils";
import { stripInjectedPromptPreamble } from "../shared/transcript";
import { ThreadSummary, TranscriptItem, WorkspaceConfig } from "../shared/types";
import { nowIso, safeJsonParse, truncateText } from "../shared/utils";

type ClaudeMessage = {
  role?: string;
  content?: unknown;
};

type ClaudeSessionRecord = {
  type?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  session_id?: string;
  message?: ClaudeMessage;
};

type ClaudeStreamRecord = {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: ClaudeMessage;
  result?: string;
  is_error?: boolean;
};

interface ClaudeSessionData {
  threadId: string;
  cwd: string;
  filePath: string;
  updatedAt: string;
  transcript: TranscriptItem[];
  name: string;
  preview?: string;
}

interface ActiveClaudeRun {
  child: ChildProcessWithoutNullStreams;
  threadId?: string;
  cancelling: boolean;
}

function claudeProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

function findClaudeSessionFiles(rootPath: string): string[] {
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
        if (entry.name.toLowerCase() === "subagents") {
          continue;
        }
        stack.push(nextPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(nextPath);
      }
    }
  }

  return results;
}

function normalizePathForMatch(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWorkspaceMatch(workspace: WorkspaceConfig, cwd: string): boolean {
  const workspaceRoot = normalizePathForMatch(workspace.rootPath);
  const target = normalizePathForMatch(cwd);
  return target === workspaceRoot || target.startsWith(`${workspaceRoot}${path.sep}`);
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

function normalizeThreadName(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return truncateText(normalized || fallback, 80);
}

function pickPreferredThreadText(...candidates: Array<string | undefined>): string | undefined {
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

function extractClaudeContentText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const candidate = item as { type?: string; text?: string; content?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        return candidate.text;
      }

      if (candidate.type === "tool_result") {
        return extractClaudeContentText(candidate.content);
      }

      return [];
    })
    .join("\n")
    .trim();
}

function parseClaudeTranscript(filePath: string): ClaudeSessionData | undefined {
  const threadIdFallback = path.basename(filePath, ".jsonl");
  let threadId = threadIdFallback;
  let cwd: string | undefined;
  let updatedAt = fs.statSync(filePath).mtime.toISOString();
  let preview: string | undefined;
  let preferredUserText: string | undefined;
  const transcript: TranscriptItem[] = [];

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const parsed = safeJsonParse<ClaudeSessionRecord>(line);
    if (!parsed) {
      continue;
    }

    threadId = parsed.sessionId ?? parsed.session_id ?? threadId;
    cwd = parsed.cwd ?? cwd;
    updatedAt = parsed.timestamp ?? updatedAt;

    if (parsed.type !== "user" && parsed.type !== "assistant") {
      continue;
    }

    const role = parsed.message?.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const text = role === "user"
      ? stripInjectedPromptPreamble(extractClaudeContentText(parsed.message?.content))
      : extractClaudeContentText(parsed.message?.content);
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

    preview = pickPreferredThreadText(text, preview) ?? preview;
    if (role === "user" && !preferredUserText && !isBootstrapThreadText(text)) {
      preferredUserText = text;
    }
  }

  if (!cwd) {
    return undefined;
  }

  const name = normalizeThreadName(pickPreferredThreadText(preferredUserText, preview), threadId);
  return {
    threadId,
    cwd,
    filePath,
    updatedAt,
    transcript,
    name,
    preview: preview ? truncateText(preview, 120) : undefined
  };
}

function findClaudeSessionByThreadId(threadId: string): ClaudeSessionData | undefined {
  for (const filePath of findClaudeSessionFiles(claudeProjectsRoot())) {
    const session = parseClaudeTranscript(filePath);
    if (session?.threadId === threadId) {
      return session;
    }
  }

  return undefined;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

export class ClaudeAdapter implements AssistantAdapter {
  readonly kind = "claude" as const;
  private readonly activeRuns = new Set<ActiveClaudeRun>();
  private readonly activeRunsByThreadId = new Map<string, ActiveClaudeRun>();

  constructor(
    private readonly claudePath: string,
    private readonly gatewayUrl?: string,
    private readonly deviceToken?: string
  ) {}

  async listThreads(workspace: WorkspaceConfig): Promise<ThreadSummary[]> {
    const items = findClaudeSessionFiles(claudeProjectsRoot())
      .map((filePath) => parseClaudeTranscript(filePath))
      .filter((session): session is ClaudeSessionData => Boolean(session))
      .filter((session) => isWorkspaceMatch(workspace, session.cwd))
      .map<ThreadSummary>((session) => ({
        threadId: session.threadId,
        workspaceId: workspace.id,
        assistantKind: this.kind,
        name: session.name,
        updatedAt: session.updatedAt,
        cwd: session.cwd,
        status: "idle",
        source: "claude-session-file",
        preview: session.preview
      }));

    items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return items;
  }

  async getTranscript(workspace: WorkspaceConfig, threadId: string, cursor?: string, limit = 20) {
    const session = findClaudeSessionByThreadId(threadId);
    if (!session || !isWorkspaceMatch(workspace, session.cwd)) {
      throw new Error(`Thread not found in workspace: ${threadId}`);
    }

    return paginateTranscript(session.transcript, cursor, limit);
  }

  async createThread(input: CreateThreadInput, onEvent: StreamEventHandler): Promise<void> {
    await this.runClaude(undefined, input, onEvent);
  }

  async continueThread(input: ContinueThreadInput, onEvent: StreamEventHandler): Promise<void> {
    await this.runClaude(input.threadId, input, onEvent);
  }

  async cancelActiveRun(threadId?: string): Promise<void> {
    const runs = threadId
      ? [this.activeRunsByThreadId.get(threadId)].filter((run): run is ActiveClaudeRun => Boolean(run))
      : Array.from(this.activeRuns);

    await Promise.all(
      runs.map(async (run) => {
        run.cancelling = true;
        await terminateChildProcessTree(run.child);
      })
    );
  }

  private async runClaude(
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
    const prompt = buildPromptWithAttachments(input.prompt, preparedAttachments);
    const launch = resolveClaudeCommand(this.claudePath, { cwd });
    const args = [
      ...launch.args,
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions"
    ];

    if (threadId) {
      args.push("-r", threadId);
    }

    onEvent({
      type: "run.state",
      state: "running"
    });

    const child = spawn(launch.command, args, {
      cwd,
      env: process.env,
      detached: shouldSpawnDetachedForCleanup(),
      windowsHide: true
    });
    const stdout = readline.createInterface({ input: child.stdout });
    const stderr = readline.createInterface({ input: child.stderr });
    const finished = createDeferred<void>();
    const activeRun: ActiveClaudeRun = {
      child,
      threadId,
      cancelling: false
    };
    this.activeRuns.add(activeRun);
    if (threadId) {
      this.activeRunsByThreadId.set(threadId, activeRun);
    }
    let activeThreadId = threadId;
    let threadCreatedEmitted = Boolean(threadId);
    let terminalStateEmitted = false;
    let lastAssistantText: string | undefined;

    const emitFailure = (message: string) => {
      onEvent({
        type: "run.output",
        stream: "error",
        text: message
      });
      onEvent({
        type: "run.state",
        state: "failed"
      });
      terminalStateEmitted = true;
    };

    const emitCancelled = () => {
      onEvent({
        type: "run.state",
        state: "cancelled"
      });
      terminalStateEmitted = true;
    };

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
      if (!threadCreatedEmitted) {
        threadCreatedEmitted = true;
        onEvent({
          type: "thread.created",
          threadId: candidateThreadId
        });
      }
    };

    stdout.on("line", (line) => {
      const parsed = safeJsonParse<ClaudeStreamRecord>(line);
      if (!parsed) {
        return;
      }

      if (parsed.type === "system" && parsed.subtype === "init") {
        registerThread(parsed.session_id);
        return;
      }

      if (parsed.type === "assistant") {
        registerThread(parsed.session_id);
        const text = extractClaudeContentText(parsed.message?.content);
        if (text && text !== lastAssistantText) {
          lastAssistantText = text;
          onEvent({
            type: "run.output",
            stream: "text",
            text
          });
        }
        return;
      }

      if (parsed.type === "result") {
        registerThread(parsed.session_id);
        if (parsed.is_error || parsed.subtype === "error") {
          emitFailure(parsed.result?.trim() || "Claude run failed");
          return;
        }

        if (!terminalStateEmitted) {
          onEvent({
            type: "run.state",
            state: "completed"
          });
          terminalStateEmitted = true;
        }
      }
    });

    stderr.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      onEvent({
        type: "run.output",
        stream: "error",
        text: line
      });
    });

    child.once("error", (error) => {
      if (!terminalStateEmitted) {
        if (activeRun.cancelling) {
          emitCancelled();
        } else {
          emitFailure(error.message);
        }
      }
      finished.resolve();
    });

    child.once("close", (code, signal) => {
      stdout.close();
      stderr.close();

      if (!terminalStateEmitted) {
        if (activeRun.cancelling || signal === "SIGTERM" || signal === "SIGKILL") {
          emitCancelled();
        } else if (code === 0) {
          onEvent({
            type: "run.state",
            state: "completed"
          });
          terminalStateEmitted = true;
        } else {
          emitFailure(`Claude exited unexpectedly (code=${String(code)}, signal=${String(signal)})`);
        }
      }

      finished.resolve();
    });

    try {
      await finished.promise;
    } finally {
      if (activeThreadId) {
        this.activeRunsByThreadId.delete(activeThreadId);
      }
      this.activeRuns.delete(activeRun);
    }
  }
}
