import fs from "node:fs";
import path from "node:path";

import { AttachmentMeta, WorkspaceConfig } from "../shared/types";
import { ensureInsideWorkspace } from "../shared/fs-utils";

export async function materializeAttachments(
  workspace: WorkspaceConfig,
  attachments: AttachmentMeta[],
  gatewayUrl: string | undefined,
  deviceToken: string | undefined
): Promise<AttachmentMeta[]> {
  if (attachments.length === 0 || !gatewayUrl || !deviceToken) {
    return attachments;
  }

  const attachmentRoot = ensureInsideWorkspace(workspace, path.join(".ftb", "attachments"));
  fs.mkdirSync(attachmentRoot, { recursive: true });
  const materialized: AttachmentMeta[] = [];

  for (const attachment of attachments) {
    const response = await fetch(`${gatewayUrl}/api/attachments/${attachment.id}`, {
      headers: {
        "x-device-token": deviceToken
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to download attachment ${attachment.id}: ${response.status}`);
    }

    const destinationPath = path.join(attachmentRoot, `${attachment.id}_${attachment.name}`);
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(destinationPath, Buffer.from(arrayBuffer));

    materialized.push({
      ...attachment,
      storedPath: destinationPath
    });
  }

  return materialized;
}

export function buildPromptWithAttachments(prompt: string, attachments: AttachmentMeta[]): string {
  if (attachments.length === 0) {
    return prompt;
  }

  const attachmentText = attachments
    .map((attachment) => `- ${attachment.name}: ${attachment.storedPath}`)
    .join("\n");

  return `${prompt}\n\nAttached local files:\n${attachmentText}`;
}
