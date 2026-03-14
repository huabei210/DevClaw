import { formatTranscriptTimestamp } from "../shared/transcript";
import { truncateText } from "../shared/utils";
import { ConversationState, TargetRef, ThreadSummary, TranscriptItem, WorkspaceConfig } from "../shared/types";

export interface HistoryArgs {
  pairLimit?: number;
  threadQuery?: string;
  compact: boolean;
  error?: string;
}

export const DEFAULT_THREADS_LIST_LIMIT = 4;
export const MAX_THREADS_LIST_LIMIT = 20;
export const DEFAULT_HISTORY_PAIR_LIMIT = 6;
export const HISTORY_FETCH_PAGE_LIMIT = 200;
export const HISTORY_PREVIEW_TEXT_LIMIT = 30;
export const HISTORY_MESSAGE_MAX_LENGTH = 3000;

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

export function buildThreadListHeader(workspaceId: string | undefined, totalThreads: number): string {
  const lines: string[] = [];
  if (workspaceId) {
    lines.push(`查看更多: /threads ${workspaceId} ${Math.min(totalThreads, MAX_THREADS_LIST_LIMIT)}`);
  }
  lines.push("复制任意一条消息的第一行即可切换。");
  return lines.join("\n");
}

export function buildThreadShortcutText(
  thread: Pick<ThreadSummary, "threadId" | "name" | "status" | "queuePosition">
): string {
  return [
    `/use ${thread.threadId}`,
    `标题: ${thread.name || thread.threadId}`,
    `状态: ${formatThreadStatusLabel(thread.status, thread.queuePosition)}`
  ].join("\n");
}

export function parseThreadsArgs(args: string[]): { limit: number; error?: string } {
  let limit = DEFAULT_THREADS_LIST_LIMIT;

  for (const arg of args) {
    const normalized = arg.trim().toLowerCase();
    if (!normalized) {
      continue;
    }

    const parsedCount = Number(normalized);
    if (Number.isInteger(parsedCount) && parsedCount > 0) {
      limit = Math.min(parsedCount, MAX_THREADS_LIST_LIMIT);
      continue;
    }

    return {
      limit,
      error: `无效参数: ${arg}\n\n用法: /threads <workspaceId> [count]`
    };
  }

  return { limit };
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
    "/use <threadId>",
    "/new <workspaceId>",
    "/history",
    "/history [count]",
    "/history s",
    "/history <threadId> [count] [s]",
    "/ls [path]",
    "/open <path>",
    "/cancel",
    "",
    "普通文本会直接发送到当前 target thread。",
    "图片和文件会投递到当前 target thread。"
  ].join("\n");
}

export function renderThreadsUsageText(workspaces: WorkspaceConfig[]): string {
  const lines = [
    "用法: /threads <workspaceId> [count]",
    "",
    "示例:",
    "/threads dev-claw 1",
    "",
    "说明:",
    "- 只查看指定工作区最近的 thread",
    `- count 默认 ${DEFAULT_THREADS_LIST_LIMIT}，最大 ${MAX_THREADS_LIST_LIMIT}`,
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
