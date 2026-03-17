import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ResolvedCommand {
  command: string;
  args: string[];
}

interface ResolveWindowsCommandOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
}

interface ResolveCodexCommandOptions extends ResolveWindowsCommandOptions {
  env?: NodeJS.ProcessEnv;
}

interface ResolveClaudeCommandOptions extends ResolveWindowsCommandOptions {
  env?: NodeJS.ProcessEnv;
}

const WINDOWS_EXTENSIONS = [".cmd", ".bat", ".exe", ".com", ".ps1"];
const WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_PWSH_LAUNCHER_PATH = path.resolve(__dirname, "..", "..", "scripts", "invoke-windows-command.ps1");
const WINDOWS_OFFICIAL_CODEX_PACKAGE_PREFIX = "OpenAI.Codex_";
const WINDOWS_OFFICIAL_CODEX_CACHE_PARTS = [".codex", "feishu-thread-bridge", "bin", "codex-official.exe"] as const;
const WINDOWS_CODEX_EXTENSION_DIRECTORY_PREFIX = "openai.chatgpt-";
const WINDOWS_CLAUDE_EXTENSION_DIRECTORY_PREFIX = "anthropic.claude-code-";
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
const MACOS_APPLICATION_DIRECTORIES = ["/Applications", "~/Applications"] as const;
const CODEX_EXTENSION_BINARY_CANDIDATES = [
  ["bin", "windows-x86_64", "codex.exe"],
  ["bin", "windows-x64", "codex.exe"],
  ["bin", "darwin-arm64", "codex"],
  ["bin", "darwin-x64", "codex"],
  ["bin", "darwin-universal", "codex"],
  ["bin", "macos-arm64", "codex"],
  ["bin", "macos-x64", "codex"],
  ["bin", "macos-universal", "codex"]
] as const;
const CLAUDE_EXTENSION_BINARY_CANDIDATES = [
  ["resources", "native-binary", "claude.exe"],
  ["resources", "native-binary", "claude"],
  ["resources", "native-binary", "claude-cli"],
  ["bin", "darwin-arm64", "claude"],
  ["bin", "darwin-x64", "claude"],
  ["bin", "darwin-universal", "claude"],
  ["bin", "macos-arm64", "claude"],
  ["bin", "macos-x64", "claude"],
  ["bin", "macos-universal", "claude"]
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

function currentPlatform(options: { platform?: NodeJS.Platform } = {}): NodeJS.Platform {
  return options.platform ?? process.platform;
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

function currentUserHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.USERPROFILE || env.HOME || os.homedir();
}

function expandHomePath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(currentUserHome(env), value.slice(2));
  }

  return value;
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

function extractPackageVersion(directoryName: string, prefix: string): number[] | undefined {
  if (!directoryName.startsWith(prefix)) {
    return undefined;
  }

  const versionPart = directoryName
    .slice(prefix.length)
    .replace(/_[^_]+__.*$/i, "")
    .replace(/-(win32|darwin|linux)\b.*$/i, "");
  const versionSegments = parseNumericVersionSegments(versionPart);
  return versionSegments.length > 0 ? versionSegments : undefined;
}

function extractWindowsCodexPackageVersion(directoryName: string): number[] | undefined {
  return extractPackageVersion(directoryName, WINDOWS_OFFICIAL_CODEX_PACKAGE_PREFIX);
}

function extractCodexExtensionVersion(directoryName: string): number[] | undefined {
  return extractPackageVersion(directoryName, WINDOWS_CODEX_EXTENSION_DIRECTORY_PREFIX);
}

function extractClaudeExtensionVersion(directoryName: string): number[] | undefined {
  return extractPackageVersion(directoryName, WINDOWS_CLAUDE_EXTENSION_DIRECTORY_PREFIX);
}

function windowsProgramsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ProgramFiles || "C:\\Program Files";
}

function windowsOfficialCodexCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(currentUserHome(env), ...WINDOWS_OFFICIAL_CODEX_CACHE_PARTS);
}

function windowsExtensionRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const userHome = currentUserHome(env);
  return [".vscode", ".cursor", ".windsurf"].map((directory) => path.join(userHome, directory, "extensions"));
}

function macExtensionRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const userHome = currentUserHome(env);
  return [".vscode", ".cursor", ".windsurf"].map((directory) => path.join(userHome, directory, "extensions"));
}

