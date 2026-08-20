/**
 * Explicit legal-transition tables for workspace and issue status — the
 * observability layer for arch-review finding §1.1
 * (docs/adversarial-arch-review-2026-07-07.md).
 *
 * Background: there is no persisted state machine for workspace/issue status.
 * `setWorkspaceStatus` (workspace-status.ts) enforced exactly ONE rule (the
 * terminal closed+merged invariant); `transitionIssueStatus`
 * (workflow-engine/status-transition.ts) is a guarded setter, not a machine.
 * ~24 files write status from anywhere and ~10 startup reconcilers repair the
 * invariants the non-transactional write paths fail to maintain — so illegal
 * transitions were completely invisible.
 *
 * This module makes the transition rules EXPLICIT (a data table mapping
 * fromStatus → the set of allowed toStatus) and lets the two setters SURFACE
 * illegal transitions. It is intentionally CONSERVATIVE:
 *
 *   - Default policy is WARN-AND-ALLOW. This is a live, single-user board with
 *     many existing callers and reconcilers that may currently rely on
 *     "any → any" writes. Flagging a transition must not break the running
 *     board — it only logs a warning so illegal transitions become observable.
 *   - The ONE truly-never-legal transition (resurrecting a terminal
 *     closed+merged workspace) is classified "forbidden". Under the default
 *     policy the existing terminal guard in `setWorkspaceStatus` still handles
 *     it (no-op / returns false); under STRICT policy it throws.
 *   - Strictness is CONFIGURABLE (`setTransitionStrictness` / the
 *     `KANBAN_STATUS_TRANSITION_STRICT` env var) so the rules can be tightened
 *     to hard-throw once the callers/reconcilers are known to be clean.
 *
 * This module is PURE and client-safe (no node-only imports): the DB reads that
 * feed the issue check live in the setter (workflow-engine/status-transition.ts).
 */

import type { WorkspaceStatus } from "./workspace-status.js";

/** Severity of a transition-legality verdict. */
export type TransitionSeverity = "ok" | "warn" | "forbidden";

export interface TransitionCheck {
  /** True when the transition is in the legal table (or is a self-transition). */
  legal: boolean;
  severity: TransitionSeverity;
  /** Human-readable description of an illegal transition (undefined when ok). */
  message?: string;
}

/**
 * How strictly the two setters enforce the legal-transition tables.
 *  - "warn"   (default): illegal transitions log a warning but still apply
 *             (forbidden ones fall to the existing terminal guard / no-op).
 *  - "strict": any illegal transition throws `IllegalStatusTransitionError`.
 */
export type TransitionStrictness = "warn" | "strict";

let strictness: TransitionStrictness =
  typeof process !== "undefined" && process.env?.KANBAN_STATUS_TRANSITION_STRICT === "1"
    ? "strict"
    : "warn";

/** Set the global transition strictness (test hook / future tightening). */
export function setTransitionStrictness(next: TransitionStrictness): void {
  strictness = next;
}

/** Read the current global transition strictness. */
export function getTransitionStrictness(): TransitionStrictness {
  return strictness;
}

/** Thrown by the setters only under STRICT policy on an illegal transition. */
export class IllegalStatusTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalStatusTransitionError";
  }
}

/**
 * Legal workspace-status transitions (fromStatus → allowed toStatus set).
 * Self-transitions (idempotent re-writes) are always legal and omitted here.
 * Transitions INTO "closed" are always legal (any workspace may be closed), so
 * "closed" is intentionally present in most rows.
 *
 * The mergedAt-aware terminal rule (a closed+merged workspace is FINAL) is NOT
 * expressible in this status-only table — it stays a dedicated check in
 * `checkWorkspaceTransition` / the setter's terminal guard.
 */
export const WORKSPACE_STATUS_TRANSITIONS: Record<WorkspaceStatus, readonly WorkspaceStatus[]> = {
  "awaiting-plan-approval": ["active", "idle", "blocked", "closed", "error"],
  active: ["idle", "blocked", "reviewing", "fixing", "ready_for_merge", "awaiting-plan-approval", "closed", "error"],
  idle: ["active", "blocked", "reviewing", "fixing", "ready_for_merge", "awaiting-plan-approval", "closed", "error"],
  blocked: ["active", "idle", "reviewing", "fixing", "closed", "error"],
  reviewing: ["active", "idle", "fixing", "ready_for_merge", "blocked", "closed", "error"],
  fixing: ["active", "idle", "reviewing", "ready_for_merge", "blocked", "closed", "error"],
  ready_for_merge: ["active", "idle", "reviewing", "fixing", "blocked", "closed", "error"],
  error: ["active", "idle", "blocked", "closed"],
  // An abandoned close (no mergedAt) is revivable; the terminal (merged) case is
  // gated separately by the mergedAt check, not by this table.
  closed: ["active", "idle", "blocked", "reviewing", "fixing", "ready_for_merge", "awaiting-plan-approval", "error"],
};

