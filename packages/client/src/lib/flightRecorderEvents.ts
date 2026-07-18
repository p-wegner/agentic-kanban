// Pure core for the Agent Event Flight-Recorder (#99).
//
// The flight recorder is a single, live, filterable stream of high-signal AGENT-RUNTIME
// events merged across every active workspace/repo — tool errors, approval requests /
// agent questions, phase/status transitions, stall/loop detections, and merges /
// merge-failures. It is a unified VIEW over streams the board already produces (the
// cross-repo activity reducer, the agent-activity store + stall detector, the pending
// agent-questions endpoint), NOT a new event bus.
//
// This module is the React-free, DOM-free core: it NORMALIZES the heterogeneous source
// shapes into one {@link FlightRecorderEvent} type, MERGES many source streams into one
// newest-first timeline (deduping by stable id), and FILTERS that timeline by workspace,
// repo, and severity. Because it is pure it is exhaustively unit-testable without a
// running server — see flightRecorderEvents.test.ts.

import type { CrossRepoActivityEntry, CrossRepoActivityKind } from "./crossRepoActivity.js";
import type { AgentStallSignal } from "./detectAgentStall.js";

export type FlightRecorderSeverity = "error" | "warn" | "info";

export type FlightRecorderEventKind =
  | "tool_error"
  | "approval_request"
  | "agent_question"
  | "status_transition"
  | "phase_transition"
  | "stall"
  | "loop"
  | "merge"
  | "merge_failure"
  | "conflict";

/** Where "jump to transcript" should land for an entry (workspace + optional session). */
export interface FlightRecorderTranscriptTarget {
  workspaceId: string;
  issueId: string | null;
  /** Session to open at, when the source knows it; null ⇒ latest/whole workspace. */
  sessionId: string | null;
}

/** One normalized, source-agnostic runtime event on the merged timeline. */
export interface FlightRecorderEvent {
  /** Stable dedupe key. Repeated identical events (same source signal) collapse to one. */
  id: string;
  /** ISO-8601 timestamp; the sole sort key for the timeline. */
  timestamp: string;
  /** Owning workspace (null for events not tied to a workspace). */
  workspaceId: string | null;
  /** Human label for the row, e.g. an issue reference; null when unknown. */
  workspaceLabel: string | null;
  /** Repo label for a multi-repo event, or null for a workspace-wide event. */
  repo: string | null;
  severity: FlightRecorderSeverity;
  kind: FlightRecorderEventKind;
  /** One-line human summary. */
  summary: string;
  issueId: string | null;
  issueNumber: number | null;
  /** Jump-to-transcript target, or null when the event has no transcript. */
  transcript: FlightRecorderTranscriptTarget | null;
}

/** Severity ordering (most→least severe) for tie-breaks and facet display. */
export const SEVERITY_ORDER: readonly FlightRecorderSeverity[] = ["error", "warn", "info"];

function issueRef(issueNumber: number | null, label?: string | null): string {
  if (issueNumber != null && label) return `#${issueNumber} ${label}`;
  if (issueNumber != null) return `#${issueNumber}`;
  return label ?? "";
}

// ── Cross-repo activity (merges / stranded / commits / conflicts) ──────────────

/** kind + severity a cross-repo delta maps to on the flight recorder. */
const CROSS_REPO_MAP: Record<
  CrossRepoActivityKind,
  { kind: FlightRecorderEventKind; severity: FlightRecorderSeverity }
> = {
  repo_merged: { kind: "merge", severity: "info" },
  repo_ahead: { kind: "status_transition", severity: "info" },
  repo_stranded: { kind: "merge_failure", severity: "warn" },
  conflict_appeared: { kind: "conflict", severity: "error" },
  conflict_cleared: { kind: "conflict", severity: "info" },
};

/**
 * Normalize a cross-repo activity entry (#88) into a flight-recorder event. The
 * cross-repo id (`${workspaceId}:${repo}:${kind}`) is namespaced so it can't collide
 * with another source's id.
 */
export function normalizeCrossRepoEntry(entry: CrossRepoActivityEntry): FlightRecorderEvent {
  const { kind, severity } = CROSS_REPO_MAP[entry.kind];
  return {
    id: `crossrepo:${entry.id}`,
    timestamp: entry.timestamp,
    workspaceId: entry.workspaceId,
    workspaceLabel: entry.issueNumber != null ? `#${entry.issueNumber}` : null,
    repo: entry.repo,
    severity,
    kind,
    summary: entry.summary,
    issueId: entry.issueId,
    issueNumber: entry.issueNumber,
    transcript: { workspaceId: entry.workspaceId, issueId: entry.issueId, sessionId: null },
  };
}

// ── Stall / loop detection ─────────────────────────────────────────────────────

export interface StallEventInput {
  workspaceId: string;
  issueId: string | null;
  issueNumber: number | null;
  issueTitle?: string | null;
  sessionId?: string | null;
  repo?: string | null;
  signal: AgentStallSignal;
  /** ISO timestamp the detection was observed (injected — keeps this pure). */
  at: string;
}