function findCandidateBinary(extensionRoot: string, candidates: readonly (readonly string[])[]): string | undefined {
  return candidates
    .map((parts) => path.join(extensionRoot, ...parts))
    .find((candidatePath) => fileExists(candidatePath));
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

function isBareClaudeCommand(command: string): boolean {
  const normalizedCommand = normalizeCommand(command)?.toLowerCase();
  if (!normalizedCommand) {
    return false;
  }

  if (normalizedCommand.includes("\\") || normalizedCommand.includes("/") || path.isAbsolute(normalizedCommand)) {
    return false;
  }

  return (
    normalizedCommand === "claude" ||
    normalizedCommand === "claude.cmd" ||
    normalizedCommand === "claude.exe" ||
    normalizedCommand === "claude.ps1"
  );
}

function isWindowsOfficialCodexWindowsAppsPath(command: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  const normalizedPath = normalizeWindowsPathForMatch(normalizedCommand);
  return normalizedPath.includes("\\windowsapps\\openai.codex_") && normalizedPath.endsWith("\\app\\resources\\codex.exe");
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

function isWindowsEditorBundledClaudeCommand(command: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  const normalizedPath = normalizeWindowsPathForMatch(normalizedCommand);
  if (!normalizedPath.endsWith("\\claude.exe")) {
    return false;
  }

  return normalizedPath.includes("\\anthropic.claude-code-") && normalizedPath.includes("\\resources\\native-binary\\");
}

function isMacCodexAppCommand(command: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  return normalizedCommand.replace(/\\/g, "/").toLowerCase().endsWith("/codex.app/contents/macos/codex");
}

function isMacEditorBundledCodexCommand(command: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  const normalizedPath = normalizedCommand.replace(/\\/g, "/").toLowerCase();
  return normalizedPath.endsWith("/codex") && normalizedPath.includes("/extensions/openai.chatgpt-");
}

function isMacClaudeAppCommand(command: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  return normalizedCommand.replace(/\\/g, "/").toLowerCase().endsWith("/claude.app/contents/macos/claude");
}

function isMacEditorBundledClaudeCommand(command: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  const normalizedPath = normalizedCommand.replace(/\\/g, "/").toLowerCase();
  return normalizedPath.endsWith("/claude") && normalizedPath.includes("/extensions/anthropic.claude-code-");
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

function findPreferredWindowsEditorBundledCodexExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: Array<{ candidatePath: string; packageName: string; version: number[] }> = [];

  for (const rootPath of windowsExtensionRoots(env)) {
    if (!fs.existsSync(rootPath)) {
      continue;
    }

    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const version = extractCodexExtensionVersion(entry.name);
      if (!version) {
        continue;
      }

      const candidatePath = findCandidateBinary(path.join(rootPath, entry.name), CODEX_EXTENSION_BINARY_CANDIDATES);
      if (!candidatePath) {
        continue;
      }

      candidates.push({
        candidatePath,
        packageName: entry.name,
        version
      });
    }
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

function findPreferredWindowsClaudeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: Array<{ candidatePath: string; packageName: string; version: number[] }> = [];

  for (const rootPath of windowsExtensionRoots(env)) {
    if (!fs.existsSync(rootPath)) {
      continue;
    }

    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const version = extractClaudeExtensionVersion(entry.name);
      if (!version) {
        continue;
      }

      const candidatePath = findCandidateBinary(path.join(rootPath, entry.name), CLAUDE_EXTENSION_BINARY_CANDIDATES);
      if (!candidatePath) {
        continue;
      }

      candidates.push({
        candidatePath,
        packageName: entry.name,
        version
      });
    }
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

function findPreferredMacAppExecutable(appName: string, binaryNames: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const directory of MACOS_APPLICATION_DIRECTORIES) {
    const rootPath = expandHomePath(directory, env);
    for (const binaryName of binaryNames) {
      const candidatePath = path.join(rootPath, `${appName}.app`, "Contents", "MacOS", binaryName);
      if (fileExists(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return undefined;
}

function findPreferredMacCodexExtensionExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: Array<{ candidatePath: string; packageName: string; version: number[] }> = [];

  for (const rootPath of macExtensionRoots(env)) {
    if (!fs.existsSync(rootPath)) {
      continue;
    }

    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const version = extractCodexExtensionVersion(entry.name);
      if (!version) {
        continue;
      }

      const candidatePath = findCandidateBinary(path.join(rootPath, entry.name), CODEX_EXTENSION_BINARY_CANDIDATES);
      if (!candidatePath) {
        continue;
      }

      candidates.push({
        candidatePath,
        packageName: entry.name,
        version
      });
    }
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

function findPreferredMacClaudeExtensionExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: Array<{ candidatePath: string; packageName: string; version: number[] }> = [];

  for (const rootPath of macExtensionRoots(env)) {
    if (!fs.existsSync(rootPath)) {
      continue;
    }

    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const version = extractClaudeExtensionVersion(entry.name);
      if (!version) {
        continue;
      }

      const candidatePath = findCandidateBinary(path.join(rootPath, entry.name), CLAUDE_EXTENSION_BINARY_CANDIDATES);
      if (!candidatePath) {
        continue;
      }

      candidates.push({
        candidatePath,
        packageName: entry.name,
        version
      });
    }
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
    normalizeWindowsPathForMatch(normalizedCommand) === normalizeWindowsPathForMatch(windowsOfficialCodexCachePath(env))
  );
}

function shouldRequireManagedWindowsCodexExecutable(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  return (
    isWindowsOfficialCodexWindowsAppsPath(normalizedCommand) ||
    normalizeWindowsPathForMatch(normalizedCommand) === normalizeWindowsPathForMatch(windowsOfficialCodexCachePath(env))
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
  if (preferredExecutable) {
    return {
      command: preferredExecutable,
      args: []
    };
  }

  const bundledExecutable = findPreferredWindowsEditorBundledCodexExecutable(options.env);
  if (bundledExecutable) {
    return {
      command: bundledExecutable,
      args: []
    };
  }

  return undefined;
}

function shouldTryPreferredWindowsClaudeCommand(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  return (
    isBareClaudeCommand(normalizedCommand) ||
    isWindowsEditorBundledClaudeCommand(normalizedCommand) ||
    normalizeWindowsPathForMatch(normalizedCommand) ===
      normalizeWindowsPathForMatch(findPreferredWindowsClaudeExecutable(env) ?? "")
  );
}

function resolvePreferredWindowsClaudeCommand(
  command: string,
  options: ResolveClaudeCommandOptions = {}
): ResolvedCommand | undefined {
  if (!shouldTryPreferredWindowsClaudeCommand(command, options.env)) {
    return undefined;
  }

  const preferredExecutable = findPreferredWindowsClaudeExecutable(options.env);
  if (!preferredExecutable) {
    return undefined;
  }

  return {
    command: preferredExecutable,
    args: []
  };
}

function shouldTryPreferredMacCodexCommand(command: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  return isBareCodexCommand(normalizedCommand) || isMacCodexAppCommand(normalizedCommand) || isMacEditorBundledCodexCommand(normalizedCommand);
}

function resolvePreferredMacCodexCommand(
  command: string,
  options: ResolveCodexCommandOptions = {}
): ResolvedCommand | undefined {
  if (!shouldTryPreferredMacCodexCommand(command)) {
    return undefined;
  }

  const appExecutable = findPreferredMacAppExecutable("Codex", ["Codex", "codex"], options.env);
  if (appExecutable) {
    return {
      command: appExecutable,
      args: []
    };
  }

  const extensionExecutable = findPreferredMacCodexExtensionExecutable(options.env);
  if (extensionExecutable) {
    return {
      command: extensionExecutable,
      args: []
    };
  }

  return undefined;
}

function shouldTryPreferredMacClaudeCommand(command: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return false;
  }

  return isBareClaudeCommand(normalizedCommand) || isMacClaudeAppCommand(normalizedCommand) || isMacEditorBundledClaudeCommand(normalizedCommand);
}

function resolvePreferredMacClaudeCommand(
  command: string,
  options: ResolveClaudeCommandOptions = {}
): ResolvedCommand | undefined {
  if (!shouldTryPreferredMacClaudeCommand(command)) {
    return undefined;
  }

  const appExecutable = findPreferredMacAppExecutable("Claude", ["Claude", "claude"], options.env);
  if (appExecutable) {
    return {
      command: appExecutable,
      args: []
    };
  }

  const extensionExecutable = findPreferredMacClaudeExtensionExecutable(options.env);
  if (extensionExecutable) {
    return {
      command: extensionExecutable,
      args: []
    };
  }

  return undefined;
}

export function ensureCodexCommandReady(command: string, options: ResolveCodexCommandOptions = {}): ResolvedCommand {
  const resolvedCommand = resolveCodexCommand(command, options);
  const platform = currentPlatform(options);

  if (platform !== "win32") {
    if (path.isAbsolute(resolvedCommand.command) && !fileExists(resolvedCommand.command)) {
      throw new Error(`Codex executable not found: ${resolvedCommand.command}`);
    }
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
  const platform = currentPlatform(options);
  if (platform === "darwin") {
    return resolvePreferredMacCodexCommand(command, options) ?? { command, args: [] };
  }

  if (platform !== "win32") {
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

export function ensureClaudeCommandReady(command: string, options: ResolveClaudeCommandOptions = {}): ResolvedCommand {
  const resolvedCommand = resolveClaudeCommand(command, options);
  const platform = currentPlatform(options);

  if (platform !== "win32") {
    if (path.isAbsolute(resolvedCommand.command) && !fileExists(resolvedCommand.command)) {
      throw new Error(`Claude executable not found: ${resolvedCommand.command}`);
    }
    return resolvedCommand;
  }

  if (
    resolvedCommand.command !== "pwsh" &&
    WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS.has(path.extname(resolvedCommand.command).toLowerCase()) &&
    !fileExists(resolvedCommand.command)
  ) {
    throw new Error(`Claude executable not found: ${resolvedCommand.command}`);
  }

  return resolvedCommand;
}

export function resolveClaudeCommand(command: string, options: ResolveClaudeCommandOptions = {}): ResolvedCommand {
  const platform = currentPlatform(options);
  if (platform === "darwin") {
    return resolvePreferredMacClaudeCommand(command, options) ?? { command, args: [] };
  }

  if (platform !== "win32") {
    return {
      command,
      args: []
    };
  }

  return (
    resolvePreferredWindowsClaudeCommand(command, options) ??
    resolveWindowsPwshCommand(command, options) ?? {
      command,
      args: []
    }
  );
}
