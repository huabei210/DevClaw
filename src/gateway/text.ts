import { formatTranscriptTimestamp } from "../shared/transcript";
import { truncateText } from "../shared/utils";
import { AssistantKind, ConversationState, TargetRef, ThreadSummary, TranscriptItem, WorkspaceConfig } from "../shared/types";

export interface HistoryArgs {
  pairLimit?: number;
  threadQuery?: string;
  compact: boolean;
  error?: string;
}

export interface ThreadsArgs {
  limit: number;
  assistantKind?: AssistantKind;
  threadQuery?: string;
  error?: string;
}

export const DEFAULT_THREADS_LIST_LIMIT = 4;
export const DEFAULT_HISTORY_PAIR_LIMIT = 6;
export const HISTORY_FETCH_PAGE_LIMIT = 200;
export const HISTORY_PREVIEW_TEXT_LIMIT = 30;
export const HISTORY_MESSAGE_MAX_LENGTH = 3000;
export const COMPACT_RECENT_EXCHANGE_LIMIT = 8;
export const COMPACT_EARLIER_EXCHANGE_LIMIT = 16;
export const COMPACT_SUMMARY_TEXT_LIMIT = 160;
export const COMPACT_RECENT_TEXT_LIMIT = 500;

export interface TranscriptStats {
  messageCount: number;
  exchangeCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  textChars: number;
  textBytes: number;
  estimatedTokens: number;
  lastTimestamp?: string;
  lastUserText?: string;
  lastAssistantText?: string;
}

export function formatThreadLabel(label: string): string {
  return `[${label}]`;
}

export function formatThreadStatusLabel(status: ThreadSummary["status"], queuePosition?: number): string {
  switch (status) {
    case "idle":
      return "空闲";
    case "queued":
      return queuePosition ? `排队中 (队列 ${queuePosition})` : "排队中";
    case "running":
      return "运行中";
    case "blocked":
      return "已阻塞";
    case "error":
      return "异常";
    case "offline":
      return "离线";
    default:
      return status;
  }
}

export function buildCommandProgressText(command: string): string | undefined {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  return `已运行 ${truncateText(normalized, 10)}`;
}

export function buildThreadListHeader(input: {
  title: string;
  workspaceId?: string;
  assistantKind?: AssistantKind;
  threadQuery?: string;
  totalThreads: number;
}): string {
  const lines: string[] = [];
  lines.push(input.title);
  if (input.workspaceId) {
    const filters = [input.assistantKind, input.threadQuery].filter(Boolean).join(" ");
    lines.push(
      `查看更多: /threads ${input.workspaceId}${filters ? ` ${filters}` : ""} ${input.totalThreads}`
    );
  }
  lines.push("复制任意一条消息的第一行即可切换。");
  return lines.join("\n");
}

export function buildThreadShortcutText(
  thread: Pick<ThreadSummary, "threadId" | "name" | "status" | "queuePosition" | "assistantKind">
): string {
  return [
    `/use ${thread.threadId}`,
    `标题: ${thread.name || thread.threadId}`,
    `assistant: ${thread.assistantKind}`,
    `状态: ${formatThreadStatusLabel(thread.status, thread.queuePosition)}`
  ].join("\n");
}

function buildThreadsUsageError(arg?: string): ThreadsArgs {
  const prefix = arg ? `无效参数: ${arg}\n\n` : "";
  return {
    limit: DEFAULT_THREADS_LIST_LIMIT,
    error:
      `${prefix}用法: /threads <workspaceId>\n` +
      "/threads <workspaceId> [count]\n" +
      "/threads <workspaceId> <keyword>\n" +
      "/threads <workspaceId> <assistantKind>\n" +
      "/threads <workspaceId> <assistantKind> [count]\n" +
      "/threads <workspaceId> <assistantKind> <keyword>\n" +
      "/threads <workspaceId> <assistantKind> [count] <keyword>"
  };
}

export function parseThreadsArgs(args: string[]): ThreadsArgs {
  let limit = DEFAULT_THREADS_LIST_LIMIT;
  let limitSet = false;
  let assistantKind: AssistantKind | undefined;
  const queryParts: string[] = [];

  for (const arg of args) {
    const normalized = arg.trim().toLowerCase();
    if (!normalized) {
      continue;
    }

    if (normalized === "codex" || normalized === "claude") {
      if (assistantKind) {
        return buildThreadsUsageError(arg);
      }

      assistantKind = normalized;
      continue;
    }

    const parsedCount = Number(normalized);
    if (Number.isInteger(parsedCount) && parsedCount > 0) {
      if (limitSet) {
        return buildThreadsUsageError(arg);
      }

      limit = parsedCount;
      limitSet = true;
      continue;
    }

    queryParts.push(arg.trim());
  }

  return {
    limit,
    assistantKind,
    threadQuery: queryParts.length > 0 ? queryParts.join(" ").trim() : undefined
  };
}

