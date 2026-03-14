import fs from "node:fs";
import path from "node:path";

import { ReadFileResult } from "../shared/types";
import { truncateText } from "../shared/utils";

export function materializeBinaryReadResult(
  dataDir: string,
  result: ReadFileResult,
  fallbackPath: string,
  filePrefix?: string
): string {
  if (!result.base64Content) {
    throw new Error("Binary read result is missing base64Content");
  }

  const fileName = path.basename(result.path || fallbackPath || "file.bin");
  const outputName = filePrefix ? `${filePrefix}_${fileName}` : fileName;
  const outboxPath = path.join(dataDir, "outbox", outputName);

  fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
  fs.writeFileSync(outboxPath, Buffer.from(result.base64Content, "base64"));
  return outboxPath;
}

export function buildReadFilePreviewText(result: ReadFileResult): string {
  return [
    `文件: ${result.path}`,
    `类型: ${result.mimeType}`,
    `大小: ${result.size} bytes`,
    "",
    truncateText(result.content || "(空文件)", 3500)
  ].join("\n");
}
