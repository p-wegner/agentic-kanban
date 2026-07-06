// Offline session-summary parser (#951).
//
// This module used to be a forked parser stack: it re-implemented Claude,
// Codex, and Copilot JSONL interpretation independently of the canonical
// per-provider stream parsers in ./agent-stream/*, had no Pi support at all,
// and had already drifted (Codex `file_change`/`reasoning` items were silently
// dropped, so filesEdited/filesWritten missed every native Codex edit).
//
// It now CONSUMES the canonical parsers: each stored JSONL line is routed to
// the provider parser (agent-stream/{claude,codex,copilot,pi}.ts via
// detectAgentEventProvider) and the resulting structured display events are
// folded into the summary aggregates. Event-field interpretation lives in
// exactly one place — extend agent-stream, never re-parse raw JSONL here.

import type {
  AgentDisplayToolResultEvent,
  AgentDisplayToolUseEvent,
  AgentStreamProvider,
  ParsedStreamEvent,
} from "./agent-stream/types.js";
import { createAgentStreamParseContext } from "./agent-stream/shared.js";
import { parseClaudeEvent } from "./agent-stream/claude.js";
import { parseCodexEvent } from "./agent-stream/codex.js";
import { parseCopilotEvent } from "./agent-stream/copilot.js";
import { parsePiEvent } from "./agent-stream/pi.js";
import { detectAgentEventProvider } from "./agent-stream/detect-provider.js";
import { classifyToolActivity } from "./agent-stream/tool-activity.js";

export interface TaskSummaryItem {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
}

export interface ToolUsePattern {
  tool: string;
  count: number;
  failedCount: number;
}

export interface RepeatedCommand {
  command: string;
  count: number;
}

export interface SessionSummary {
  overview: string;
  agentSummary: string | null;
  actions: Array<{ type: string; files?: string[]; commands?: string[] }>;
  keyExcerpts: string[];
  errors: string[];
  filesRead: string[];
  filesEdited: string[];
  filesWritten: string[];
  commandsRun: string[];
  model: string;
  tasks: TaskSummaryItem[];
  rateLimits: Array<{ rateLimitType: string; status: string; resetsAt?: number; overageStatus?: string }>;
  toolUsePatterns: ToolUsePattern[];
  repeatedCommands: RepeatedCommand[];
}

