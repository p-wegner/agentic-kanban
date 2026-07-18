// Pure summarizer for the per-workspace "multirepo health" pill (#83).
//
// A glanceable aggregate combining the two multi-repo health signals a
// non-direct workspace with siblings carries:
//   • repo-merge-status (GET /api/workspaces/:id/repo-merge-status) — how many
//     repos the workspace spans, how many are stranded (have work not on base),
//     and whether everything has landed (`allMerged`);
//   • serviceState — the per-workspace Docker stack (up/down/error + service count).
//
// Kept pure and dependency-light so the severity/label logic is unit-testable
// without a fetch or a rendered component; the component (MultirepoHealthPill)
// owns the lazy fetch and only calls this to derive its label + colour.

import type { RepoMergeStatusResponse, ServiceStackState } from "@agentic-kanban/shared";

/** attention = red (something is wrong), healthy = green, neutral = in-between/unknown. */
export type MultirepoHealthSeverity = "attention" | "healthy" | "neutral";

export interface MultirepoStackSummary {
  status: "up" | "down" | "error";
  /** Number of named services/ports in the stack. */
  serviceCount: number;
}

export interface MultirepoHealthSummary {
  severity: MultirepoHealthSeverity;
  /** e.g. "3 repos · 1 stranded · stack up(3)". */
  text: string;
  repoCount: number;
  strandedCount: number;
  allMerged: boolean;
  hasConflicts: boolean;
  stack: MultirepoStackSummary | null;
}

export interface MultirepoHealthInput {
  /** Lazily-fetched per-repo merge status; the multi-repo signal of record. */
  repoMergeStatus?: RepoMergeStatusResponse | null;
  /** Per-workspace service stack, when already loaded (e.g. the workspace detail). */
  serviceState?: ServiceStackState | null;
  /** Whether the workspace has a merge conflict (reused from board-loaded data). */
  hasConflicts?: boolean;
}

function summarizeStack(serviceState: ServiceStackState | null | undefined): MultirepoStackSummary | null {
  if (!serviceState) return null;
  // A capacity-deferred stack reports status "error" but nothing actually failed —
  // treat it as "down" so it doesn't cry wolf in the aggregate (mirrors #56).
  const status = serviceState.deferred && serviceState.status === "error" ? "down" : serviceState.status;
  return { status, serviceCount: Object.keys(serviceState.ports ?? {}).length };
}

/**
 * Derive the multirepo health summary, or `null` when the workspace is not
 * multi-repo (fewer than 2 repos in the merge status, or no status loaded yet).
 * Callers render nothing on `null`.
 */
export function summarizeMultirepoHealth(input: MultirepoHealthInput): MultirepoHealthSummary | null {
  const { repoMergeStatus, serviceState, hasConflicts = false } = input;
  // Multi-repo == the merge status spans more than the leading repo. Single-repo
  // (or not-yet-fetched) workspaces get no pill — matches RepoMergeStatusStrip.
  if (!repoMergeStatus || repoMergeStatus.repos.length <= 1) return null;

  const repoCount = repoMergeStatus.repos.length;
  const strandedCount = repoMergeStatus.repos.filter((r) => r.stranded).length;
  const allMerged = repoMergeStatus.allMerged;
  const stack = summarizeStack(serviceState);

  const severity: MultirepoHealthSeverity =
    strandedCount > 0 || hasConflicts || stack?.status === "error"
      ? "attention"
      : allMerged && (!stack || stack.status === "up")
        ? "healthy"
        : "neutral";

  const parts: string[] = [`${repoCount} repos`];
  if (strandedCount > 0) {
    parts.push(`${strandedCount} stranded`);
  } else {
    parts.push(allMerged ? "all merged" : "not all merged");
  }
  if (hasConflicts) parts.push("conflict");
  if (stack) {
    parts.push(stack.serviceCount > 0 ? `stack ${stack.status}(${stack.serviceCount})` : `stack ${stack.status}`);
  }

  return {
    severity,
    text: parts.join(" · "),
    repoCount,
    strandedCount,
    allMerged,
    hasConflicts,
    stack,
  };
}
