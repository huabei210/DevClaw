import path from "node:path";

import { JsonFileStore } from "../shared/json-store";
import { AttachmentMeta, ConversationState } from "../shared/types";

interface GatewayPersistedState {
  conversations: Record<string, ConversationState>;
  attachments: Record<string, AttachmentMeta>;
}

const DEFAULT_STATE: GatewayPersistedState = {
  conversations: {},
  attachments: {}
};

export class GatewayStateStore {
  private readonly store: JsonFileStore<GatewayPersistedState>;

  constructor(dataDir: string) {
    this.store = new JsonFileStore(path.join(dataDir, "state.json"), DEFAULT_STATE);
  }

  getConversation(conversationId: string): ConversationState {
    const state = this.store.load();
    return (
      state.conversations[conversationId] ?? {
        conversationId,
        updatedAt: new Date().toISOString()
      }
    );
  }

  saveConversation(conversation: ConversationState): ConversationState {
    this.store.update((state) => ({
      ...state,
      conversations: {
        ...state.conversations,
        [conversation.conversationId]: conversation
      }
    }));
    return conversation;
  }

  listConversations(): ConversationState[] {
    return Object.values(this.store.load().conversations);
  }

  saveAttachment(attachment: AttachmentMeta): AttachmentMeta {
    this.store.update((state) => ({
      ...state,
      attachments: {
        ...state.attachments,
        [attachment.id]: attachment
      }
    }));
    return attachment;
  }

  getAttachment(attachmentId: string): AttachmentMeta | undefined {
    return this.store.load().attachments[attachmentId];
  }
}