/** Compact idle label mirroring AgentStallBadge: "3m" past a minute, else "45s". */
function formatIdle(idleSec: number): string {
  return idleSec >= 60 ? `${Math.floor(idleSec / 60)}m` : `${idleSec}s`;
}

/**
 * Normalize a stall detector verdict into a flight-recorder event, or null for a
 * healthy ("ok") agent. A `stalled` agent maps to a "stall" event; a `looping` agent
 * to a "loop" event — both `warn`, since the fleet operator should look but the agent
 * hasn't hard-failed. The id excludes the timestamp so a persisting stall collapses to
 * a single row (the newest detection wins in {@link mergeFlightRecorderEvents}).
 */
export function normalizeStallSignal(input: StallEventInput): FlightRecorderEvent | null {
  const { signal } = input;
  if (signal.state === "ok") return null;
  const ref = issueRef(input.issueNumber, input.issueTitle);
  const prefix = ref ? `${ref}: ` : "";
  const kind: FlightRecorderEventKind = signal.state === "looping" ? "loop" : "stall";
  const summary =
    signal.state === "looping"
      ? `${prefix}agent looping — repeated ${signal.repeatedTool ?? "tool"} ×${signal.repeatCount ?? 0}`
      : `${prefix}agent stalled — no activity for ${formatIdle(signal.idleSec)}`;
  return {
    id: `stall:${input.workspaceId}:${kind}`,
    timestamp: input.at,
    workspaceId: input.workspaceId,
    workspaceLabel: input.issueNumber != null ? `#${input.issueNumber}` : null,
    repo: input.repo ?? null,
    severity: "warn",
    kind,
    summary,
    issueId: input.issueId,
    issueNumber: input.issueNumber,
    transcript: {
      workspaceId: input.workspaceId,
      issueId: input.issueId,
      sessionId: input.sessionId ?? null,
    },
  };
}

// ── Pending agent questions / approval requests ────────────────────────────────

/** Minimal projection of a pending question set (kept local so this lib stays a leaf). */
export interface AgentQuestionInput {
  toolUseId: string;
  workspaceId: string;
  sessionId?: string | null;
  issueId: string | null;
  issueNumber: number | null;
  issueTitle?: string | null;
  /** First-question summary drives the row; header preferred, else the question text. */
  header?: string | null;
  question?: string | null;
  /** Count of sub-questions in this ask (>1 appends "+N more"). */
  questionCount?: number;
  askedAt: string | null;
  /** True when the ask is a yes/no approval rather than a multi-option question. */
  isApproval?: boolean;
  /** Set when the ask is likely no longer actionable (drops severity to info). */
  staleLabel?: string | null;
}

/**
 * Normalize a pending agent question / approval request into a flight-recorder event.
 * A blocking, still-actionable ask is `warn` (the fleet is waiting on the operator); a
 * stale ask drops to `info`. `fallbackAt` supplies the timestamp when the source lacks
 * an `askedAt` so the event still sorts deterministically.
 */
export function normalizeAgentQuestion(
  input: AgentQuestionInput,
  fallbackAt: string,
): FlightRecorderEvent {
  const ref = issueRef(input.issueNumber, input.issueTitle);
  const detail = input.header || input.question || "awaiting your answer";
  const more = input.questionCount && input.questionCount > 1 ? ` (+${input.questionCount - 1} more)` : "";
  const verb = input.isApproval ? "approval request" : "question";
  const summary = `${ref ? `${ref}: ` : ""}agent ${verb} — ${detail}${more}`;
  return {
    id: `question:${input.toolUseId}`,
    timestamp: input.askedAt ?? fallbackAt,
    workspaceId: input.workspaceId,
    workspaceLabel: input.issueNumber != null ? `#${input.issueNumber}` : null,
    repo: null,
    severity: input.staleLabel ? "info" : "warn",
    kind: input.isApproval ? "approval_request" : "agent_question",
    summary: input.staleLabel ? `${summary} · ${input.staleLabel}` : summary,
    issueId: input.issueId,
    issueNumber: input.issueNumber,
    transcript: {
      workspaceId: input.workspaceId,
      issueId: input.issueId,
      sessionId: input.sessionId ?? null,
    },
  };
}

// ── Workspace status / phase transitions (incl. tool/error states) ─────────────

export interface StatusTransitionInput {
  workspaceId: string;
  issueId: string | null;
  issueNumber: number | null;
  issueTitle?: string | null;
  sessionId?: string | null;
  /** Prior status (null = first observation); no event is emitted when from === to. */
  from: string | null;
  to: string;
  at: string;
}

/** Statuses that read as a hard failure (surface as a red tool_error). */
const ERROR_STATUSES = new Set(["error", "failed"]);
/** Statuses that read as a blocked/needs-attention warning. */
const WARN_STATUSES = new Set(["blocked", "awaiting-plan-approval"]);