export function formatDurationStr(diffMs: number): string {
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

// ── Accumulator ───────────────────────────────────────────────────────

/** Mutable accumulator the parsed display events are folded into. */
interface SummaryAccumulator {
  /** Per-tool invocation and failure counts. */
  toolUseCounts: Map<string, { count: number; failedCount: number }>;
  /** Normalized command → repetition count. */
  commandCounts: Map<string, number>;
  filesRead: Set<string>;
  filesEdited: Set<string>;
  filesWritten: Set<string>;
  /** All shell commands executed, in order. */
  commandsRun: string[];
  /** Up to 10 representative assistant text excerpts (≤300 chars each). */
  keyExcerpts: string[];
  /** Error messages from failed tool calls / failed turns (≤10). */
  errors: string[];
  /** Most recently observed model name (generic provider placeholders never overwrite a real name). */
  model: string;
  /** Whether an init/session-start event was seen. */
  initFound: boolean;
  /** All assistant text for the agent summary (joined with separators). */
  agentSummaryParts: string[];
  taskCounter: number;
  /** Task items tracked via TaskCreate/TaskUpdate tool calls. */
  tasksMap: Map<string, TaskSummaryItem>;
  rateLimits: SessionSummary["rateLimits"];
}

/** Provider placeholder model names that must not overwrite a real model id. */
const GENERIC_MODEL_NAMES = new Set(["codex", "copilot", "pi", "unknown"]);

function setModel(acc: SummaryAccumulator, model: string | undefined): void {
  if (!model) return;
  if (acc.model && GENERIC_MODEL_NAMES.has(model)) return;
  acc.model = model;
}

/** Record assistant text: excerpt (300-char / 10-entry caps) + agent summary. */
function addAssistantText(acc: SummaryAccumulator, text: string): void {
  // Streaming parsers can surface the same full text more than once
  // (e.g. Pi text_end + message_end); skip exact consecutive repeats.
  if (acc.agentSummaryParts[acc.agentSummaryParts.length - 1] === text) return;
  if (acc.keyExcerpts.length < 10) {
    acc.keyExcerpts.push(text.length > 300 ? text.slice(0, 300) + "..." : text);
  }
  acc.agentSummaryParts.push(text);
}

function addError(acc: SummaryAccumulator, message: string): void {
  if (acc.errors.length < 10) acc.errors.push(message);
}

function recordCommand(acc: SummaryAccumulator, command: string): void {
  const cmd = command.slice(0, 200);
  acc.commandsRun.push(cmd);
  const normCmd = cmd.replace(/\s+/g, " ").trim().slice(0, 80);
  acc.commandCounts.set(normCmd, (acc.commandCounts.get(normCmd) ?? 0) + 1);
}

// ── Display-event folding ─────────────────────────────────────────────

function foldToolUse(acc: SummaryAccumulator, ev: AgentDisplayToolUseEvent): void {
  const name = ev.name || "unknown";
  const existing = acc.toolUseCounts.get(name) ?? { count: 0, failedCount: 0 };
  existing.count++;
  acc.toolUseCounts.set(name, existing);

  const input = ev.inputParsed ?? {};

  if (name === "TaskCreate" && typeof input.subject === "string" && input.subject) {
    acc.taskCounter++;
    const id = String(acc.taskCounter);
    acc.tasksMap.set(id, {
      id,
      subject: input.subject,
      description: typeof input.description === "string" ? input.description : undefined,
      status: "pending",
    });
    return;
  }
  const rawTaskId = input.taskId;
  const taskId = typeof rawTaskId === "string" ? rawTaskId : typeof rawTaskId === "number" ? String(rawTaskId) : "";
  if (name === "TaskUpdate" && taskId) {
    const task = acc.tasksMap.get(taskId);
    if (task) {
      if (input.status) task.status = input.status as TaskSummaryItem["status"];
      if (typeof input.subject === "string" && input.subject) task.subject = input.subject;
      if (typeof input.description === "string" && input.description) task.description = input.description;
    }
    return;
  }

  const activity = classifyToolActivity(name, input, ev.input);
  if (!activity) return;
  if (activity.kind === "command") recordCommand(acc, activity.command);
  else if (activity.kind === "read") acc.filesRead.add(activity.path);
  else if (activity.kind === "edit") acc.filesEdited.add(activity.path);
  else acc.filesWritten.add(activity.path);
}

function foldToolResult(acc: SummaryAccumulator, ev: AgentDisplayToolResultEvent): void {
  if (ev.isError) {
    const output = ev.output || "";
    addError(acc, `${ev.toolName}: ${output.length > 200 ? output.slice(0, 200) + "..." : output}`);
    const entry = acc.toolUseCounts.get(ev.toolName);
    if (entry) entry.failedCount++;
  } else if (ev.toolName === "Agent" && ev.output) {
    // Sub-agent final reports feed the agent summary.
    acc.agentSummaryParts.push(ev.output);
  }
}

/** Fold one parsed stream event (from the canonical provider parser) into the accumulator. */
function foldParsedEvent(
  acc: SummaryAccumulator,
  provider: AgentStreamProvider,
  rawType: string,
  parsed: ParsedStreamEvent,
): void {
  if (parsed.rateLimitInfo) {
    acc.rateLimits.push({
      rateLimitType: parsed.rateLimitInfo.rateLimitType || "unknown",
      status: parsed.rateLimitInfo.status || "unknown",
      resetsAt: parsed.rateLimitInfo.resetsAt,
      overageStatus: parsed.rateLimitInfo.overageStatus,
    });
  }
  if (parsed.stats) setModel(acc, parsed.stats.model);

  // Pi streams assistant text as per-token deltas; folding those display events
  // would flood the excerpts with fragments. The message_end boundary carries
  // the complete assistant message instead.
  if (provider === "pi" && rawType === "message_end" && parsed.assistantText) {
    addAssistantText(acc, parsed.assistantText);
  }

  for (const ev of parsed.displayEvents ?? []) {
    switch (ev.kind) {
      case "init":
        acc.initFound = true;
        setModel(acc, ev.model);
        break;
      case "assistant":
        if (provider !== "pi" && ev.text) {
          setModel(acc, ev.model);
          addAssistantText(acc, ev.text);
        }
        break;
      case "tool_use":
        foldToolUse(acc, ev);
        break;
      case "tool_result":
        foldToolResult(acc, ev);
        break;
      case "result":
        setModel(acc, ev.model);
        if (ev.result) {
          if (ev.success) acc.agentSummaryParts.push(ev.result);
          else addError(acc, `${ev.model || provider}: ${ev.result}`);
        }
        break;
      default:
        break;
    }
  }
}

// ── Main parser function ──────────────────────────────────────────────

/**
 * Parse JSONL session output rows into a structured `SessionSummary`.
 *
 * Handles all four agent provider formats — Claude streaming JSON, Codex
 * `exec --json`, Copilot JSONL, and Pi `--mode json` — by routing every line
 * to the canonical per-provider parser (see ./agent-stream/detect-provider.ts)
 * and folding the parsed display events into the aggregates.
 */
export function parseSessionSummary(
  rows: Array<{ type: string; data: string | null }>,
): SessionSummary {
  const acc: SummaryAccumulator = {
    toolUseCounts: new Map(),
    commandCounts: new Map(),
    filesRead: new Set(),
    filesEdited: new Set(),
    filesWritten: new Set(),
    commandsRun: [],
    keyExcerpts: [],
    errors: [],
    model: "",
    initFound: false,
    agentSummaryParts: [],
    taskCounter: 0,
    tasksMap: new Map(),
    rateLimits: [],
  };

  // One shared parse context for the whole transcript so tool_use ids registered
  // by earlier lines resolve tool names on later tool_result lines.
  const parseContext = createAgentStreamParseContext();

  for (const row of rows) {
    if (row.type !== "stdout" || !row.data) continue;

    for (const line of row.data.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof obj !== "object" || obj === null) continue;

      const provider = detectAgentEventProvider(obj);
      let parsed: ParsedStreamEvent | undefined;
      switch (provider) {
        case "claude":
          parsed = parseClaudeEvent(obj, parseContext);
          break;
        case "codex":
          parsed = parseCodexEvent(obj, parseContext);
          break;
        case "pi":
          parsed = parsePiEvent(obj, parseContext);
          break;
        case "copilot":
          parsed = parseCopilotEvent(obj, trimmed, parseContext);
          break;
      }
      if (!parsed) continue;

      foldParsedEvent(acc, provider, typeof obj.type === "string" ? obj.type : "", parsed);
    }
  }

  // ── Build result ──────────────────────────────────────────────────

  const actions: Array<{ type: string; files?: string[]; commands?: string[] }> = [];
  if (acc.filesRead.size > 0) actions.push({ type: "read", files: [...acc.filesRead] });
  if (acc.filesEdited.size > 0) actions.push({ type: "edit", files: [...acc.filesEdited] });
  if (acc.filesWritten.size > 0) actions.push({ type: "write", files: [...acc.filesWritten] });
  if (acc.commandsRun.length > 0) actions.push({ type: "command", commands: acc.commandsRun });

  const parts: string[] = [];
  if (acc.initFound) parts.push(`Agent session using ${acc.model}`);
  if (acc.filesRead.size > 0) parts.push(`read ${acc.filesRead.size} file${acc.filesRead.size !== 1 ? "s" : ""}`);
  if (acc.filesEdited.size > 0) parts.push(`edited ${acc.filesEdited.size} file${acc.filesEdited.size !== 1 ? "s" : ""}`);
  if (acc.filesWritten.size > 0) parts.push(`wrote ${acc.filesWritten.size} file${acc.filesWritten.size !== 1 ? "s" : ""}`);
  if (acc.commandsRun.length > 0) parts.push(`ran ${acc.commandsRun.length} command${acc.commandsRun.length !== 1 ? "s" : ""}`);
  const overview = parts.length > 0 ? parts.join(", ") : "No activity recorded";

  const agentSummary = acc.agentSummaryParts.length > 0 ? acc.agentSummaryParts.join("\n\n---\n\n") : null;

  const toolUsePatterns: ToolUsePattern[] = [...acc.toolUseCounts.entries()]
    .map(([tool, { count, failedCount }]) => ({ tool, count, failedCount }))
    .sort((a, b) => b.count - a.count);

  const repeatedCommands: RepeatedCommand[] = [...acc.commandCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count);

  return {
    overview,
    agentSummary,
    actions,
    keyExcerpts: acc.keyExcerpts,
    errors: acc.errors,
    filesRead: [...acc.filesRead],
    filesEdited: [...acc.filesEdited],
    filesWritten: [...acc.filesWritten],
    commandsRun: acc.commandsRun,
    model: acc.model,
    tasks: [...acc.tasksMap.values()],
    rateLimits: acc.rateLimits,
    toolUsePatterns,
    repeatedCommands,
  };
}

