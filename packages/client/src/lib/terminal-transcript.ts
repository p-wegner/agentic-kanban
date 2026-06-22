// Pure transcript helpers for TerminalView: display truncation, search indexing,
// and tool-call summarization. Extracted so they're independently unit-testable
// (repo convention) and don't bloat the rendering component. `highlightText`
// stays in TerminalView since it returns JSX.

import type { DisplayEvent, AgentOutputFormat } from "./agent-output-parser.js";
import { createAgentOutputParser } from "./agent-output-parser.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import { extractMeaningfulOutput } from "@agentic-kanban/shared";

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
    return String(value as string);
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

// ── Message → DisplayEvent conversion ──────────────────────────────────────
// Pure core of TerminalView's re-parse effect: turn the raw AgentOutputMessage[]
// into the DisplayEvent[] the transcript renders. The component keeps the
// setDisplayEvents/setExpandedSections side effects; only the conversion lives here.

/** parseOutput==="false": each message becomes a raw line; empties dropped. */
export function buildRawDisplayEvents(messages: AgentOutputMessage[]): DisplayEvent[] {
  return messages
    .map((msg): DisplayEvent => {
      if (msg.type === "exit") {
        return { kind: "raw", text: `Process exited with code ${msg.exitCode ?? "unknown"}` };
      }
      return { kind: "raw", text: msg.data || "" };
    })
    .filter((e) => e.kind === "raw" && e.text.length > 0);
}

/**
 * Convert agent output to display events. With parseOutput==="false" the output
 * is shown verbatim (raw lines); otherwise it is run through the provider parser,
 * with exit / auto-bisect / stderr messages handled specially before flush.
 */
export function buildDisplayEventsFromMessages(
  messages: AgentOutputMessage[],
  parseOutput: "minimal" | "false",
  outputFormat: AgentOutputFormat,
): DisplayEvent[] {
  if (parseOutput === "false") return buildRawDisplayEvents(messages);

  const parser = createAgentOutputParser(outputFormat);
  const events: DisplayEvent[] = [];

  for (const msg of messages) {
    if (msg.type === "exit") {
      events.push({ kind: "raw", text: `Process exited with code ${msg.exitCode ?? "unknown"}` });
      continue;
    }
    if (msg.type === "bisect") {
      try {
        const parsed = JSON.parse(msg.data || "{}") as { breakingCommitSha?: string; message?: string; failingTestName?: string; status?: string };
        events.push({
          kind: "raw",
          text: parsed.breakingCommitSha
            ? `Auto-bisect result: ${parsed.breakingCommitSha} ${parsed.message ?? ""}${parsed.failingTestName ? `\nFailing test: ${parsed.failingTestName}` : ""}`
            : `Auto-bisect result: ${parsed.status ?? "finished"}`,
        });
      } catch {
        events.push({ kind: "raw", text: msg.data || "Auto-bisect result" });
      }
      continue;
    }
    if (msg.type === "stderr") {
      events.push({ kind: "raw", text: msg.data || "" });
      continue;
    }
    if (msg.data) {
      events.push(...parser.feed(msg.data + "\n"));
    }
  }

  events.push(...parser.flush());
  return events;
}

// ── Subagent grouping ───────────────────────────────────────────────────────

/** Start/end span of an Agent subagent section plus its description/type. */
export interface SubagentGroup {
  startIdx: number;
  endIdx: number;
  description: string;
  subagentType: string;
}

export interface SubagentGrouping {
  /** Agent tool_use_ids that started (task_started) but have no Agent tool_result yet. */
  activeSubagentToolUseIds: Set<string>;
  /** toolUseId → the span (startIdx..endIdx) of its subagent section; open agents run to the end. */
  subagentGroups: Map<string, SubagentGroup>;
  /** event index → toolUseId of the containing subagent group. */
  eventToSubagent: Map<number, string>;
}

/**
 * Derive subagent grouping from the visible event list via ID matching
 * (task_started.toolUseId → Agent tool_use.id → Agent tool_result.toolUseId).
 * Pure over `visibleEvents`; feeds the renderer's RenderContext.
 */
