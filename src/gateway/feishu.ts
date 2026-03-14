import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { Express, Request, Response } from "express";
import * as lark from "@larksuiteoapi/node-sdk";
import mime from "mime-types";

import { GatewayConfig, AttachmentMeta } from "../shared/types";
import { makeId, nowIso, safeJsonParse } from "../shared/utils";

interface FeishuBridgeCallbacks {
  renderDashboard(conversationId: string): Promise<unknown>;
  handleConversationText(conversationId: string, text: string): Promise<void>;
  handleConversationAttachments(conversationId: string, attachments: AttachmentMeta[]): Promise<void>;
  handleCardAction(value: Record<string, unknown>): Promise<unknown>;
  saveAttachment(attachment: AttachmentMeta): AttachmentMeta;
}

export class FeishuService {
  private readonly client: any;
  private readonly wsClient: any;
  private readonly attachmentsDir: string;

  constructor(
    private readonly config: GatewayConfig,
    private readonly callbacks: FeishuBridgeCallbacks
  ) {
    this.attachmentsDir = path.join(this.config.dataDir, "attachments");
    fs.mkdirSync(this.attachmentsDir, { recursive: true });

    this.client = new (lark as any).Client({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret
    });

    this.wsClient = new (lark as any).WSClient({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      loggerLevel: (lark as any).LoggerLevel?.info
    });
  }