export function parseHistoryArgs(args: string[]): HistoryArgs {
  if (args.length === 0) {
    return { compact: false };
  }

  if (args.length > 3) {
    return {
      compact: false,
      error: "用法: /history\n/history [count]\n/history s\n/history <threadId> [count] [s]"
    };
  }

  let compact = false;
  let pairLimit: number | undefined;
  let threadQuery: string | undefined;

  for (const rawArg of args) {
    const arg = rawArg.trim();
    if (!arg) {
      continue;
    }

    if (arg.toLowerCase() === "s") {
      if (compact) {
        return {
          compact: false,
          error: "用法: /history\n/history [count]\n/history s\n/history <threadId> [count] [s]"
        };
      }

      compact = true;
      continue;
    }

    const parsed = parsePositiveInteger(arg);
    if (parsed !== undefined) {
      if (pairLimit !== undefined) {
        return {
          compact: false,
          error: "用法: /history\n/history [count]\n/history s\n/history <threadId> [count] [s]"
        };
      }

      pairLimit = parsed;
      continue;
    }

    if (threadQuery) {
      return {
        compact: false,
        error: "用法: /history\n/history [count]\n/history s\n/history <threadId> [count] [s]"
      };
    }

    threadQuery = arg;
  }

  return {
    compact,
    threadQuery,
    pairLimit
  };
}

