// Pure transcript helpers for TerminalView: display truncation, search indexing,
// and tool-call summarization. Extracted so they're independently unit-testable
// (repo convention) and don't bloat the rendering component. `highlightText`
// stays in TerminalView since it returns JSX.

import type { DisplayEvent } from "./agent-output-parser.js";

const FILE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\w.-]+[\\/])[\w .@()[\]{}+=,;!#$%&'-]+(?:[\\/][\w .@()[\]{}+=,;!#$%&'-]+)*|\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|sql|py|rs|go|java|cs|yml|yaml|toml)\b/i;

export const MAX_DISPLAY_EVENTS = 2000;

export function truncateEventsForDisplay(events: DisplayEvent[]): { events: DisplayEvent[]; truncated: boolean } {
  if (events.length <= MAX_DISPLAY_EVENTS) return { events, truncated: false };
  return { events: events.slice(0, MAX_DISPLAY_EVENTS), truncated: true };
}

export const SEARCH_FILTERS = [
  { id: "assistant", label: "Assistant" },
  { id: "tool_call", label: "Tools" },
  { id: "tool_result", label: "Results" },
  { id: "error", label: "Errors" },
  { id: "file", label: "Files" },
] as const;

export type SearchFilter = typeof SEARCH_FILTERS[number]["id"];

export interface TranscriptSearchEntry {
  idx: number;
  event: DisplayEvent;
  text: string;
  filters: SearchFilter[];
}

export function normalizedSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

function stringifySearchValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function eventSearchText(event: DisplayEvent): string {
  switch (event.kind) {
    case "assistant":
    case "thinking":
    case "raw":
      return event.text;
    case "tool_use":
      return [event.name, event.input, stringifySearchValue(event.inputParsed)].filter(Boolean).join("\n");
    case "tool_result":
      return [event.toolName, event.output].filter(Boolean).join("\n");
    case "result":
      return [event.success ? "Completed" : "Failed", event.result, event.model].filter(Boolean).join("\n");
    case "init":
      return [event.model, event.sessionId, event.cwd, event.tools.join(" "), event.permissionMode].filter(Boolean).join("\n");
    case "task_started":
      return [event.description, event.taskType, event.taskId].filter(Boolean).join("\n");
    case "notification":
      return [event.key, event.text, event.priority].filter(Boolean).join("\n");
    case "rate_limit":
      return [event.status, event.rateLimitType, event.overageStatus, event.overageDisabledReason].filter(Boolean).join("\n");
    case "image":
      return event.mediaType;
  }
}

function eventSearchFilters(event: DisplayEvent, text: string): SearchFilter[] {
  const filters: SearchFilter[] = [];
  if (event.kind === "assistant") filters.push("assistant");
  if (event.kind === "tool_use") filters.push("tool_call");
  if (event.kind === "tool_result") filters.push("tool_result");
  if (
    (event.kind === "tool_result" && event.isError)
    || (event.kind === "result" && !event.success)
    || (event.kind === "raw" && /\b(error|failed|exception|traceback)\b/i.test(event.text))
  ) {
    filters.push("error");
  }
  if (FILE_PATH_PATTERN.test(text)) filters.push("file");
  return filters;
}

export function buildTranscriptSearchEntries(
  events: DisplayEvent[],
  query: string,
  filters: ReadonlySet<SearchFilter> = new Set(),
): TranscriptSearchEntry[] {
  const needle = normalizedSearchQuery(query);
  const hasFilters = filters.size > 0;

  return events.flatMap((event, idx) => {
    const text = eventSearchText(event);
    const entryFilters = eventSearchFilters(event, text);
    const matchesQuery = needle.length === 0 || text.toLowerCase().includes(needle);
    const matchesFilters = !hasFilters || entryFilters.some((filter) => filters.has(filter));

    return matchesQuery && matchesFilters ? [{ idx, event, text, filters: entryFilters }] : [];
  });
}

export function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export function isSkillRead(name: string, input: Record<string, unknown>): string | null {
  if (name !== "Read") return null;
  const path = (input.file_path as string) || "";
  const normalized = path.replace(/\\/g, "/");
  const skillMatch = normalized.match(/\.claude\/skills\/([^/]+)\/SKILL\.md$/i);
  if (skillMatch) return skillMatch[1];
  if (normalized.toUpperCase().endsWith("/SKILL.MD") || normalized.toUpperCase() === "SKILL.MD") {
    const parts = normalized.split("/");
    return parts[parts.length - 2] || "skill";
  }
  return null;
}

export function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
    case "view": {
      const skillName = isSkillRead(name, input);
      if (skillName) return `Loading skill: ${skillName}`;
      return `Reading ${basename((input.file_path as string) || (input.path as string) || "file")}`;
    }
    case "Edit":
    case "edit":
      return `Editing ${basename((input.file_path as string) || (input.path as string) || "file")}`;
    case "Write":
    case "create":
      return `Writing ${basename((input.file_path as string) || (input.path as string) || "file")}`;
    case "Bash":
    case "powershell":
    case "shell": {
      const cmd = ((input.command as string) || "").slice(0, 80);
      return `Running: ${cmd || "command"}`;
    }
    case "Grep":
    case "grep":
      return `Searching for "${input.pattern || "pattern"}"`;
    case "Glob":
    case "glob":
      return `Finding ${input.pattern || "files"}`;
    case "Agent":
      return `Subagent: ${(input.description as string) || (input.prompt as string) || "delegating to agent"}`;
    case "WebSearch":
    case "web_search":
      return "Searching web";
    case "WebFetch":
    case "mcp__web_reader__webReader":
      return "Fetching URL";
    case "TaskCreate":
      return `Task: ${(input.subject as string) || "new task"}`;
    case "TaskUpdate": {
      const status = input.status as string;
      const subject = input.subject as string;
      if (status === "completed") return `Done: ${subject || "task"}`;
      if (status === "in_progress") return `Starting: ${subject || "task"}`;
      if (status === "deleted") return `Removed: ${subject || "task"}`;
      return `Task update: ${subject || "task"}`;
    }
    case "TaskList":
      return "Listing tasks";
    case "TaskGet":
      return "Getting task details";
    default:
      return name;
  }
}
