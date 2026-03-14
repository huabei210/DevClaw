import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ResolvedCommand {
  command: string;
  args: string[];
}

interface ResolveWindowsCommandOptions {
  cwd?: string;
}

interface ResolveCodexCommandOptions extends ResolveWindowsCommandOptions {
  env?: NodeJS.ProcessEnv;
}

const WINDOWS_EXTENSIONS = [".cmd", ".bat", ".exe", ".com", ".ps1"];
const WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_PWSH_LAUNCHER_PATH = path.resolve(__dirname, "..", "..", "scripts", "invoke-windows-command.ps1");
const WINDOWS_OFFICIAL_CODEX_PACKAGE_PREFIX = "OpenAI.Codex_";
const WINDOWS_OFFICIAL_CODEX_CACHE_PARTS = [".codex", "feishu-thread-bridge", "bin", "codex-official.exe"] as const;
const WINDOWS_EDITOR_EXTENSION_MARKERS = [
  "\\.vscode\\extensions\\",
  "\\.cursor\\extensions\\",
  "\\.windsurf\\extensions\\",
  "\\resources\\app\\extensions\\"
] as const;
const WINDOWS_NPM_SHIM_MARKERS = [
  "\\appdata\\roaming\\npm\\",
  "\\program files\\nodejs\\",
  "\\scoop\\shims\\",
  "\\volta\\bin\\"
] as const;

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1);
  }

  return value;
}

function normalizeCommand(command: string): string | undefined {
  const normalizedCommand = stripWrappingQuotes(command.trim());
  return normalizedCommand || undefined;
}

function normalizeWindowsPathForMatch(value: string): string {
  return value.replace(/\//g, "\\").toLowerCase();
}

function resolveCandidates(basePath: string): string[] {
  if (path.extname(basePath)) {
    return [basePath];
  }

  return WINDOWS_EXTENSIONS.map((extension) => `${basePath}${extension}`);
}

function findExplicitCommand(command: string, cwd: string): string | undefined {
  const absoluteBase = path.isAbsolute(command) ? command : path.resolve(cwd, command);

  for (const candidate of resolveCandidates(absoluteBase)) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function resolveWindowsCommandTarget(command: string, options: ResolveWindowsCommandOptions): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  if (command.includes("\\") || command.includes("/") || path.isAbsolute(command)) {
    return findExplicitCommand(command, cwd);
  }

  return undefined;
}

export function resolveWindowsPwshCommand(
  command: string,
  options: ResolveWindowsCommandOptions = {}
): ResolvedCommand | undefined {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return undefined;
  }

  const resolvedCommand = resolveWindowsCommandTarget(normalizedCommand, options) ?? normalizedCommand;
  if (WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS.has(path.extname(resolvedCommand).toLowerCase())) {
    return {
      command: resolvedCommand,
      args: []
    };
  }

  return {
    command: "pwsh",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", WINDOWS_PWSH_LAUNCHER_PATH, resolvedCommand]
  };
}

function isBareCodexCommand(command: string): boolean {
  const normalizedCommand = normalizeCommand(command)?.toLowerCase();
  if (!normalizedCommand) {
    return false;
  }

  if (normalizedCommand.includes("\\") || normalizedCommand.includes("/") || path.isAbsolute(normalizedCommand)) {
    return false;
  }

  return (
    normalizedCommand === "codex" ||
    normalizedCommand === "codex.cmd" ||
    normalizedCommand === "codex.exe" ||
    normalizedCommand === "codex.ps1"
  );
}

function parseNumericVersionSegments(version: string): number[] {
  return version
    .split(".")
    .map((segment) => Number(segment))
    .filter((segment) => Number.isFinite(segment));
}

function compareNumericVersionSegments(left: number[], right: number[]): number {
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

function extractWindowsCodexPackageVersion(directoryName: string): number[] | undefined {
  if (!directoryName.startsWith(WINDOWS_OFFICIAL_CODEX_PACKAGE_PREFIX)) {
    return undefined;
  }

  const versionMatch = /^OpenAI\.Codex_(.+?)_[^_]+__/i.exec(directoryName);
  if (!versionMatch) {
    return undefined;
  }

  const versionSegments = parseNumericVersionSegments(versionMatch[1]);
  return versionSegments.length > 0 ? versionSegments : undefined;
}

function windowsProgramsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ProgramFiles || "C:\\Program Files";
}

function windowsOfficialCodexCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const userHome = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(userHome, ...WINDOWS_OFFICIAL_CODEX_CACHE_PARTS);
}

function isWindowsOfficialCodexWindowsAppsPath(command: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  const normalizedPath = normalizeWindowsPathForMatch(normalizedCommand);
  return (
    normalizedPath.includes("\\windowsapps\\openai.codex_") &&
    normalizedPath.endsWith("\\app\\resources\\codex.exe")
  );
}

function isWindowsEditorBundledCodexCommand(command: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  const normalizedPath = normalizeWindowsPathForMatch(normalizedCommand);
  if (!normalizedPath.endsWith("\\codex.exe")) {
    return false;
  }

  return WINDOWS_EDITOR_EXTENSION_MARKERS.some((marker) => normalizedPath.includes(marker));
}

