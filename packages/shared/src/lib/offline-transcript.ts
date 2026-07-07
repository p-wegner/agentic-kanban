// Shared OFFLINE transcript reader (arch-review §2.4, Ticket 13).
//
// Persisted agent transcripts (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
// and friends) used to be hand-parsed in TWO places with hardcoded Claude shapes
// — `server/services/butler-transcripts.service.ts` and
// `mcp-server/tools/session-history.ts` — the MCP one silently misreporting
// codex/copilot/pi sessions. This module is the ONE offline reader: it routes
// each stored JSONL line to the SAME canonical per-provider stream parsers the
// live stream uses (agent-stream/{claude,codex,copilot,pi}.ts) and folds the
// resulting display events into a normalized structure. Provider content
// interpretation therefore lives in exactly one place — never re-parse raw JSONL
// field-by-field here.
//
// Node-only (imports node:fs/promises for the file convenience). Import via the
// deep path `@agentic-kanban/shared/lib/offline-transcript`; it must NOT be
// re-exported through the client barrel (src/lib/index.ts) or it white-screens
// the UI (#791 / barrel-client-safety.test.ts).

import { readFile } from "node:fs/promises";
import type { AgentStreamProvider, ParseContext, ParsedStreamEvent } from "./agent-stream/types.js";
import { createAgentStreamParseContext } from "./agent-stream/shared.js";
import { parseClaudeEvent } from "./agent-stream/claude.js";
import { parseCodexEvent } from "./agent-stream/codex.js";
import { parseCopilotEvent } from "./agent-stream/copilot.js";
import { parsePiEvent } from "./agent-stream/pi.js";
import { detectAgentEventProviderOrUnknown } from "./agent-stream/detect-provider.js";

export interface OfflineTranscriptMessage {
  role: "user" | "assistant";
  text: string;
  /** Epoch ms; falls back to Date.now() when the line carried no timestamp. */
  ts: number;
}

export interface OfflineTranscript {
  /** Provider the transcript was read as. `"mixed"` when auto-detection saw more
   *  than one recognized provider; `null` when nothing was recognized. */
  provider: AgentStreamProvider | "mixed" | "unknown" | null;
  sessionId: string | null;
  /** Claude CLI `ai-title` entry, if present. */
  aiTitle: string | null;
  model: string | null;
  /** ISO timestamps of the first/last folded lines that carried one. */
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** User turns (lines with role=user carrying plain text). */
  userTurnCount: number;
  /** Number of assistant text segments (matches the MCP tool's `turns`). */
  assistantTextCount: number;
  sessionStarted: boolean;
  assistantResponded: boolean;
  /** Last assistant text, whitespace-collapsed, capped at 300 chars. */
  lastAssistantText: string | null;
  /** Last `<toolName>  <first-80-chars-of-input>` seen. */
  lastToolCall: string | null;
  stopReason: string | null;
  linesParsed: number;
  /** True when any line carried a Claude SDK/CLI `entrypoint` (`sdk-cli`/`cli`). */
  hasSdkEntrypoint: boolean;
  messages: OfflineTranscriptMessage[];
}

export interface ReadTranscriptOptions {
  /** Force every line through this provider's parser. When omitted the provider
   *  is detected per line (legacy fallback) via detectAgentEventProviderOrUnknown. */
  provider?: AgentStreamProvider;
  /** Parse only the last N non-empty lines (the MCP tool's `tailLines`). */
  tailLines?: number;
  /** Fold only lines whose Claude `entrypoint` is `sdk-cli`/`cli` (butler SDK
   *  sessions). Non-matching lines are skipped except `ai-title`. */
  requireSdkEntrypoint?: boolean;
}

function isSdkEntrypoint(value: unknown): boolean {
  return value === "sdk-cli" || value === "cli";
}

function parseByProvider(
  provider: AgentStreamProvider,
  obj: Record<string, unknown>,
  raw: string,
  ctx: ParseContext,
): ParsedStreamEvent | undefined {
  switch (provider) {
    case "claude":
      return parseClaudeEvent(obj, ctx);
    case "codex":
      return parseCodexEvent(obj, ctx);
    case "pi":
      return parsePiEvent(obj, ctx);
    case "copilot":
      return parseCopilotEvent(obj, raw, ctx);
  }
}

/** The human's prompt text on a `user` line — a plain string or the first text
 *  block. The per-provider parsers deliberately don't surface this (they focus
 *  on agent output), so it is read at the transcript envelope level. */
function extractUserText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        return (block as Record<string, unknown>).text as string;
      }
    }
  }
  return "";
}

interface Acc {
  provider: OfflineTranscript["provider"];
  sessionId: string | null;
  aiTitle: string | null;
  model: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  userTurnCount: number;
  assistantTextCount: number;
  sessionStarted: boolean;
  assistantResponded: boolean;
  lastAssistantText: string | null;
  lastToolCall: string | null;
  stopReason: string | null;
  linesParsed: number;
  hasSdkEntrypoint: boolean;
  messages: OfflineTranscriptMessage[];
}

function recordProvider(acc: Acc, seen: AgentStreamProvider | "unknown"): void {
  if (seen === "unknown") {
    if (acc.provider === null) acc.provider = "unknown";
    return;
  }
  if (acc.provider === null || acc.provider === "unknown") acc.provider = seen;
  else if (acc.provider !== seen && acc.provider !== "mixed") acc.provider = "mixed";
}