export function computeSubagentGrouping(visibleEvents: DisplayEvent[]): SubagentGrouping {
  // (a) active set: started but not completed.
  const startedIds = new Set<string>();
  const completedIds = new Set<string>();
  for (const ev of visibleEvents) {
    if (ev.kind === "task_started" && ev.toolUseId) startedIds.add(ev.toolUseId);
    if (ev.kind === "tool_result" && ev.toolName === "Agent" && ev.toolUseId) completedIds.add(ev.toolUseId);
  }
  const activeSubagentToolUseIds = new Set<string>();
  for (const id of startedIds) {
    if (!completedIds.has(id)) activeSubagentToolUseIds.add(id);
  }

  // (b) groups: span each Agent tool_use to its tool_result; still-open agents run to the end.
  const subagentGroups = new Map<string, SubagentGroup>();
  const openAgents = new Map<string, { idx: number; description: string; subagentType: string }>();
  for (let i = 0; i < visibleEvents.length; i++) {
    const ev = visibleEvents[i];
    if (ev.kind === "tool_use" && ev.name === "Agent" && ev.id) {
      openAgents.set(ev.id, {
        idx: i,
        description: (ev.inputParsed?.description as string) || (ev.inputParsed?.prompt as string) || "",
        subagentType: (ev.inputParsed?.subagent_type as string) || "",
      });
    }
    if (ev.kind === "tool_result" && ev.toolName === "Agent" && ev.toolUseId && openAgents.has(ev.toolUseId)) {
      const opener = openAgents.get(ev.toolUseId)!;
      subagentGroups.set(ev.toolUseId, {
        startIdx: opener.idx,
        endIdx: i,
        description: opener.description,
        subagentType: opener.subagentType,
      });
      openAgents.delete(ev.toolUseId);
    }
  }
  for (const [id, opener] of openAgents) {
    subagentGroups.set(id, {
      startIdx: opener.idx,
      endIdx: visibleEvents.length - 1,
      description: opener.description,
      subagentType: opener.subagentType,
    });
  }

  // (c) index → containing group.
  const eventToSubagent = new Map<number, string>();
  for (const [toolUseId, group] of subagentGroups) {
    for (let i = group.startIdx; i <= group.endIdx; i++) eventToSubagent.set(i, toolUseId);
  }

  return { activeSubagentToolUseIds, subagentGroups, eventToSubagent };
}

// ── Scrollbar markers + connection status + download ────────────────────────

/** Tailwind background class for an event's scrollbar mini-map marker. */
export function markerColorForEvent(event: DisplayEvent): string {
  switch (event.kind) {
    case "assistant": return "bg-green-500";
    case "thinking": return "bg-gray-500";
    case "tool_use": return event.name === "Agent" ? "bg-brand-500" : "bg-yellow-500";
    case "tool_result": return event.isError ? "bg-red-500" : "bg-brand-500";
    case "result": return event.success ? "bg-emerald-400" : "bg-red-400";
    case "init": return "bg-cyan-400";
    case "task_started": return "bg-blue-500";
    case "notification": return event.key === "user" ? "bg-blue-500" : "bg-orange-500";
    case "rate_limit": return "bg-yellow-500";
    default: return "bg-gray-600";
  }
}

export const CONNECTION_STATUS_COLORS: Record<string, string> = {
  connecting: "bg-yellow-400",
  open: "bg-green-400",
  closed: "bg-gray-400",
  error: "bg-red-400",
};

export const CONNECTION_STATUS_LABELS: Record<string, string> = {
  connecting: "Connecting...",
  open: "Connected",
  closed: "Disconnected",
  error: "Connection Error",
};

/** Non-DOM core of the transcript download: the file body text. */
export function buildSessionDownloadText(messages: AgentOutputMessage[]): string {
  return extractMeaningfulOutput(messages.map((m) => ({ ...m, data: m.data ?? null })), 10000).join("\n");
}

/** Download filename for a session transcript. */
export function buildSessionDownloadFilename(sessionId?: string): string {
  return sessionId ? `session-${sessionId}.txt` : "session-output.txt";
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
      return `Searching for "${(input.pattern as string) || "pattern"}"`;
    case "Glob":
    case "glob":
      return `Finding ${(input.pattern as string) || "files"}`;
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
