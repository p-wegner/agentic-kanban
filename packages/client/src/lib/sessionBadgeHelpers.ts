import type { IssueWithStatus } from "@agentic-kanban/shared";
import { triggerBadgeLabel } from "@agentic-kanban/shared";
import { TRIGGER_TYPE_CLASSES, SKILL_TRIGGER_CLASSNAME } from "./workspace-helpers.js";

/**
 * The badge for a card's LAST session. Deliberately narrower than `getTriggerTypeLabel`:
 * the everyday `agent`/`chat`/`bisect` runs are suppressed here, because a badge on every
 * card carries no information. Labels and skill humanization come from the shared traits
 * table (#495); this file decides only the subset and the colour.
 */
const LAST_SESSION_BADGE_TRIGGERS = new Set(["review", "merge", "fix-conflicts", "fix-and-merge", "learning", "auto-start"]);

export function getLastSessionBadge(triggerType: string | null | undefined): { label: string; className: string } | null {
  if (!triggerType) return null;
  const label = triggerBadgeLabel(triggerType);
  if (!label) return null;
  if (triggerType.startsWith("skill:")) return { label, className: SKILL_TRIGGER_CLASSNAME };
  if (!LAST_SESSION_BADGE_TRIGGERS.has(triggerType)) return null;
  return { label, className: TRIGGER_TYPE_CLASSES[triggerType] ?? "" };
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
