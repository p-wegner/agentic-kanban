// Pure issue-detail derivations extracted from IssueDetailPanel's render-time
// IIFE/JSX so they are unit-testable; the panel imports them and renders identically.

import type { DependencyItem } from "@agentic-kanban/shared";

/** Statuses that count a dependency as resolved (compared case-insensitively). */
export const RESOLVED_STATUS_NAMES = ["done", "cancelled", "ai reviewed"];

/**
 * The OUTGOING, blocking-type dependencies (depends_on / blocked_by) of `issueId`
 * whose target is still unresolved — i.e. the ones that should drive the amber
 * "Blocked by N unresolved dependencies" banner. Incoming edges (this issue blocks
 * others) and resolved targets are excluded.
 */
export function computeBlockingDependencies(dependencies: DependencyItem[], issueId: string): DependencyItem[] {
  return dependencies.filter((dep) => {
    const isIncoming = dep.issueId !== issueId;
    const isBlockingType = dep.type === "depends_on" || dep.type === "blocked_by";
    if (!isBlockingType) return false;
    if (isIncoming) return false; // incoming depends_on means I'm blocking them, not the other way
    const statusLower = (dep.issueStatusName ?? "").toLowerCase();
    return !RESOLVED_STATUS_NAMES.includes(statusLower);
  });
}

/** Offer the "Decompose" affordance for long descriptions (>500 chars) or 'epic'-tagged issues. */
export function canDecomposeIssue(description: string | null | undefined, tags: { name: string }[]): boolean {
  return (description?.length ?? 0) > 500 || tags.some((t) => t.name === "epic");
}