function foldDisplayEvents(acc: Acc, parsed: ParsedStreamEvent, lastTs: number): void {
  if (parsed.stats?.model) acc.model = parsed.stats.model;
  for (const ev of parsed.displayEvents ?? []) {
    switch (ev.kind) {
      case "init":
        acc.sessionStarted = true;
        if (!acc.sessionId && ev.sessionId) acc.sessionId = ev.sessionId;
        if (ev.model) acc.model = ev.model;
        break;
      case "assistant":
        acc.assistantResponded = true;
        acc.assistantTextCount++;
        if (ev.model) acc.model = ev.model;
        if (ev.text) acc.lastAssistantText = ev.text.replace(/\s+/g, " ").slice(0, 300);
        break;
      case "tool_use":
        acc.lastToolCall = `${ev.name}  ${ev.input ? ev.input.slice(0, 80) : ""}`.trimEnd();
        break;
      case "result":
        if (ev.model) acc.model = ev.model;
        break;
      default:
        break;
    }
  }
  // Pi surfaces the complete assistant message on message_end via assistantText
  // (its per-token deltas would flood display events); count it as one segment.
  void lastTs;
}

/**
 * Parse already-read JSONL lines into a normalized {@link OfflineTranscript}.
 * Pure (no fs). Routes each line to the canonical per-provider stream parser.
 */
export function parseOfflineTranscript(
  lines: string[],
  opts: ReadTranscriptOptions = {},
): OfflineTranscript {
  const acc: Acc = {
    provider: null,
    sessionId: null,
    aiTitle: null,
    model: null,
    firstTimestamp: null,
    lastTimestamp: null,
    userTurnCount: 0,
    assistantTextCount: 0,
    sessionStarted: false,
    assistantResponded: false,
    lastAssistantText: null,
    lastToolCall: null,
    stopReason: null,
    linesParsed: 0,
    hasSdkEntrypoint: false,
    messages: [],
  };

  const nonEmpty = lines.filter((l) => l.trim());
  const toParse =
    opts.tailLines != null && opts.tailLines >= 0
      ? nonEmpty.slice(Math.max(0, nonEmpty.length - opts.tailLines))
      : nonEmpty;

  const ctx = createAgentStreamParseContext();

  for (const line of toParse) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    acc.linesParsed++;

    const type = typeof obj.type === "string" ? obj.type : "";

    // Claude CLI ai-title entry (envelope-level, provider-agnostic).
    if (type === "ai-title" && typeof obj.aiTitle === "string" && obj.aiTitle) {
      acc.aiTitle = obj.aiTitle;
    }

    const sdk = isSdkEntrypoint(obj.entrypoint);
    if (sdk) acc.hasSdkEntrypoint = true;
    if (opts.requireSdkEntrypoint && !sdk && type !== "ai-title") continue;

    // Top-level transcript sessionId (disk transcripts use `sessionId`; the
    // stream `system/init` uses `session_id`, captured from displayEvents below).
    if (!acc.sessionId && typeof obj.sessionId === "string" && obj.sessionId) {
      acc.sessionId = obj.sessionId;
    }

    const tsIso = typeof obj.timestamp === "string" ? obj.timestamp : null;
    if (tsIso) {
      if (!acc.firstTimestamp) acc.firstTimestamp = tsIso;
      acc.lastTimestamp = tsIso;
    }
    const tsMs = tsIso ? new Date(tsIso).getTime() : Date.now();

    // User prompt text — envelope level (parsers don't surface it).
    if (type === "user") {
      acc.sessionStarted = true;
      const message = obj.message;
      const role = typeof message === "object" && message !== null
        ? (message as Record<string, unknown>).role
        : undefined;
      if (role === undefined || role === "user") {
        const text = extractUserText(message);
        if (text.trim()) {
          acc.userTurnCount++;
          acc.messages.push({ role: "user", text, ts: tsMs });
        }
      }
    }

    // Claude CLI transcript assistant lines carry message.stop_reason.
    if (type === "assistant") {
      const message = obj.message;
      const stop = typeof message === "object" && message !== null
        ? (message as Record<string, unknown>).stop_reason
        : undefined;
      if (typeof stop === "string" && stop) acc.stopReason = stop;
    }

    // Provider content interpretation — the single-source per-provider parser.
    const detected = opts.provider ?? detectAgentEventProviderOrUnknown(obj);
    recordProvider(acc, detected);
    const parseProvider: AgentStreamProvider = detected === "unknown" ? "copilot" : detected;
    const parsed = parseByProvider(parseProvider, obj, line, ctx);
    if (!parsed) continue;

    foldDisplayEvents(acc, parsed, tsMs);

    // One assistant message per line, using the full joined assistantText.
    if (parsed.assistantText && parsed.assistantText.trim()) {
      acc.messages.push({ role: "assistant", text: parsed.assistantText, ts: tsMs });
    }
  }

  return acc;
}

/**
 * Read and parse a persisted `.jsonl` transcript file. Returns an empty (but
 * defined) transcript when the file is absent/unreadable.
 */
export async function readOfflineTranscript(
  filePath: string,
  opts: ReadTranscriptOptions = {},
): Promise<OfflineTranscript> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return parseOfflineTranscript([], opts);
  }
  return parseOfflineTranscript(content.split("\n"), opts);
}