/**
 * Normalize a workspace status change into a flight-recorder event, or null when the
 * status didn't actually change. A transition INTO an error status is surfaced as a
 * `tool_error` (error severity); into a blocked/awaiting status as a `status_transition`
 * (warn); everything else as an informational `status_transition`.
 */
export function normalizeStatusTransition(input: StatusTransitionInput): FlightRecorderEvent | null {
  if (input.from === input.to) return null;
  const ref = issueRef(input.issueNumber, input.issueTitle);
  const prefix = ref ? `${ref}: ` : "";
  const isError = ERROR_STATUSES.has(input.to);
  const isWarn = WARN_STATUSES.has(input.to);
  const severity: FlightRecorderSeverity = isError ? "error" : isWarn ? "warn" : "info";
  const kind: FlightRecorderEventKind = isError ? "tool_error" : "status_transition";
  const summary = input.from
    ? `${prefix}${input.from} → ${input.to}`
    : `${prefix}entered ${input.to}`;
  return {
    id: `status:${input.workspaceId}:${input.to}:${input.at}`,
    timestamp: input.at,
    workspaceId: input.workspaceId,
    workspaceLabel: input.issueNumber != null ? `#${input.issueNumber}` : null,
    repo: null,
    severity,
    kind,
    summary,
    issueId: input.issueId,
    issueNumber: input.issueNumber,
    transcript: {
      workspaceId: input.workspaceId,
      issueId: input.issueId,
      sessionId: input.sessionId ?? null,
    },
  };
}

// ── Merge, dedupe, sort ────────────────────────────────────────────────────────

/**
 * Merge many source streams into one newest-first timeline. Events sharing an `id`
 * (the same underlying signal re-observed) collapse to a single entry — the one with
 * the newest timestamp wins, so a persisting stall/status shows its latest state. The
 * result is stably sorted newest-first and capped to a recent window.
 */
export function mergeFlightRecorderEvents(
  groups: ReadonlyArray<ReadonlyArray<FlightRecorderEvent>>,
  cap = 200,
): FlightRecorderEvent[] {
  const byId = new Map<string, FlightRecorderEvent>();
  for (const group of groups) {
    for (const ev of group) {
      const existing = byId.get(ev.id);
      // Keep the newest observation of a repeated id (ties keep the first seen).
      if (!existing || ev.timestamp > existing.timestamp) byId.set(ev.id, ev);
    }
  }
  const merged = [...byId.values()];
  merged.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return merged.slice(0, cap);
}

// ── Filtering + facets ─────────────────────────────────────────────────────────

export interface FlightRecorderFilter {
  /** Restrict to one workspace; null/undefined = all. */
  workspaceId?: string | null;
  /** Restrict to one repo label; null/undefined = all. Excludes null-repo events. */
  repo?: string | null;
  /** Restrict to one severity; null/undefined = all. */
  severity?: FlightRecorderSeverity | null;
}

/**
 * Filter the merged timeline by workspace, repo, and/or severity. Each dimension is
 * independent and an omitted (null/undefined) dimension imposes no constraint. Filtering
 * by a repo excludes workspace-wide (null-repo) events, matching the operator's intent
 * of "show me only what happened in repo X".
 */
export function filterFlightRecorderEvents(
  events: readonly FlightRecorderEvent[],
  filter: FlightRecorderFilter,
): FlightRecorderEvent[] {
  const { workspaceId, repo, severity } = filter;
  return events.filter((e) => {
    if (workspaceId != null && e.workspaceId !== workspaceId) return false;
    if (repo != null && e.repo !== repo) return false;
    if (severity != null && e.severity !== severity) return false;
    return true;
  });
}

export interface FlightRecorderFacets {
  /** Distinct workspaces present, id + best-known label, in first-seen order. */
  workspaces: { id: string; label: string }[];
  /** Distinct repo labels present (workspace-wide null-repo events excluded), sorted. */
  repos: string[];
  /** Severities present, ordered most→least severe. */
  severities: FlightRecorderSeverity[];
}

/** Derive the available filter options (facets) from a timeline for the UI dropdowns. */
export function collectFlightRecorderFacets(
  events: readonly FlightRecorderEvent[],
): FlightRecorderFacets {
  const workspaces = new Map<string, string>();
  const repos = new Set<string>();
  const severities = new Set<FlightRecorderSeverity>();
  for (const e of events) {
    if (e.workspaceId) {
      const label = e.workspaceLabel ?? e.workspaceId;
      // First non-fallback label wins; don't overwrite a real label with the id.
      if (!workspaces.has(e.workspaceId) || workspaces.get(e.workspaceId) === e.workspaceId) {
        workspaces.set(e.workspaceId, label);
      }
    }
    if (e.repo) repos.add(e.repo);
    severities.add(e.severity);
  }
  return {
    workspaces: [...workspaces.entries()].map(([id, label]) => ({ id, label })),
    repos: [...repos].sort(),
    severities: SEVERITY_ORDER.filter((s) => severities.has(s)),
  };
}
