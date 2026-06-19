// Pure display/formatting helpers for the Butler UI.
//
// Extracted from ButlerView so they are independently unit-testable and so the
// Butler sub-components (ToolCallCard, ChatBubble, ButlerManageModal, …) can be
// split into their own files without each re-deriving these.

import { CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS } from "@agentic-kanban/shared";

/** Format a context-window size: 1000000 -> "1M", 200000 -> "200k". */
export function formatWindow(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(n / 1000)}k`;
}

/** Relative timestamp label. `now` is injectable for deterministic tests. */
export function formatRelativeTs(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

/** One-line hint describing a tool call's most salient argument. */
export function toolHint(name: string, input?: Record<string, unknown>): string {
  if (!input) return "";
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
  const base = (p: string) => p.replace(/\\/g, "/").split("/").pop() || p;
  if (name === "Read" || name === "Write" || name === "Edit") return base(str(input.file_path));
  if (name === "Bash") return str(input.command);
  if (name === "Glob" || name === "Grep") return str(input.pattern);
  if (name === "WebSearch") return str(input.query);
  if (name === "WebFetch") return str(input.url);
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length <= 80) return v;
  }
  return "";
}

export function backendLabel(backend?: string): string {
  if (backend === "codex") return "Codex";
  if (backend === "mock") return "Mock";
  return "Claude";
}

export function modelOptionsForBackend(backend?: "claude" | "codex" | "mock") {
  return backend === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;
}

export function modelLabel(value: string, backend?: "claude" | "codex" | "mock"): string {
  return modelOptionsForBackend(backend).find((m) => m.value === value)?.label ?? value;
}
