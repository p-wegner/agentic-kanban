// Pure string-parsing helpers for agent session output (JSONL stdout) and
// JSON-encoded DB columns. No dependencies on the database or other services.

export function safeParseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function extractAssistantMessage(data: string): string | null {
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type === "assistant") {
        const content = (obj.message as { content?: unknown[] })?.content ?? [];
        for (const block of [...content].reverse() as { type: string; text?: string }[]) {
          if (block.type === "text" && block.text?.trim()) return block.text.trim();
        }
      }
      if (obj.type === "assistant.message") {
        const messageData = obj.data as Record<string, unknown> | undefined;
        const raw = messageData?.content;
        const contentStr = typeof raw === "string" ? raw
          : Array.isArray(raw)
            ? (raw as { type?: string; text?: string }[])
                .filter(b => b.type === "text" && typeof b.text === "string")
                .map(b => b.text as string)
                .join("\n")
            : "";
        if (contentStr.trim()) return contentStr.trim();
      }
      if (
        obj.type === "item.completed"
        && (obj.item as { type?: string; text?: string } | undefined)?.type === "agent_message"
      ) {
        const text = (obj.item as { text?: string }).text;
        if (text?.trim()) return text.trim();
      }
    } catch { /* ignore non-JSON output */ }
  }
  return null;
}

export function extractToolName(data: string): string | null {
  for (const line of data.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type !== "assistant") continue;
      const content = (obj.message as { content?: unknown[] })?.content ?? [];
      for (const block of content as { type: string; name?: string }[]) {
        if (block.type === "tool_use" && block.name) return block.name;
      }
    } catch { /* ignore non-JSON output */ }
  }
  return null;
}
