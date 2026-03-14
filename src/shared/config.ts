import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentConfigSchema, gatewayConfigSchema } from "./protocol";
import { AgentConfig, GatewayConfig } from "./types";

function readJsonFile(configPath: string): unknown {
  const absolutePath = path.resolve(configPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Config file not found: ${absolutePath}`);
  }

  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

function currentUserHome(): string {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function defaultManagedCodexPath(): string {
  return path.join(currentUserHome(), ".codex", "feishu-thread-bridge", "bin", "codex-official.exe");
}

function normalizeCodexPath(rawValue: unknown): string {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return defaultManagedCodexPath();
  }

  const trimmed = rawValue.trim();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(currentUserHome(), trimmed.slice(2));
  }

  if (trimmed === ".codex" || trimmed.startsWith(".codex/") || trimmed.startsWith(".codex\\")) {
    return path.join(currentUserHome(), trimmed);
  }

  return trimmed;
}

export function loadGatewayConfig(configPath = process.env.FTB_GATEWAY_CONFIG ?? "config/gateway.json"): GatewayConfig {
  return gatewayConfigSchema.parse(readJsonFile(configPath));
}

export function loadAgentConfig(configPath = process.env.FTB_AGENT_CONFIG ?? "config/agent.json"): AgentConfig {
  const parsed = readJsonFile(configPath);
  const normalized =
    parsed && typeof parsed === "object"
      ? {
          ...parsed,
          codexPath: normalizeCodexPath((parsed as { codexPath?: unknown }).codexPath)
        }
      : parsed;

  return agentConfigSchema.parse(normalized);
}