// ── Friction stats ────────────────────────────────────────────────────

/**
 * Compact, fleet-aggregatable friction metrics derived from a parsed session
 * summary. Persisted alongside the cost/token stats in `sessions.stats` so the
 * insights endpoint can roll them up without re-parsing transcripts.
 *
 * Bounded in size: `tools` is bounded by the number of distinct tool names a
 * session used (~15-20), and `repeatedCommands` is capped + truncated.
 */
export interface SessionFrictionStats {
  /** Total tool invocations across all tools. */
  totalToolCalls: number;
  /** Tool invocations that returned an error result. */
  failedToolCalls: number;
  /** Number of distinct error excerpts captured. */
  errorCount: number;
  /** Per-tool call/failure counts (the denominator for fail-rate analysis). */
  tools: ToolUsePattern[];
  /** Commands the agent ran 2+ times within the session (a wasted-turn signal). */
  repeatedCommands: RepeatedCommand[];
}

export function computeFrictionStats(
  summary: Pick<SessionSummary, "toolUsePatterns" | "repeatedCommands" | "errors">,
  opts?: { maxRepeatedCommands?: number; maxCommandLength?: number },
): SessionFrictionStats {
  const maxCmds = opts?.maxRepeatedCommands ?? 8;
  const maxLen = opts?.maxCommandLength ?? 100;

  let totalToolCalls = 0;
  let failedToolCalls = 0;
  for (const t of summary.toolUsePatterns) {
    totalToolCalls += t.count;
    failedToolCalls += t.failedCount;
  }

  const repeatedCommands = summary.repeatedCommands
    .slice(0, maxCmds)
    .map((rc) => ({
      command: rc.command.length > maxLen ? rc.command.slice(0, maxLen) : rc.command,
      count: rc.count,
    }));

  return {
    totalToolCalls,
    failedToolCalls,
    errorCount: summary.errors.length,
    tools: summary.toolUsePatterns,
    repeatedCommands,
  };
}
