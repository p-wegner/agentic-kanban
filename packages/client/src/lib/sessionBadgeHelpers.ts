import type { IssueWithStatus } from "@agentic-kanban/shared";

export function getLastSessionBadge(triggerType: string | null | undefined): { label: string; className: string } | null {
  if (!triggerType) return null;
  const map: Record<string, { label: string; className: string }> = {
    review: { label: "AI Review", className: "bg-accent-50 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300" },
    merge: { label: "AI Merge", className: "bg-emerald-100 text-emerald-700" },
    "fix-conflicts": { label: "Fix Conflicts", className: "bg-orange-100 text-orange-700" },
    "fix-and-merge": { label: "Fix & Merge", className: "bg-orange-100 text-orange-700" },
    learning: { label: "Learning", className: "bg-teal-100 text-teal-700" },
    "auto-start": { label: "Auto-start", className: "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400" },
  };
  if (map[triggerType]) return map[triggerType];
  if (triggerType.startsWith("skill:")) {
    const name = triggerType.slice(6).replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    return { label: `✨ ${name}`, className: "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300" };
  }
  return null;
}

export type ActiveAgentState = {
  label: string;
  dot: string;
  ring: string;
  badge: string;
};

/**
 * At-a-glance indicator for a live agent session on the issue's main workspace.
 * Returns null when no agent is actively running. `active` = builder working,
 * `reviewing` = AI review session, `fixing` = AI conflict-resolution session.
 */
export function getActiveAgentState(issue: IssueWithStatus): ActiveAgentState | null {
  const status = issue.workspaceSummary?.main?.status;
  switch (status) {
    case "active":
      return {
        label: "Agent working",
        dot: "bg-green-500",
        ring: "ring-2 ring-green-400/70 dark:ring-green-500/60",
        badge: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
      };
    case "reviewing":
      return {
        label: "AI reviewing",
        dot: "bg-accent-500",
        ring: "ring-2 ring-accent-400/70 dark:ring-accent-500/60",
        badge: "bg-accent-50 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300",
      };
    case "fixing":
      return {
        label: "AI fixing",
        dot: "bg-orange-500",
        ring: "ring-2 ring-orange-400/70 dark:ring-orange-500/60",
        badge: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
      };
    default:
      return null;
  }
}
