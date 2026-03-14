import fs from "node:fs";
import path from "node:path";

import mime from "mime-types";

import { FsNode, ReadFileResult, WorkspaceConfig } from "./types";

const TEXT_PREVIEW_LIMIT = 256 * 1024;
const DIRECTORY_PAGE_LIMIT = 200;

export function ensureInsideWorkspace(workspace: WorkspaceConfig, requestedPath = "."): string {
  const workspaceRoot = path.resolve(workspace.rootPath);
  const candidate = path.resolve(workspaceRoot, requestedPath);

  if (candidate !== workspaceRoot && !candidate.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace root: ${requestedPath}`);
  }

  return candidate;
}

export function toWorkspaceRelativePath(workspace: WorkspaceConfig, absolutePath: string): string {
  const root = path.resolve(workspace.rootPath);
  const relativePath = path.relative(root, absolutePath);
  return relativePath === "" ? "." : relativePath.replaceAll("\\", "/");
}

export function listWorkspaceDirectory(workspace: WorkspaceConfig, requestedPath = "."): FsNode[] {
  const absolutePath = ensureInsideWorkspace(workspace, requestedPath);
  const entries = fs.readdirSync(absolutePath, { withFileTypes: true });

  return entries
    .map((entry) => {
      const entryAbsolutePath = path.join(absolutePath, entry.name);
      const stats = fs.statSync(entryAbsolutePath);
      const relativePath = toWorkspaceRelativePath(workspace, entryAbsolutePath);

      return {
        path: relativePath,
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
        size: entry.isDirectory() ? undefined : stats.size,
        modifiedAt: stats.mtime.toISOString(),
        mimeType: entry.isDirectory()
          ? undefined
          : (mime.lookup(entryAbsolutePath) || "application/octet-stream").toString()
      } satisfies FsNode;
    })
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    })
    .slice(0, DIRECTORY_PAGE_LIMIT);
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  for (const byte of sample.values()) {
    if (byte === 0) {
      return true;
    }
  }

  return false;
}

export function readWorkspaceFile(workspace: WorkspaceConfig, requestedPath: string): ReadFileResult {
  const absolutePath = ensureInsideWorkspace(workspace, requestedPath);
  const stats = fs.statSync(absolutePath);

  if (stats.isDirectory()) {
    throw new Error(`Cannot preview a directory: ${requestedPath}`);
  }

  const buffer = fs.readFileSync(absolutePath);
  const isBinary = looksBinary(buffer);
  const mimeType = (mime.lookup(absolutePath) || "application/octet-stream").toString();

  if (isBinary) {
    return {
      path: toWorkspaceRelativePath(workspace, absolutePath),
      mimeType,
      size: stats.size,
      encoding: "binary",
      base64Content: buffer.toString("base64"),
      isBinary: true
    };
  }

  return {
    path: toWorkspaceRelativePath(workspace, absolutePath),
    mimeType,
    size: stats.size,
    encoding: "utf8",
    isBinary: false,
    content: buffer.subarray(0, TEXT_PREVIEW_LIMIT).toString("utf8")
  };
}
