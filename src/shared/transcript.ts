export function stripInjectedPromptPreamble(value: string): string {
  let text = value.trim();
  if (!text) {
    return "";
  }

  text = text.replace(/^# AGENTS\.md instructions for [^\r\n]*\r?\n*/i, "").trimStart();

  const blockPattern = /^\s*<(INSTRUCTIONS|environment_context)>[\s\S]*?<\/\1>\s*/i;
  while (blockPattern.test(text)) {
    text = text.replace(blockPattern, "").trimStart();
  }

  return text.trim();
}

export function formatTranscriptTimestamp(value: string): string {
  const isoMatch = value.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]} ${isoMatch[3]}:${isoMatch[4]}:${isoMatch[5]}`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  const seconds = String(parsed.getSeconds()).padStart(2, "0");
  return `${month}-${day} ${hours}:${minutes}:${seconds}`;
}