  start(app: Express): void {
    if (!this.config.feishu.enabled) {
      return;
    }

    if (this.config.feishu.interactiveCardsEnabled) {
      app.post("/feishu/card", async (req: Request, res: Response) => {
        const value = ((req.body as any)?.action?.value ?? {}) as Record<string, unknown>;
        const result = await this.callbacks.handleCardAction(value);
        res.json(result);
      });
    }

    const eventDispatcher = new (lark as any).EventDispatcher({
      encryptKey: this.config.feishu.encryptKey
    }).register({
      "im.message.receive_v1": async (data: any) => {
        try {
          await this.handleIncomingMessage(data);
        } catch (error) {
          const message = data?.message;
          const chatId = message?.chat_id as string | undefined;
          const messageType = message?.message_type as string | undefined;
          const messageId = message?.message_id as string | undefined;
          process.stderr.write(
            `[feishu] incoming message failed type=${messageType ?? "unknown"} chat=${chatId ?? "unknown"} id=${messageId ?? "unknown"} error=${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
          );
          if (chatId) {
            await this.sendText(chatId, `接收${messageType === "image" ? "图片" : "消息"}失败，请查看 gateway 日志。`);
          }
        }
      }
    });

    this.wsClient.start({ eventDispatcher });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.config.feishu.enabled) {
      return;
    }

    await this.client.im.message.create({
      params: {
        receive_id_type: "chat_id"
      },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text })
      }
    });
  }

  async sendCard(chatId: string, card: unknown): Promise<void> {
    if (!this.config.feishu.enabled) {
      return;
    }

    await this.client.im.message.create({
      params: {
        receive_id_type: "chat_id"
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card)
      }
    });
  }

  async sendLocalFile(chatId: string, filePath: string): Promise<void> {
    const extension = path.extname(filePath).replace(".", "") || "bin";
    const upload = await this.client.im.file.create({
      data: {
        file_type: extension,
        file_name: path.basename(filePath),
        file: fs.readFileSync(filePath)
      }
    });
    const fileKey = upload?.data?.file_key ?? upload?.file_key;

    await this.client.im.message.create({
      params: {
        receive_id_type: "chat_id"
      },
      data: {
        receive_id: chatId,
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey })
      }
    });
  }

  async sendLocalImage(chatId: string, filePath: string): Promise<void> {
    const upload = await this.client.im.image.create({
      data: {
        image_type: "message",
        image: fs.readFileSync(filePath)
      }
    });
    const imageKey = upload?.data?.image_key ?? upload?.image_key;

    await this.client.im.message.create({
      params: {
        receive_id_type: "chat_id"
      },
      data: {
        receive_id: chatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey })
      }
    });
  }

  private async handleIncomingMessage(data: any): Promise<void> {
    const message = data?.message;
    const chatId = message?.chat_id as string | undefined;
    const messageType = message?.message_type as string | undefined;
    const messageId = message?.message_id as string | undefined;
    if (!chatId || !messageType) {
      return;
    }

    if (this.config.feishu.allowChatIds.length > 0 && !this.config.feishu.allowChatIds.includes(chatId)) {
      return;
    }

    const conversationId = chatId;
    process.stdout.write(
      `[feishu] incoming message type=${messageType} chat=${chatId} id=${messageId ?? "unknown"}\n`
    );

    if (messageType === "text") {
      const payload = safeJsonParse<{ text?: string }>(message.content ?? "") ?? {};
      const text = payload.text?.trim() ?? "";
      if (!text) {
        return;
      }

      await this.callbacks.handleConversationText(conversationId, text);
      return;
    }

    if (messageType === "image") {
      const payload = safeJsonParse<{ image_key?: string }>(message.content ?? "") ?? {};
      if (!payload.image_key || !messageId) {
        process.stderr.write(
          `[feishu] image message missing image_key or message_id chat=${chatId} id=${messageId ?? "unknown"} content=${message.content ?? ""}\n`
        );
        return;
      }
      process.stdout.write(`[feishu] downloading image imageKey=${payload.image_key}\n`);
      const attachment = await this.downloadImage(messageId, payload.image_key);
      process.stdout.write(`[feishu] image saved attachment=${attachment.id} path=${attachment.storedPath}\n`);
      await this.callbacks.handleConversationAttachments(conversationId, [attachment]);
      return;
    }

    if (messageType === "file") {
      const payload = safeJsonParse<{ file_key?: string }>(message.content ?? "") ?? {};
      if (!payload.file_key || !messageId) {
        process.stderr.write(
          `[feishu] file message missing file_key or message_id chat=${chatId} id=${messageId ?? "unknown"} content=${message.content ?? ""}\n`
        );
        return;
      }
      process.stdout.write(`[feishu] downloading file fileKey=${payload.file_key}\n`);
      const attachment = await this.downloadFile(messageId, payload.file_key);
      process.stdout.write(`[feishu] file saved attachment=${attachment.id} path=${attachment.storedPath}\n`);
      await this.callbacks.handleConversationAttachments(conversationId, [attachment]);
    }
  }

  private async downloadImage(messageId: string, imageKey: string): Promise<AttachmentMeta> {
    const attachmentId = makeId("img");
    const response = await this.client.im.messageResource.get({
      params: {
        type: "image"
      },
      path: {
        message_id: messageId,
        file_key: imageKey
      }
    });
    const mimeType = this.resolveMimeType(response?.headers, "image/png");
    const extension = mime.extension(mimeType) || "png";
    const fileName = `${attachmentId}.${extension}`;
    const destinationPath = path.join(this.attachmentsDir, fileName);
    await this.writeBinaryResponse(response, destinationPath);

    return this.callbacks.saveAttachment({
      id: attachmentId,
      name: fileName,
      kind: "image",
      mimeType,
      size: fs.statSync(destinationPath).size,
      storedPath: destinationPath,
      createdAt: nowIso(),
      source: "feishu"
    });
  }

  private async downloadFile(messageId: string, fileKey: string): Promise<AttachmentMeta> {
    const attachmentId = makeId("file");
    const response = await this.client.im.messageResource.get({
      params: {
        type: "file"
      },
      path: {
        message_id: messageId,
        file_key: fileKey
      }
    });
    const mimeType = this.resolveMimeType(response?.headers, "application/octet-stream");
    const fileName = this.resolveAttachmentFileName(response?.headers, attachmentId, mimeType);
    const destinationPath = path.join(this.attachmentsDir, fileName);
    await this.writeBinaryResponse(response, destinationPath);

    return this.callbacks.saveAttachment({
      id: attachmentId,
      name: fileName,
      kind: "file",
      mimeType,
      size: fs.statSync(destinationPath).size,
      storedPath: destinationPath,
      createdAt: nowIso(),
      source: "feishu"
    });
  }

  private async writeBinaryResponse(response: any, destinationPath: string): Promise<void> {
    if (typeof response.writeFile === "function") {
      await response.writeFile(destinationPath);
      return;
    }

    if (typeof response.getReadableStream === "function") {
      await pipeline(response.getReadableStream(), fs.createWriteStream(destinationPath));
      return;
    }

    if (response?.data) {
      fs.writeFileSync(destinationPath, Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data));
      return;
    }

    throw new Error("Unsupported Feishu binary response shape");
  }

  private resolveMimeType(headers: any, fallback: string): string {
    const contentType = this.readHeader(headers, "content-type");
    if (!contentType) {
      return fallback;
    }

    return contentType.split(";")[0]?.trim() || fallback;
  }

  private resolveAttachmentFileName(headers: any, attachmentId: string, mimeType: string): string {
    const contentDisposition = this.readHeader(headers, "content-disposition");
    const fileNameMatch = contentDisposition?.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
    const decodedFileName = fileNameMatch?.[1] ? decodeURIComponent(fileNameMatch[1].replace(/"/g, "")) : undefined;
    if (decodedFileName) {
      return decodedFileName;
    }

    const extension = mime.extension(mimeType) || "bin";
    return `${attachmentId}.${extension}`;
  }

  private readHeader(headers: any, name: string): string | undefined {
    if (!headers || typeof headers !== "object") {
      return undefined;
    }

    const directValue = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
    if (Array.isArray(directValue)) {
      return directValue[0];
    }
    return typeof directValue === "string" ? directValue : undefined;
  }
}