export function parsePositiveInteger(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

export function groupTranscriptExchanges(items: TranscriptItem[]): TranscriptItem[][] {
  const exchanges: TranscriptItem[][] = [];

  for (const item of items) {
    const currentExchange = exchanges[exchanges.length - 1];
    if (item.role === "user" || !currentExchange) {
      exchanges.push([item]);
      continue;
    }

    currentExchange.push(item);
  }

  return exchanges;
}

function collectRoleText(items: TranscriptItem[], role: TranscriptItem["role"]): string {
  return items
    .filter((item) => item.role === role)
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n");
}

export function estimateTranscriptStats(items: TranscriptItem[]): TranscriptStats {
  const textChars = items.reduce((sum, item) => sum + item.text.length, 0);
  const textBytes = items.reduce((sum, item) => sum + Buffer.byteLength(item.text, "utf8"), 0);
  const userMessages = items.filter((item) => item.role === "user");
  const assistantMessages = items.filter((item) => item.role === "assistant");

  return {
    messageCount: items.length,
    exchangeCount: groupTranscriptExchanges(items).length,
    userMessageCount: userMessages.length,
    assistantMessageCount: assistantMessages.length,
    textChars,
    textBytes,
    estimatedTokens: Math.max(0, Math.ceil(textBytes / 4)),
    lastTimestamp: items[items.length - 1]?.timestamp,
    lastUserText: userMessages[userMessages.length - 1]?.text,
    lastAssistantText: assistantMessages[assistantMessages.length - 1]?.text
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function buildSessionStatusText(input: {
  conversation: ConversationState;
  target: TargetRef;
  transcriptItems: TranscriptItem[];
  threadSummary?: Pick<ThreadSummary, "status" | "queuePosition" | "updatedAt" | "cwd" | "name">;
}): string {
  const stats = estimateTranscriptStats(input.transcriptItems);
  const threadName = input.target.threadName ?? input.threadSummary?.name ?? input.target.threadId;
  const lines = [
    "当前会话状态",
    `thread: ${threadName}`,
    `threadId: ${input.target.threadId}`,
    `assistant: ${input.target.assistantKind}`,
    `workspace: ${input.target.workspaceId}`,
    `device: ${input.target.deviceId}`,
    `状态: ${formatThreadStatusLabel(input.threadSummary?.status ?? "idle", input.threadSummary?.queuePosition)}`,
    `消息数: ${stats.messageCount} (user ${stats.userMessageCount} / assistant ${stats.assistantMessageCount})`,
    `问答轮数: ${stats.exchangeCount}`,
    `上下文体积: ${stats.textChars} chars, ${formatBytes(stats.textBytes)}, 粗略 ${stats.estimatedTokens} tokens`,
    `最后活跃: ${formatTranscriptTimestamp(input.threadSummary?.updatedAt ?? stats.lastTimestamp ?? input.conversation.updatedAt)}`
  ];

  if (input.threadSummary?.cwd) {
    lines.push(`cwd: ${input.threadSummary.cwd}`);
  }

  if (stats.lastUserText) {
    lines.push(`最近用户消息: ${truncateText(stats.lastUserText.replace(/\s+/g, " ").trim(), 80)}`);
  }

  if (stats.lastAssistantText) {
    lines.push(`最近 assistant 消息: ${truncateText(stats.lastAssistantText.replace(/\s+/g, " ").trim(), 80)}`);
  }

  if (stats.textBytes >= 24 * 1024 || stats.exchangeCount >= 24) {
    lines.push("建议: 可以发送 /compact 创建一个压缩后的新 thread。");
  }

  return lines.join("\n");
}

export function buildCompactThreadPrompt(target: TargetRef, transcriptItems: TranscriptItem[]): string {
  const exchanges = groupTranscriptExchanges(transcriptItems);
  const recentExchanges = exchanges.slice(-COMPACT_RECENT_EXCHANGE_LIMIT);
  const earlierExchanges = exchanges.slice(
    Math.max(0, exchanges.length - COMPACT_RECENT_EXCHANGE_LIMIT - COMPACT_EARLIER_EXCHANGE_LIMIT),
    Math.max(0, exchanges.length - COMPACT_RECENT_EXCHANGE_LIMIT)
  );
  const stats = estimateTranscriptStats(transcriptItems);
  const latestUserText =
    transcriptItems
      .filter((item) => item.role === "user")
      .map((item) => item.text.trim())
      .filter(Boolean)
      .slice(-1)[0] ?? "无";

  const blocks = [
    `Compact continuation for ${target.threadName ?? target.threadId}`,
    "",
    "你现在接手的是一个已经运行过的 coding thread。",
    "下面是 bridge 根据旧 thread 自动整理的压缩上下文，请把它视为当前 thread 的起始上下文继续工作。",
    "如果摘要里缺少关键细节，再明确指出缺口，不要假装知道。",
    "",
    "请优先保留这些信息：",
    "- 当前目标和真实需求",
    "- 已做出的决定与约束",
    "- 已修改/提到的文件、命令、测试结果",
    "- 尚未完成的任务和下一步",
    "",
    `来源 thread: ${target.threadName ?? target.threadId}`,
    `来源 assistant: ${target.assistantKind}`,
    `来源 workspace: ${target.workspaceId}`,
    `历史统计: ${stats.messageCount} 条消息, ${stats.exchangeCount} 轮问答, ${stats.textChars} chars`,
    `最近用户目标: ${truncateText(latestUserText.replace(/\s+/g, " ").trim(), COMPACT_RECENT_TEXT_LIMIT)}`,
    ""
  ];

  if (earlierExchanges.length > 0) {
    blocks.push("较早历史摘要:");
    earlierExchanges.forEach((exchange, index) => {
      const userText = truncateText(collectRoleText(exchange, "user").replace(/\s+/g, " ").trim() || "无", COMPACT_SUMMARY_TEXT_LIMIT);
      const assistantText = truncateText(
        collectRoleText(exchange, "assistant").replace(/\s+/g, " ").trim() || "无",
        COMPACT_SUMMARY_TEXT_LIMIT
      );
      blocks.push(`- ${index + 1}. U: ${userText}`);
      blocks.push(`  A: ${assistantText}`);
    });
    blocks.push("");
  }

  if (recentExchanges.length > 0) {
    blocks.push("最近关键上下文:");
    recentExchanges.forEach((exchange, index) => {
      const userText = truncateText(collectRoleText(exchange, "user") || "无", COMPACT_RECENT_TEXT_LIMIT);
      const assistantText = truncateText(collectRoleText(exchange, "assistant") || "无", COMPACT_RECENT_TEXT_LIMIT);
      blocks.push(`## Exchange ${index + 1}`);
      blocks.push(`[user]`);
      blocks.push(userText);
      blocks.push("[assistant]");
      blocks.push(assistantText);
      blocks.push("");
    });
  }

  blocks.push("请基于以上压缩上下文直接继续后续工作。");
  return blocks.join("\n");
}

export function buildThreadDetailText(
  target: TargetRef,
  transcriptItems: TranscriptItem[],
  requestedPairLimit?: number,
  compact = false
): string[] {
  const exchanges = groupTranscriptExchanges(transcriptItems);
  const totalPairs = exchanges.length;
  const selectedItems = exchanges
    .slice(requestedPairLimit ? Math.max(0, totalPairs - requestedPairLimit) : 0)
    .flat();

  const blocks = [
    `标题: ${target.threadName ?? target.threadId}${compact ? " (简洁预览)" : ""}`,
    ...(
      selectedItems.length === 0
        ? ["暂无聊天记录"]
        : selectedItems.map((item) =>
            [
              `[${item.role} ${formatTranscriptTimestamp(item.timestamp)}]`,
              compact ? truncateText(item.text, HISTORY_PREVIEW_TEXT_LIMIT) : item.text
            ].join("\n")
          )
    )
  ];

  if (requestedPairLimit && totalPairs > requestedPairLimit) {
    const nextPairLimit = Math.min(totalPairs, requestedPairLimit + DEFAULT_HISTORY_PAIR_LIMIT);
    blocks.push(`更多记录: /history ${nextPairLimit}${compact ? " s" : ""}`);
  }

  return chunkHistoryBlocks(blocks, HISTORY_MESSAGE_MAX_LENGTH);
}

function chunkHistoryBlocks(blocks: string[], maxLength: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    const pieces = splitLongBlock(block, maxLength);
    for (const [index, piece] of pieces.entries()) {
      const separator = current ? (index === 0 ? "\n\n" : "") : "";
      const next = `${current}${separator}${piece}`;
      if (next.length <= maxLength) {
        current = next;
        continue;
      }

      if (current) {
        chunks.push(current);
      }
      current = piece;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitLongBlock(block: string, maxLength: number): string[] {
  if (block.length <= maxLength) {
    return [block];
  }

  const pieces: string[] = [];
  let current = "";

  for (const line of block.split("\n")) {
    if (line.length > maxLength) {
      if (current) {
        pieces.push(current);
        current = "";
      }

      pieces.push(...splitLongLine(line, maxLength));
      continue;
    }

    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    if (current) {
      pieces.push(current);
    }
    current = line;
  }

  if (current) {
    pieces.push(current);
  }

  return pieces;
}

function splitLongLine(line: string, maxLength: number): string[] {
  const pieces: string[] = [];
  let offset = 0;

  while (offset < line.length) {
    pieces.push(line.slice(offset, offset + maxLength));
    offset += maxLength;
  }

  return pieces;
}

export function buildDirectoryText(
  requestedPath: string,
  nodes: Array<{ path: string; type: string; size?: number }>
): string {
  const lines: string[] = [`目录: ${requestedPath}`];
  if (nodes.length === 0) {
    lines.push("空目录");
    return lines.join("\n");
  }

  for (const node of nodes.slice(0, 40)) {
    lines.push(`${node.type === "directory" ? "[DIR]" : "[FILE]"} ${node.path}${node.size ? ` (${node.size})` : ""}`);
  }

  lines.push("");
  lines.push("继续浏览: /ls <path>");
  lines.push("打开文件: /open <path>");
  return lines.join("\n");
}

export function renderHelpText(): string {
  return [
    "Feishu Thread Bridge 文本命令",
    "",
    "/help",
    "/dashboard",
    "/target",
    "/workspaces",
    "/threads <workspaceId> [count]",
    "/threads <workspaceId> <keyword>",
    "/threads <workspaceId> <assistantKind>",
    "/threads <workspaceId> <assistantKind> [count]",
    "/threads <workspaceId> <assistantKind> [count] <keyword>",
    "/use <threadId>",
    "/new <workspaceId> [assistantKind]",
    "/history",
    "/history [count]",
    "/history s",
    "/history <threadId> [count] [s]",
    "/status",
    "/compact",
    "/ls [path]",
    "/open <path>",
    "/cancel",
    "/stop",
    "",
    "普通文本会直接发送到当前 target thread。",
    "图片和文件会投递到当前 target thread。"
  ].join("\n");
}

export function renderThreadsUsageText(workspaces: WorkspaceConfig[]): string {
  const lines = [
    "用法: /threads <workspaceId>",
    "/threads <workspaceId> [count]",
    "/threads <workspaceId> <keyword>",
    "/threads <workspaceId> <assistantKind>",
    "/threads <workspaceId> <assistantKind> [count]",
    "/threads <workspaceId> <assistantKind> [count] <keyword>",
    "",
    "示例:",
    "/threads dev-claw 1",
    "/threads repo migration",
    "/threads repo claude",
    "/threads repo claude 20",
    "/threads repo claude migration",
    "/threads repo claude 20 migration",
    "",
    "说明:",
    "- 只查看指定工作区最近的 thread",
    `- count 默认 ${DEFAULT_THREADS_LIST_LIMIT}，可按需填写更大的正整数`,
    "- assistantKind 目前支持 codex / claude",
    "- keyword 会按标题包含关系筛选 thread",
    "- 返回结果第一行可直接复制为 /use <threadId>"
  ];

  if (workspaces.length > 0) {
    lines.push("");
    lines.push(`可用工作区: ${workspaces.map((workspace) => workspace.id).join(", ")}`);
  }

  return lines.join("\n");
}

export function renderTargetText(conversation: ConversationState): string {
  if (!conversation.currentTarget) {
    return "当前没有 target thread。先用 /dashboard 或 /threads 查看，再用 /use <threadId> 切换。";
  }

  const target = conversation.currentTarget;
  return [
    "当前 target:",
    `device: ${target.deviceId}`,
    `workspace: ${target.workspaceId}`,
    `assistant: ${target.assistantKind}`,
    `thread: ${target.threadName ?? target.threadId}`
  ].join("\n");
}
