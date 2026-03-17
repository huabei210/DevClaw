import { AssistantAdapter, StreamRunEvent } from "../adapters/base";
import { nowIso } from "../shared/utils";
import {
  AgentConfig,
  AgentEvent,
  AssistantKind,
  QueuedJob,
  RunState,
  ThreadStatus,
  WorkspaceConfig
} from "../shared/types";

export interface RuntimeThreadState {
  workspaceId: string;
  assistantKind: AssistantKind;
  threadId: string;
  status: ThreadStatus;
  updatedAt: string;
  queuePosition?: number;
}

interface ExecutionManagerDependencies {
  config: AgentConfig;
  resolveAdapter: (kind: AssistantKind) => AssistantAdapter;
  resolveWorkspace: (workspaceId: string) => WorkspaceConfig;
  emit: (requestId: string | undefined, event: AgentEvent) => void;
  updateRuntimeState: (state: RuntimeThreadState) => void;
  clearRuntimeState: (assistantKind: AssistantKind, threadId?: string) => void;
}

const RUN_STATE_TO_THREAD_STATUS: Record<RunState, ThreadStatus> = {
  queued: "queued",
  running: "running",
  completed: "idle",
  failed: "error",
  cancelled: "idle"
};

export class ExecutionManager {
  private readonly queue: QueuedJob[] = [];
  private activeJob?: QueuedJob;

  constructor(private readonly dependencies: ExecutionManagerDependencies) {}

  enqueue(job: QueuedJob): { queuePosition: number } {
    if (this.queue.length >= this.dependencies.config.maxQueuedJobs) {
      throw new Error("Queue is full");
    }

    const queuePosition = this.activeJob ? this.queue.length + 1 : 0;
    if (!this.activeJob) {
      this.queue.unshift(job);
      void this.runNext();
      return { queuePosition };
    }

    this.queue.push(job);
    if (job.threadId) {
      this.setThreadState(job, "queued", queuePosition);
    }
    this.emitRunState(job, "queued", { queuePosition });
    return { queuePosition };
  }

  async cancel(
    requestId: string,
    threadId?: string
  ): Promise<{ removedQueued: boolean; active: boolean; stoppedActive: boolean }> {
    const queueIndex = this.queue.findIndex((job) => job.requestId === requestId || (threadId && job.threadId === threadId));
    if (queueIndex >= 0) {
      const [removedJob] = this.queue.splice(queueIndex, 1);
      if (removedJob.threadId) {
        this.dependencies.clearRuntimeState(removedJob.assistantKind, removedJob.threadId);
      }
      this.emitRunState(removedJob, "cancelled");
      return { removedQueued: true, active: false, stoppedActive: false };
    }

    if (this.activeJob && (this.activeJob.requestId === requestId || (threadId && this.activeJob.threadId === threadId))) {
      const adapter = this.dependencies.resolveAdapter(this.activeJob.assistantKind);
      await adapter.cancelActiveRun?.(threadId ?? this.activeJob.threadId);
      return { removedQueued: false, active: true, stoppedActive: true };
    }

    return { removedQueued: false, active: false, stoppedActive: false };
  }

  private async runNext(): Promise<void> {
    if (this.activeJob || this.queue.length === 0) {
      return;
    }

    const job = this.queue.shift()!;
    this.activeJob = job;

    const workspace = this.dependencies.resolveWorkspace(job.workspaceId);
    const adapter = this.dependencies.resolveAdapter(job.assistantKind);
    this.emitRunState(job, "running");

    let terminalState: ThreadStatus | undefined;
    try {
      const streamEventHandler = (event: StreamRunEvent) => {
        if (event.type === "thread.created" && event.threadId) {
          job.threadId = event.threadId;
          this.setThreadState(job, "running");
          this.dependencies.emit(job.requestId, {
            type: "thread.created",
            deviceId: this.dependencies.config.deviceId,
            workspaceId: job.workspaceId,
            assistantKind: job.assistantKind,
            threadId: event.threadId,
            ts: nowIso()
          });
          return;
        }

        if (event.type === "run.state") {
          const state = event.state ?? "running";
          terminalState = RUN_STATE_TO_THREAD_STATUS[state];
          if (job.threadId) {
            this.setThreadState(job, state);
          }
          this.emitRunState(job, state);
          return;
        }

        if (event.type === "run.output") {
          this.dependencies.emit(job.requestId, {
            type: "run.output",
            deviceId: this.dependencies.config.deviceId,
            workspaceId: job.workspaceId,
            assistantKind: job.assistantKind,
            threadId: job.threadId,
            stream: event.stream ?? "raw",
            text: event.text,
            command: event.command,
            status: event.status,
            payload: event.payload,
            ts: nowIso()
          });
        }
      };

      if (job.action === "create_thread") {
        await adapter.createThread(
          {
            workspace,
            cwd: job.cwd,
            prompt: job.prompt,
            attachments: job.attachments
          },
          streamEventHandler
        );
        return;
      }

      if (!job.threadId) {
        throw new Error("send_to_thread requires threadId");
      }

      await adapter.continueThread(
        {
          workspace,
          cwd: job.cwd,
          prompt: job.prompt,
          attachments: job.attachments,
          threadId: job.threadId
        },
        streamEventHandler
      );
    } finally {
      this.activeJob = undefined;
      if (job.threadId) {
        this.setThreadState(job, terminalState === undefined ? "completed" : this.getRunStateForTerminalStatus(terminalState));
      }
      void this.runNext();
    }
  }

  private emitRunState(job: QueuedJob, state: RunState, extras: { queuePosition?: number } = {}): void {
    this.dependencies.emit(job.requestId, {
      type: "run.state",
      deviceId: this.dependencies.config.deviceId,
      workspaceId: job.workspaceId,
      assistantKind: job.assistantKind,
      threadId: job.threadId,
      state,
      queuePosition: extras.queuePosition,
      ts: nowIso()
    });
  }

  private setThreadState(job: QueuedJob, state: RunState, queuePosition?: number): void {
    if (!job.threadId) {
      return;
    }

    this.dependencies.updateRuntimeState({
      workspaceId: job.workspaceId,
      assistantKind: job.assistantKind,
      threadId: job.threadId,
      status: RUN_STATE_TO_THREAD_STATUS[state],
      updatedAt: nowIso(),
      queuePosition
    });
  }

  private getRunStateForTerminalStatus(status: ThreadStatus): RunState {
    switch (status) {
      case "queued":
        return "queued";
      case "running":
      case "blocked":
        return "running";
      case "error":
        return "failed";
      case "idle":
      case "offline":
      default:
        return "completed";
    }
  }
}