function isWindowsNpmShimCodexCommand(command: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  const normalizedPath = normalizeWindowsPathForMatch(normalizedCommand);
  const fileName = path.win32.basename(normalizedPath);
  if (fileName !== "codex.ps1" && fileName !== "codex.cmd" && fileName !== "codex.bat") {
    return false;
  }

  return WINDOWS_NPM_SHIM_MARKERS.some((marker) => normalizedPath.includes(marker));
}

function findPreferredWindowsCodexExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const windowsAppsRoot = path.join(windowsProgramsRoot(env), "WindowsApps");
  if (!fs.existsSync(windowsAppsRoot)) {
    return undefined;
  }

  const candidates: Array<{ candidatePath: string; packageName: string; version: number[] }> = [];

  for (const entry of fs.readdirSync(windowsAppsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const version = extractWindowsCodexPackageVersion(entry.name);
    if (!version) {
      continue;
    }

    const candidatePath = path.join(windowsAppsRoot, entry.name, "app", "resources", "codex.exe");
    if (!fileExists(candidatePath)) {
      continue;
    }

    candidates.push({
      candidatePath,
      packageName: entry.name,
      version
    });
  }

  candidates.sort((left, right) => {
    const versionComparison = compareNumericVersionSegments(right.version, left.version);
    if (versionComparison !== 0) {
      return versionComparison;
    }

    return right.packageName.localeCompare(left.packageName);
  });

  return candidates[0]?.candidatePath;
}

function copyFileIfNeeded(sourcePath: string, destinationPath: string): void {
  const sourceStat = fs.statSync(sourcePath);
  const destinationStat = fs.existsSync(destinationPath) ? fs.statSync(destinationPath) : undefined;

  if (
    destinationStat &&
    destinationStat.isFile() &&
    destinationStat.size === sourceStat.size &&
    destinationStat.mtimeMs >= sourceStat.mtimeMs
  ) {
    return;
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  try {
    fs.copyFileSync(sourcePath, destinationPath);
  } catch (error) {
    const errorCode = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if ((errorCode === "EBUSY" || errorCode === "EPERM") && destinationStat?.isFile()) {
      return;
    }

    throw error;
  }
  fs.utimesSync(destinationPath, sourceStat.atime, sourceStat.mtime);
}

function materializePreferredWindowsCodexExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const sourcePath = findPreferredWindowsCodexExecutable(env);
  if (!sourcePath) {
    return undefined;
  }

  const destinationPath = windowsOfficialCodexCachePath(env);
  copyFileIfNeeded(sourcePath, destinationPath);
  return destinationPath;
}

function shouldTryPreferredWindowsCodexCommand(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  return (
    isBareCodexCommand(normalizedCommand) ||
    isWindowsOfficialCodexWindowsAppsPath(normalizedCommand) ||
    isWindowsEditorBundledCodexCommand(normalizedCommand) ||
    isWindowsNpmShimCodexCommand(normalizedCommand) ||
    normalizeWindowsPathForMatch(normalizedCommand) ===
      normalizeWindowsPathForMatch(windowsOfficialCodexCachePath(env))
  );
}

function shouldRequireManagedWindowsCodexExecutable(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  return (
    isWindowsOfficialCodexWindowsAppsPath(normalizedCommand) ||
    isWindowsEditorBundledCodexCommand(normalizedCommand) ||
    isWindowsNpmShimCodexCommand(normalizedCommand) ||
    normalizeWindowsPathForMatch(normalizedCommand) ===
      normalizeWindowsPathForMatch(windowsOfficialCodexCachePath(env))
  );
}

function resolvePreferredWindowsCodexCommand(
  command: string,
  options: ResolveCodexCommandOptions = {}
): ResolvedCommand | undefined {
  if (!shouldTryPreferredWindowsCodexCommand(command, options.env)) {
    return undefined;
  }

  const preferredExecutable = materializePreferredWindowsCodexExecutable(options.env);
  if (!preferredExecutable) {
    return undefined;
  }

  return {
    command: preferredExecutable,
    args: []
  };
}

export function ensureCodexCommandReady(command: string, options: ResolveCodexCommandOptions = {}): ResolvedCommand {
  const resolvedCommand = resolveCodexCommand(command, options);

  if (process.platform !== "win32") {
    return resolvedCommand;
  }

  if (shouldRequireManagedWindowsCodexExecutable(command, options.env) && !fileExists(resolvedCommand.command)) {
    throw new Error(
      `Unable to prepare managed official Codex executable at ${resolvedCommand.command}. ` +
        "Make sure the Codex desktop app is installed, then run `npm run install:codex`."
    );
  }

  if (
    resolvedCommand.command !== "pwsh" &&
    WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS.has(path.extname(resolvedCommand.command).toLowerCase()) &&
    !fileExists(resolvedCommand.command)
  ) {
    throw new Error(`Codex executable not found: ${resolvedCommand.command}`);
  }

  return resolvedCommand;
}

export function resolveCodexCommand(command: string, options: ResolveCodexCommandOptions = {}): ResolvedCommand {
  if (process.platform !== "win32") {
    return {
      command,
      args: []
    };
  }

  return (
    resolvePreferredWindowsCodexCommand(command, options) ??
    resolveWindowsPwshCommand(command, options) ?? {
      command,
      args: []
    }
  );
}
