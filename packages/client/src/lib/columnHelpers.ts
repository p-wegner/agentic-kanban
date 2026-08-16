import type { IssueWithStatus } from "@agentic-kanban/shared";
import { ISSUE_PRIORITIES, PRIORITY_TRAITS, normalizeIssuePriority } from "./priorityTraits.js";

export const ESTIMATE_POINTS: Record<string, number> = { XS: 1, S: 2, M: 3, L: 5, XL: 8 };

/**
 * Lane keys = the four priorities plus `ungrouped`, which is a LANE, not a priority —
 * it holds issues with no priority set. Derived from the traits table (#516) so a lane
 * can no longer exist without styling, or be styled without existing.
 */
export const PRIORITY_LANE_ORDER = [...ISSUE_PRIORITIES, "ungrouped"];
export const PRIORITY_LANE_STYLES: Record<string, { label: string; headerBg: string; headerBorder: string; headerText: string; dot: string }> = {
  ...Object.fromEntries(ISSUE_PRIORITIES.map((p) => [p, { label: PRIORITY_TRAITS[p].label, ...PRIORITY_TRAITS[p].lane }])),
  ungrouped: { label: "Ungrouped", headerBg: "bg-gray-50 dark:bg-gray-800/40", headerBorder: "border-gray-200 dark:border-gray-700", headerText: "text-gray-500 dark:text-gray-400", dot: "bg-gray-400" },
};

export function groupByPriority(issues: IssueWithStatus[]): { key: string; issues: IssueWithStatus[] }[] {
  const groups: Record<string, IssueWithStatus[]> = {};
  for (const key of PRIORITY_LANE_ORDER) groups[key] = [];
  for (const issue of issues) {
    // A legacy `urgent` value used to fail the membership test and land in "ungrouped",
    // rendering unstyled at the bottom rather than as the critical issue it is (#516).
    const p = issue.priority ? normalizeIssuePriority(issue.priority) : "ungrouped";
    groups[p].push(issue);
  }
  return PRIORITY_LANE_ORDER.map((key) => ({ key, issues: groups[key] })).filter((g) => g.issues.length > 0);
}

export function groupByTag(issues: IssueWithStatus[]): { key: string; label: string; color: string | null; issues: IssueWithStatus[] }[] {
  const tagGroups: Map<string, { label: string; color: string | null; issues: IssueWithStatus[] }> = new Map();
  const ungrouped: IssueWithStatus[] = [];
  for (const issue of issues) {
    const tags = issue.tags ?? [];
    if (tags.length === 0) {
      ungrouped.push(issue);
    } else {
      for (const tag of tags) {
        if (!tagGroups.has(tag.id)) {
          tagGroups.set(tag.id, { label: tag.name, color: tag.color, issues: [] });
        }
        tagGroups.get(tag.id)!.issues.push(issue);
      }
    }
  }
  const result: { key: string; label: string; color: string | null; issues: IssueWithStatus[] }[] = [];
  for (const [key, g] of tagGroups) result.push({ key, ...g });
  result.sort((a, b) => a.label.localeCompare(b.label));
  if (ungrouped.length > 0) result.push({ key: "ungrouped", label: "Ungrouped", color: null, issues: ungrouped });
  return result;
}

export function computeColumnEstimate(issues: IssueWithStatus[]): { total: number; unestimated: number } {
  let total = 0;
  let unestimated = 0;
  for (const issue of issues) {
    if (issue.estimate && ESTIMATE_POINTS[issue.estimate] != null) {
      total += ESTIMATE_POINTS[issue.estimate];
    } else {
      unestimated++;
    }
  }
  return { total, unestimated };
}

export type SortMode = "default" | "type";

export const ISSUE_TYPE_ORDER: Record<string, number> = {
  bug: 0,
  feature: 1,
  task: 2,
  chore: 3,
};

export function sortIssues(issues: IssueWithStatus[], mode: SortMode): IssueWithStatus[] {
  if (mode === "default") return issues;
  return [...issues].sort(
    (a, b) =>
      (ISSUE_TYPE_ORDER[a.issueType ?? "task"] ?? 2) - (ISSUE_TYPE_ORDER[b.issueType ?? "task"] ?? 2)
  );
}
