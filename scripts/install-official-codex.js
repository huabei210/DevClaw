"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const OFFICIAL_CODEX_PACKAGE_PREFIX = "OpenAI.Codex_";
const DEFAULT_WINDOWS_PROGRAM_FILES = "C:\\Program Files";
const DEFAULT_MANAGED_DESTINATION = path.join(
  process.env.USERPROFILE || process.env.HOME || os.homedir(),
  ".codex",
  "feishu-thread-bridge",
  "bin",
  "codex-official.exe"
);
const WINDOWS_EDITOR_EXTENSION_MARKERS = [
  "\\.vscode\\extensions\\",
  "\\.cursor\\extensions\\",
  "\\.windsurf\\extensions\\",
  "\\resources\\app\\extensions\\"
];
const WINDOWS_NPM_SHIM_MARKERS = [
  "\\appdata\\roaming\\npm\\",
  "\\program files\\nodejs\\",
  "\\scoop\\shims\\",
  "\\volta\\bin\\"
];

function log(message) {
  process.stdout.write(`[install-official-codex] ${message}\n`);
}

function isWindows() {
  return process.platform === "win32";
}

function parseVersionSegments(versionText) {
  return versionText
    .split(".")
    .map((segment) => Number(segment))
    .filter((segment) => Number.isFinite(segment));
}

function normalizeWindowsPathForMatch(value) {
  return value.replace(/\//g, "\\").toLowerCase();
}

function isWindowsOfficialCodexWindowsAppsPath(filePath) {
  const normalizedPath = normalizeWindowsPathForMatch(filePath);
  return (
    normalizedPath.includes("\\windowsapps\\openai.codex_") &&
    normalizedPath.endsWith("\\app\\resources\\codex.exe")
  );
}

function isWindowsEditorBundledCodexPath(filePath) {
  const normalizedPath = normalizeWindowsPathForMatch(filePath);
  if (!normalizedPath.endsWith("\\codex.exe")) {
    return false;
  }

  return WINDOWS_EDITOR_EXTENSION_MARKERS.some((marker) => normalizedPath.includes(marker));
}

function isWindowsNpmShimCodexPath(filePath) {
  const normalizedPath = normalizeWindowsPathForMatch(filePath);
  const fileName = path.win32.basename(normalizedPath);
  if (fileName !== "codex.ps1" && fileName !== "codex.cmd" && fileName !== "codex.bat") {
    return false;
  }

  return WINDOWS_NPM_SHIM_MARKERS.some((marker) => normalizedPath.includes(marker));
}

function isUnsupportedConfiguredCodexDestination(filePath) {
  return (
    isWindowsOfficialCodexWindowsAppsPath(filePath) ||
    isWindowsEditorBundledCodexPath(filePath) ||
    isWindowsNpmShimCodexPath(filePath)
  );
}

function compareVersionSegments(left, right) {
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = left[index] || 0;
    const rightValue = right[index] || 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

function resolveAgentConfigPath() {
  const configuredPath = process.env.FTB_AGENT_CONFIG;
  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath.trim());
  }

  return path.join(PROJECT_ROOT, "config", "agent.json");
}

function readConfiguredCodexPath() {
  const configPath = resolveAgentConfigPath();
  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (typeof parsed.codexPath !== "string") {
      return undefined;
    }

    const trimmed = parsed.codexPath.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) {
      return undefined;
    }

    if (isUnsupportedConfiguredCodexDestination(trimmed)) {
      log(`ignore configured codexPath because it points to a transient shim/plugin path: ${trimmed}`);
      return undefined;
    }

    return trimmed;
  } catch (error) {
    log(`skip reading codexPath from config because parsing failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function resolveInstallDestination() {
  const envDestination = process.env.FTB_CODEX_INSTALL_PATH;
  if (envDestination && envDestination.trim()) {
    return path.resolve(envDestination.trim());
  }

  return readConfiguredCodexPath() || DEFAULT_MANAGED_DESTINATION;
}

function resolveWindowsAppsRoot() {
  return path.join(process.env.ProgramFiles || DEFAULT_WINDOWS_PROGRAM_FILES, "WindowsApps");
}

function extractPackageVersion(directoryName) {
  if (!directoryName.startsWith(OFFICIAL_CODEX_PACKAGE_PREFIX)) {
    return undefined;
  }

  const match = /^OpenAI\.Codex_(.+?)_[^_]+__/i.exec(directoryName);
  if (!match) {
    return undefined;
  }

  const versionSegments = parseVersionSegments(match[1]);
  return versionSegments.length > 0 ? versionSegments : undefined;
}

function findOfficialCodexSource() {
  const windowsAppsRoot = resolveWindowsAppsRoot();
  if (!fs.existsSync(windowsAppsRoot)) {
    return undefined;
  }

  const candidates = [];
  for (const entry of fs.readdirSync(windowsAppsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const version = extractPackageVersion(entry.name);
    if (!version) {
      continue;
    }

    const candidatePath = path.join(windowsAppsRoot, entry.name, "app", "resources", "codex.exe");
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    candidates.push({
      sourcePath: candidatePath,
      packageName: entry.name,
      version
    });
  }

  candidates.sort((left, right) => {
    const versionComparison = compareVersionSegments(right.version, left.version);
    if (versionComparison !== 0) {
      return versionComparison;
    }

    return right.packageName.localeCompare(left.packageName);
  });

  return candidates[0] ? candidates[0].sourcePath : undefined;
}

function copyIfNeeded(sourcePath, destinationPath) {
  const sourceStat = fs.statSync(sourcePath);
  const destinationStat = fs.existsSync(destinationPath) ? fs.statSync(destinationPath) : undefined;

  if (
    destinationStat &&
    destinationStat.isFile() &&
    destinationStat.size === sourceStat.size &&
    destinationStat.mtimeMs >= sourceStat.mtimeMs
  ) {
    log(`destination already up to date: ${destinationPath}`);
    return false;
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  try {
    fs.copyFileSync(sourcePath, destinationPath);
  } catch (error) {
    if (error && (error.code === "EBUSY" || error.code === "EPERM")) {
      const fallback = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Copy-Item -Path '${sourcePath.replace(/'/g, "''")}' -Destination '${destinationPath.replace(/'/g, "''")}' -Force`
        ],
        {
          encoding: "utf8",
          windowsHide: true
        }
      );

      if (fallback.status !== 0) {
        if (destinationStat && destinationStat.isFile()) {
          log(`skip updating busy codex.exe; keeping existing copy at ${destinationPath}`);
          return false;
        }

        const stderr = (fallback.stderr || "").trim();
        throw new Error(stderr || `failed to copy official codex.exe with pwsh fallback (status=${String(fallback.status)})`);
      }
    } else {
      throw error;
    }
  }

  fs.utimesSync(destinationPath, sourceStat.atime, sourceStat.mtime);
  log(`copied official codex.exe to ${destinationPath}`);
  return true;
}

function main() {
  if (!isWindows()) {
    log("skip because current platform is not Windows");
    return;
  }

  const sourcePath = findOfficialCodexSource();
  if (!sourcePath) {
    log("skip because no official Codex desktop package was found under WindowsApps");
    return;
  }

  const destinationPath = resolveInstallDestination();
  copyIfNeeded(sourcePath, destinationPath);
}

main();
