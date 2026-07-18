import type { AgentOutputMessage } from "@agentic-kanban/shared";
import {
  createAgentOutputParser,
  type AgentOutputFormat,
  type DisplayEvent,
} from "./agent-output-parser.js";

/**
 * A single, typed, ordered entry in a session transcript. This is a *display*
 * projection of the raw agent stream: the canonical per-provider stream parsers
 * (`agent-output-parser.ts`) do the heavy lifting of turning JSONL/stream-json
 * lines into `DisplayEvent`s; this lib flattens those into the small vocabulary
 * the transcript viewer renders per-type (#87).
 */
export type TranscriptEventKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "result"
  | "raw";

export interface TranscriptEvent {
  /** Stable, monotonic id for React keys and "jump to" targeting. */
  id: string;
  kind: TranscriptEventKind;
  /** Primary text: assistant/user/thinking body, tool output, or raw line. */
  text: string;
  /** Tool name for tool_call / tool_result / tool_error. */
  toolName?: string;
  /** Pretty-printed tool input JSON for tool_call. */
  toolInput?: string;
  /** Model id where the stream carries one (assistant / result). */
  model?: string;
  /** result-only: whether the turn finished successfully. */
  success?: boolean;
  /** result-only: wall-clock duration in ms. */
  durationMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A plain-text `user` turn (the launch prompt or a follow-up chat message) is
 * NOT surfaced as a `DisplayEvent` by the canonical parsers — they only emit
 * `tool_result` for `user` messages that carry tool_result blocks. Extract the
 * text turn here so the transcript can show what the human/board actually asked.
 * Returns null for anything that isn't a plain-text user message.
 */
export function extractUserText(line: string): string | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(obj) || obj.type !== "user") return null;
  const message = isRecord(obj.message) ? obj.message : obj;
  const content = message.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      // tool_result blocks are rendered from the parser's tool_result events;
      // only collect genuine text so we don't duplicate tool output as "user".
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    const joined = parts.join("\n").trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}

function summarizeToolInput(inputParsed: Record<string, unknown>): string {
  // A one-line human summary for the collapsed tool_call header. Prefer the
  // fields agents use most (command/path/pattern/file) before falling back.
  const primary =
    inputParsed.command ??
    inputParsed.file_path ??
    inputParsed.path ??
    inputParsed.pattern ??
    inputParsed.url ??
    inputParsed.description;
  if (typeof primary === "string" && primary.trim().length > 0) return primary.trim();
  const keys = Object.keys(inputParsed);
  return keys.length > 0 ? keys.join(", ") : "";
}

function mapDisplayEvent(event: DisplayEvent): Omit<TranscriptEvent, "id"> | null {
  switch (event.kind) {
    case "assistant":
      return { kind: "assistant", text: event.text, model: event.model };
    case "thinking":
      return { kind: "thinking", text: event.text };
    case "tool_use":
      return {
        kind: "tool_call",
        toolName: event.name,
        toolInput: event.input,
        text: summarizeToolInput(event.inputParsed),
      };
    case "tool_result":
      return {
        kind: event.isError ? "tool_error" : "tool_result",
        toolName: event.toolName,
        text: event.output,
      };
    case "result":
      return {
        kind: "result",
        text: event.result,
        success: event.success,
        durationMs: event.durationMs,
        model: event.model,
      };
    case "notification":
      return { kind: "raw", text: event.priority ? `[${event.priority}] ${event.text}` : event.text };
    case "raw":
      return { kind: "raw", text: event.text };
    // init / image / rate_limit / task_started are session metadata, not turns —
    // the transcript header (from /summary) already conveys them.
    default:
      return null;
  }
}

/**
 * Pure transformation of raw session output messages into an ordered list of
 * typed transcript events. Deterministic and side-effect free so it can back
 * both the initial render and live-append (re-run on the growing message tail).
 */
export function parseSessionTranscript(
  messages: AgentOutputMessage[],
  format: AgentOutputFormat = "claude-stream-json",
): TranscriptEvent[] {
  const parser = createAgentOutputParser(format);
  const events: TranscriptEvent[] = [];
  let counter = 0;
  const emit = (event: Omit<TranscriptEvent, "id">) => {
    events.push({ id: String(counter++), ...event });
  };

  // Reconstruct true lines across message boundaries (a single stdout chunk may
  // straddle a line, or carry several). Splitting the concatenated stdout by
  // "\n" mirrors how the canonical parser itself frames lines.
  const raw = messages
    .filter((m) => m.type === "stdout")
    .map((m) => m.data ?? "")
    .join("");
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    const line = lines[i];
    const chunk = isLast ? line : `${line}\n`;
    const display = isLast ? [...parser.feed(chunk), ...parser.flush()] : parser.feed(chunk);

    if (display.length > 0) {
      for (const de of display) {
        const mapped = mapDisplayEvent(de);
        if (mapped) emit(mapped);
      }
      continue;
    }

    // No display event for this line: it may be a plain-text user turn the
    // canonical parser deliberately ignores. Surface it if so.
    const userText = extractUserText(line.trim());
    if (userText) emit({ kind: "user", text: userText });
  }

  return events;
}
