import { z } from "zod";

export const assistantKindSchema = z.enum(["codex", "claude"]);

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rootPath: z.string().min(1),
  assistants: z.array(assistantKindSchema).min(1),
  defaultAssistant: assistantKindSchema
});

export const gatewayConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  baseUrl: z.string().url(),
  dataDir: z.string().min(1),
  devices: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      token: z.string().min(1)
    })
  ),
  feishu: z.object({
    enabled: z.boolean(),
    interactiveCardsEnabled: z.boolean().default(false),
    appId: z.string(),
    appSecret: z.string(),
    encryptKey: z.string().default(""),
    verificationToken: z.string().default(""),
    allowChatIds: z.array(z.string()).default([]),
    notificationChatIds: z.array(z.string()).default([])
  })
});

export const agentConfigSchema = z.object({
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  deviceToken: z.string().min(1),
  gatewayUrl: z.string().url(),
  dataDir: z.string().min(1),
  maxQueuedJobs: z.number().int().positive(),
  codexPath: z.string().min(1),
  claudePath: z.string().min(1).default("claude"),
  codexAppServerUrl: z
    .string()
    .url()
    .refine((value) => /^wss?:\/\//i.test(value), "codexAppServerUrl must start with ws:// or wss://")
    .optional(),
  codexAppServerReuseScope: z.enum(["workspace", "global"]).default("workspace"),
  workspaces: z.array(workspaceSchema).min(1)
});