/**
 * Classify a workspace-status transition.
 *
 * @param from   current status
 * @param to     requested status
 * @param opts   `mergedAt` (the row's mergedAt) + `force` — used only for the
 *               terminal closed+merged resurrection rule.
 */
export function checkWorkspaceTransition(
  from: WorkspaceStatus,
  to: WorkspaceStatus,
  opts: { mergedAt?: string | null; force?: boolean } = {},
): TransitionCheck {
  // The single truly-never-legal transition: reviving a terminal closed+merged
  // workspace (unless force+reason). This mirrors the existing #953/#966 rule.
  if (from === "closed" && opts.mergedAt && to !== "closed" && !opts.force) {
    return {
      legal: false,
      severity: "forbidden",
      message: `revive of terminal closed+merged workspace -> "${to}" (mergedAt=${opts.mergedAt})`,
    };
  }
  if (from === to) return { legal: true, severity: "ok" };
  const allowed = WORKSPACE_STATUS_TRANSITIONS[from];
  if (allowed?.includes(to)) return { legal: true, severity: "ok" };
  return {
    legal: false,
    severity: "warn",
    message: `unexpected workspace transition "${from}" -> "${to}"`,
  };
}

/**
 * Canonical issue-status names (the default project statuses;
 * `DEFAULT_STATUSES` in issue.repository.ts). Projects may define CUSTOM status
 * names — the issue check treats any name outside this set as unknown and
 * ALLOWS the transition silently (custom workflows are legal), so this table is
 * only an observability signal for boards on the canonical lane.
 */
export const CANONICAL_ISSUE_STATUS_NAMES = [
  "Backlog",
  "Todo",
  "In Progress",
  "In Review",
  "AI Reviewed",
  "Done",
  "Cancelled",
] as const;

export type CanonicalIssueStatusName = (typeof CANONICAL_ISSUE_STATUS_NAMES)[number];

const CANONICAL_ISSUE_STATUS_SET = new Set<string>(CANONICAL_ISSUE_STATUS_NAMES);

/**
 * Legal issue-status transitions among the canonical lane (fromName → allowed
 * toName set). Permissive by design: forward flow plus the legal back-edges
 * (reopen a Done issue, kick a review back to In Progress, reactivate a
 * Cancelled issue). Self-transitions are always legal and omitted.
 */
export const ISSUE_STATUS_TRANSITIONS: Record<CanonicalIssueStatusName, readonly CanonicalIssueStatusName[]> = {
  Backlog: ["Todo", "In Progress", "Done", "Cancelled"],
  Todo: ["Backlog", "In Progress", "In Review", "Done", "Cancelled"],
  "In Progress": ["Backlog", "Todo", "In Review", "AI Reviewed", "Done", "Cancelled"],
  "In Review": ["Todo", "In Progress", "AI Reviewed", "Done", "Cancelled"],
  "AI Reviewed": ["In Progress", "In Review", "Done", "Cancelled"],
  // Reopening a terminal issue is legal (the #590 mass-reopen was a bug in what
  // triggered it, not in the transition itself).
  Done: ["Backlog", "Todo", "In Progress", "In Review", "Cancelled"],
  Cancelled: ["Backlog", "Todo", "In Progress"],
};

/**
 * Classify an issue-status transition by status NAME. Returns `ok` when either
 * name is non-canonical (custom project workflow) so custom lanes never warn.
 */
export function checkIssueStatusTransition(fromName: string, toName: string): TransitionCheck {
  if (fromName === toName) return { legal: true, severity: "ok" };
  if (!CANONICAL_ISSUE_STATUS_SET.has(fromName) || !CANONICAL_ISSUE_STATUS_SET.has(toName)) {
    return { legal: true, severity: "ok" };
  }
  const allowed = ISSUE_STATUS_TRANSITIONS[fromName as CanonicalIssueStatusName];
  if (allowed?.includes(toName as CanonicalIssueStatusName)) {
    return { legal: true, severity: "ok" };
  }
  return {
    legal: false,
    severity: "warn",
    message: `unexpected issue transition "${fromName}" -> "${toName}"`,
  };
}
