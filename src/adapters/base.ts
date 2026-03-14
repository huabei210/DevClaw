import { AttachmentMeta, AssistantKind, TranscriptPage, TranscriptItem, ThreadSummary, WorkspaceConfig } from "../shared/types";

export interface StreamRunEvent {
  type: "thread.created" | "run.state" | "run.output";
  threadId?: string;
  state?: "queued" | "running" | "completed" | "failed" | "cancelled";
  stream?: "text" | "tool" | "raw" | "error";
  text?: string;
  command?: string;
  status?: string;
  payload?: unknown;
}

export interface CreateThreadInput {
  workspace: WorkspaceConfig;
  cwd?: string;
  prompt: string;
  attachments: AttachmentMeta[];
}

export interface ContinueThreadInput extends CreateThreadInput {
  threadId: string;
}

export type StreamEventHandler = (event: StreamRunEvent) => void;

export interface AssistantAdapter {
  readonly kind: AssistantKind;
  listThreads(workspace: WorkspaceConfig): Promise<ThreadSummary[]>;
  getTranscript(
    workspace: WorkspaceConfig,
    threadId: string,
    cursor?: string,
    limit?: number
  ): Promise<TranscriptPage>;
  createThread(input: CreateThreadInput, onEvent: StreamEventHandler): Promise<void>;
  continueThread(input: ContinueThreadInput, onEvent: StreamEventHandler): Promise<void>;
  cancelActiveRun?(threadId?: string): Promise<void>;
}

export function paginateTranscript(
  items: TranscriptItem[],
  cursor?: string,
  limit = 20
): TranscriptPage {
  const endIndex = cursor ? Number(cursor) : items.length;
  const startIndex = Math.max(0, endIndex - limit);
  const nextCursor = startIndex > 0 ? String(startIndex) : undefined;

  return {
    items: items.slice(startIndex, endIndex),
    nextCursor
  };
}
