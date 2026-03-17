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

function defaultCodexPath(): string {
  return "codex";
}

function normalizeHomeRelativePath(value: string): string {
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(currentUserHome(), value.slice(2));
  }

  return value;
}

function normalizeCodexPath(rawValue: unknown): string {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return defaultCodexPath();
  }

  const trimmed = normalizeHomeRelativePath(rawValue.trim());

  if (trimmed === ".codex" || trimmed.startsWith(".codex/") || trimmed.startsWith(".codex\\")) {
    return path.join(currentUserHome(), trimmed);
  }

  return trimmed;
}

function normalizeClaudePath(rawValue: unknown): string {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return "claude";
  }

  return normalizeHomeRelativePath(rawValue.trim());
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
          codexPath: normalizeCodexPath((parsed as { codexPath?: unknown }).codexPath),
          claudePath: normalizeClaudePath((parsed as { claudePath?: unknown }).claudePath)
        }
      : parsed;

  return agentConfigSchema.parse(normalized);
}
