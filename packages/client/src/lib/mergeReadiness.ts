/**
 * Pure merge-readiness verdict logic for the fleet triage board (#98).
 *
 * Given a workspace's per-repo merge state, its review state, and its gate/check
 * state, resolve a single verdict — READY / BLOCKED(reason) / IN-PROGRESS — so the
 * MergeReadinessBoard can answer "what can I merge next and what's blocked" across
 * the fleet without re-deriving the rules in the component. Kept dependency-light
 * (only a type import of the matrix cell shape) so every branch is unit-testable
 * without a fetch or a rendered component.
 */

import type { MatrixCell } from "./multiRepoMatrix.js";

/** Per-repo status shown in a compact cell — mirrors the ticket's vocabulary. */
export type RepoStatusKind = "clean" | "ahead" | "conflicts" | "not-part-of" | "unknown";

export interface RepoReadinessStatus {
  /** Display label for the repo (name, or "leading"). */
  label: string;
  kind: RepoStatusKind;
  /** Commits ahead of base for the `ahead` kind (0 otherwise). */
  ahead: number;
}

/** Whether the workspace's changes have cleared review. */
export type ReviewStatus = "approved" | "pending" | "in-progress";

/** Whether the merge/check gate (here: merge-cleanliness) is satisfied. */
export type GateStatus = "passed" | "failed" | "pending" | "none";

/** Whether the agent is still actively working the ticket. */
export type WorkspaceActivity = "working" | "idle";

export type MergeVerdictKind = "READY" | "BLOCKED" | "IN-PROGRESS";

export interface MergeReadinessInput {
  repos: RepoReadinessStatus[];
  review: ReviewStatus;
  gate: GateStatus;
  activity: WorkspaceActivity;
  /**
   * A hard agent-level blocker (error/blocked workspace status) with a human
   * reason. Takes precedence over review/gate but not over an actual conflict.
   */
  agentBlocker?: string | null;
}

export interface MergeVerdict {
  kind: MergeVerdictKind;
  /** Human-readable reason for a BLOCKED / IN-PROGRESS verdict; null when READY. */
  reason: string | null;
}

/** READY sorts first, then BLOCKED (needs action), then IN-PROGRESS (just wait). */
const VERDICT_RANK: Record<MergeVerdictKind, number> = {
  READY: 0,
  BLOCKED: 1,
  "IN-PROGRESS": 2,
};

/** Sort key so the board can order READY-first (lower = earlier). */
export function verdictSortRank(kind: MergeVerdictKind): number {
  return VERDICT_RANK[kind];
}

function joinLabels(items: RepoReadinessStatus[]): string {
  const labels = items.map((r) => r.label);
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

/**
 * Resolve the single merge-readiness verdict for a workspace. Priority order,
 * highest first:
 *   1. any repo in conflict            → BLOCKED (names the repos)
 *   2. a hard agent blocker (error)    → BLOCKED (agent reason)
 *   3. the gate failed                 → BLOCKED (checks failed)
 *   4. still working / review running / gate running → IN-PROGRESS
 *   5. a repo status could not be read → IN-PROGRESS (status unknown)
 *   6. nothing to merge yet            → IN-PROGRESS (no changes yet)
 *   7. work is ready but unreviewed    → BLOCKED (awaiting review)
 *   8. otherwise                       → READY
 */
export function computeMergeReadiness(input: MergeReadinessInput): MergeVerdict {
  const { repos, review, gate, activity, agentBlocker } = input;

  const conflictRepos = repos.filter((r) => r.kind === "conflicts");
  const aheadRepos = repos.filter((r) => r.kind === "ahead");
  const unknownRepos = repos.filter((r) => r.kind === "unknown");
  const hasWork = aheadRepos.length > 0 || conflictRepos.length > 0;

  if (conflictRepos.length > 0) {
    return { kind: "BLOCKED", reason: `conflicts in ${joinLabels(conflictRepos)}` };
  }
  if (agentBlocker) {
    return { kind: "BLOCKED", reason: agentBlocker };
  }
  if (gate === "failed") {
    return { kind: "BLOCKED", reason: "checks failed" };
  }
  if (activity === "working") {
    return { kind: "IN-PROGRESS", reason: "agent working" };
  }
  if (review === "in-progress") {
    return { kind: "IN-PROGRESS", reason: "review running" };
  }
  if (gate === "pending") {
    return { kind: "IN-PROGRESS", reason: "checks running" };
  }
  if (unknownRepos.length > 0) {
    return { kind: "IN-PROGRESS", reason: "status unknown" };
  }
  if (!hasWork) {
    return { kind: "IN-PROGRESS", reason: "no changes yet" };
  }
  if (review !== "approved") {
    return { kind: "BLOCKED", reason: "awaiting review" };
  }
  return { kind: "READY", reason: null };
}

/**
 * Map a multi-repo matrix cell (from `buildMultiRepoMatrix`) to a per-repo
 * readiness status. `null` = the repo is not part of this workspace. `stranded`
 * work folds into `ahead` — it is unlanded work that still needs to merge; the
 * verdict cares that it is not on base, not why.
 */
export function repoStatusFromCell(label: string, cell: MatrixCell | null): RepoReadinessStatus {
  if (!cell) return { label, kind: "not-part-of", ahead: 0 };
  switch (cell.state) {
    case "merged":
    case "no-change":
      return { label, kind: "clean", ahead: 0 };
    case "ahead":
    case "stranded":
      return { label, kind: "ahead", ahead: cell.ahead };
    case "conflict":
      return { label, kind: "conflicts", ahead: cell.ahead };
    default:
      return { label, kind: "unknown", ahead: 0 };
  }
}

/** Derive review state from a workspace status string. */
export function deriveReviewStatus(status: string): ReviewStatus {
  switch (status) {
    case "ready_for_merge":
      return "approved";
    case "reviewing":
    case "fixing":
      return "in-progress";
    default:
      return "pending";
  }
}

/** Whether the agent is still actively working (vs. paused/idle awaiting triage). */
export function deriveActivity(status: string): WorkspaceActivity {
  return status === "active" || status === "awaiting-plan-approval" ? "working" : "idle";
}

/** A hard agent-level blocker reason for error/blocked statuses, else null. */
export function deriveAgentBlocker(status: string): string | null {
  if (status === "error") return "agent error";
  if (status === "blocked") return "agent blocked";
  return null;
}
