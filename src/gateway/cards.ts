import { ConversationState, FsNode, ThreadSummary, TranscriptPage, WorkspaceConfig } from "../shared/types";
import { formatTranscriptTimestamp } from "../shared/transcript";
import { truncateText } from "../shared/utils";

function plainText(content: string) {
  return {
    tag: "plain_text",
    content
  };
}

function button(content: string, value: Record<string, unknown>, type: "default" | "primary" = "default") {
  return {
    tag: "button",
    text: plainText(content),
    type,
    value
  };
}

export function buildInfoCard(title: string, body: string) {
  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: "blue",
      title: plainText(title)
    },
    elements: [
      {
        tag: "markdown",
        content: body
      }
    ]
  };
}

export function buildDashboardCard(input: {
  conversation: ConversationState;
  deviceId: string;
  deviceName: string;
  workspaces: WorkspaceConfig[];
  threadsByWorkspace: Record<string, ThreadSummary[]>;
}) {
  const elements: unknown[] = [
    {
      tag: "markdown",
      content: `当前 target: ${input.conversation.currentTarget?.threadName ?? input.conversation.currentTarget?.threadId ?? "未选择"}`
    },
    {
      tag: "action",
      actions: [
        button("刷新", {
          action: "refresh_dashboard",
          conversationId: input.conversation.conversationId,
          deviceId: input.deviceId
        }, "primary")
      ]
    }
  ];

  for (const workspace of input.workspaces) {
    elements.push({
      tag: "hr"
    });
    elements.push({
      tag: "markdown",
      content: `**${workspace.name}**  \\n路径: ${workspace.rootPath}  \\n助手: ${workspace.assistants.join(", ")}`
    });
    elements.push({
      tag: "action",
      actions: workspace.assistants.map((assistantKind) =>
        button("新建 thread", {
          action: "start_create_thread",
          conversationId: input.conversation.conversationId,
          deviceId: input.deviceId,
          workspaceId: workspace.id,
          assistantKind
        })
      )
    });

    const threads = input.threadsByWorkspace[workspace.id] ?? [];
    if (threads.length === 0) {
      elements.push({
        tag: "markdown",
        content: "暂无 thread"
      });
      continue;
    }

    for (const thread of threads.slice(0, 8)) {
      const summary = `${thread.status.toUpperCase()} | ${truncateText(thread.name, 40)}`;
      elements.push({
        tag: "action",
        actions: [
          button(summary, {
            action: "switch_thread",
            conversationId: input.conversation.conversationId,
            deviceId: input.deviceId,
            workspaceId: thread.workspaceId,
            assistantKind: thread.assistantKind,
            threadId: thread.threadId,
            threadName: thread.name
          })
        ]
      });
    }
  }

  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: "turquoise",
      title: plainText(`Feishu Thread Bridge | ${input.deviceName}`)
    },
    elements
  };
}

export function buildThreadDetailCard(input: {
  conversation: ConversationState;
  transcript: TranscriptPage;
  targetTitle: string;
}) {
  const transcriptText = input.transcript.items.length
    ? input.transcript.items
        .map((item) => `**${item.role} ${formatTranscriptTimestamp(item.timestamp)}**\n${truncateText(item.text, 500)}`)
        .join("\n\n")
    : "暂无聊天记录";

  const actions = [
    button("刷新", {
      action: "refresh_thread",
      conversationId: input.conversation.conversationId
    }, "primary"),
    button("浏览目录", {
      action: "list_dir",
      conversationId: input.conversation.conversationId,
      path: "."
    })
  ];

  if (input.transcript.nextCursor) {
    actions.push(
      button("更早记录", {
        action: "paginate_thread",
        conversationId: input.conversation.conversationId,
        cursor: input.transcript.nextCursor
      })
    );
  }

  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: "blue",
      title: plainText(input.targetTitle)
    },
    elements: [
      {
        tag: "markdown",
        content: `当前 target: ${input.targetTitle}`
      },
      {
        tag: "action",
        actions
      },
      {
        tag: "markdown",
        content: transcriptText
      }
    ]
  };
}

export function buildDirectoryCard(input: {
  conversation: ConversationState;
  cwdTitle: string;
  nodes: FsNode[];
}) {
  const elements: unknown[] = [
    {
      tag: "markdown",
      content: `目录: ${input.cwdTitle}`
    }
  ];

  for (const node of input.nodes.slice(0, 20)) {
    if (node.type === "directory") {
      elements.push({
        tag: "action",
        actions: [
          button(`[目录] ${node.name}`, {
            action: "list_dir",
            conversationId: input.conversation.conversationId,
            path: node.path
          })
        ]
      });
      continue;
    }

    elements.push({
      tag: "action",
      actions: [
        button(`[文件] ${node.name}`, {
          action: "read_file",
          conversationId: input.conversation.conversationId,
          path: node.path
        })
      ]
    });
  }

  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: "green",
      title: plainText("工作区目录")
    },
    elements
  };
}
