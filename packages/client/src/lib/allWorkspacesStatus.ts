// Pure status-pill formatting for AllWorkspacesPanel's workspace rows. These rules
// are DELIBERATELY distinct from IssueWorkspacesSection's helpers (this panel adds
// the closed+merged / conflicts-not-fixing cases), so they live in their own lib
// rather than reusing the sibling — see behaviorsToPreserve in the decomposition spec.

import type { IssueWithStatus } from "@agentic-kanban/shared";
import { WORKSPACE_STATUS_TONE, workspaceStatusToneClass } from "./badgeTones.js";

/** The per-issue "main" workspace summary (non-null; rows render it only when present). */
type WorkspaceMain = NonNullable<NonNullable<IssueWithStatus["workspaceSummary"]>["main"]>;

// #517: derived from the status tones. The hand-written map had `closed` as
// `bg-gray-100 text-gray-500 dark:bg-gray-400` — a LIGHT dark-mode background with no
// dark text, i.e. grey-on-light-grey — and three other rows were light-only.
export const WS_STATUS_COLORS: Record<string, string> = Object.fromEntries(
  Object.keys(WORKSPACE_STATUS_TONE).map((status) => [status, workspaceStatusToneClass(status)]),
);

/** Tailwind classes for the workspace-row status pill (branch order matters). */
export function workspaceRowStatusBadgeClass(main: WorkspaceMain): string {
  return main.conflicts?.hasConflicts && main.status !== "fixing"
    ? "bg-red-100 text-red-700"
    : main.status === "closed" && main.lastSessionTriggerType === "fix-conflicts"
      ? "bg-orange-100 text-orange-700"
      : main.status === "closed" && main.mergedAt
        ? "bg-emerald-100 text-emerald-700"
        : WS_STATUS_COLORS[main.status] ?? "bg-gray-100 text-gray-600";
}

/** Human label for the workspace-row status pill (branch order matters). */
export function workspaceRowStatusLabel(main: WorkspaceMain): string {
  return main.status === "reviewing"
    ? "AI Reviewing"
    : main.status === "fixing"
      ? "AI Fixing Conflicts"
      : main.conflicts?.hasConflicts
        ? "Merge Conflicts"
        : main.status === "closed" && main.lastSessionTriggerType === "fix-conflicts"
          ? "merged conflicts"
          : main.status === "closed" && main.mergedAt
            ? "merged"
            : main.status;
}

/** Compact context-token chip label: "12k ctx" at >= 1000, else "500 ctx". */
export function formatContextTokens(contextTokens: number): string {
  return contextTokens >= 1000 ? `${Math.round(contextTokens / 1000)}k ctx` : `${contextTokens} ctx`;
}

/** Search-box placeholder for the current mode. */
export function searchPlaceholder(showingStale: boolean, showingCrossProject: boolean): string {
  return showingStale
    ? "Search by title, branch, or issue #…"
    : showingCrossProject
      ? "Search by title, branch, or project…"
      : "Search by title or branch…";
}
