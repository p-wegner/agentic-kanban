import { getBoardStatus } from "./board-status.js";
import { checkPluginSkillHealth } from "./plugin-skill-health.service.js";
import { getProjectRepoPath } from "../repositories/project.repository.js";
import { computeStableSkew, type StableSkew } from "./stable-skew.service.js";
import { getProjectRepoFields } from "../repositories/project.repository.js";
import { findStrandedInReviewIssueIds } from "./stranded-in-review.service.js";
import type { db } from "../db/index.js";

export type RiskCategory = "merge_blocker" | "stale_session" | "low_backlog" | "health" | "stable_skew" | "stranded_in_review";
export type RiskSeverity = "high" | "medium" | "low";

export interface RiskItem {
  issueNumber: number | null;
  issueTitle: string;
  reason: string;
  category: RiskCategory;
  severity: RiskSeverity;
}

export interface BoardRiskDigest {
  projectId: string;
  generatedAt: string;
  summary: {
    mergeBlockers: number;
    staleSessions: number;
    lowBacklog: boolean;
    backlogCount: number;
    healthIssues: number;
    /** #1206 — issues In Review whose only workspace(s) are closed and unmerged. */
    strandedInReview: number;
  };
  topItems: RiskItem[];
  allItems: RiskItem[];
  /**
   * Two-board skew (#1055): how far the project's default branch has drifted ahead of the
   * `stable-*` tag the operating board is actually pinned to, so a "Done" ticket whose fix
   * isn't live yet doesn't read as trustworthy. `null` when the project isn't run under the
   * two-board promote flow (no `stable-*` tag) or master is not ahead of it.
   */
  stableSkew: StableSkew | null;
}

const STALE_SESSION_MS = 2 * 60 * 60 * 1000; // 2 hours
const LOW_BACKLOG_THRESHOLD = 3;

function hasDiff(stats: { filesChanged: number; insertions: number; deletions: number } | null): boolean {
  return !!stats && (stats.filesChanged > 0 || stats.insertions > 0 || stats.deletions > 0);
}

export async function generateBoardRiskDigest(
  projectId: string,
  database: typeof db,
): Promise<BoardRiskDigest> {
  const boardStatus = await getBoardStatus({ projectId, includeClosed: false }, database);
  const allItems: RiskItem[] = [];

  const backlogStatuses = new Set(["Todo", "Backlog", "To Do"]);
  let backlogCount = 0;

  for (const issue of boardStatus.issues) {
    if (backlogStatuses.has(issue.statusName)) {
      backlogCount++;
    }

    // merge_blocker: has diff but conflicts or not ready for merge while idle
    if (issue.workspace && issue.diffStats && hasDiff(issue.diffStats)) {
      if (issue.conflicts?.hasConflicts) {
        const files = issue.conflicts.conflictingFiles.slice(0, 3).join(", ");
        allItems.push({
          issueNumber: issue.issueNumber,
          issueTitle: issue.title,
          reason: `Merge conflicts in: ${files || "unknown files"}`,
          category: "merge_blocker",
          severity: "high",
        });
      } else if (
        issue.workspace.status === "idle"
        && !issue.workspace.readyForMerge
        && issue.statusName === "In Review"
      ) {
        allItems.push({
          issueNumber: issue.issueNumber,
          issueTitle: issue.title,
          reason: "In Review but workspace is idle and not marked ready for merge",
          category: "merge_blocker",
          severity: "medium",
        });
      }
    }

    // stale_session: error workspace or running session with no recent activity
    if (issue.workspace?.status === "error") {
      allItems.push({
        issueNumber: issue.issueNumber,
        issueTitle: issue.title,
        reason: "Workspace is in error state",
        category: "stale_session",
        severity: "high",
      });
    } else if (issue.session?.status === "running") {
      // Use lastActivity (from session messages) if available, fall back to session startedAt
      const activityTimestamp = issue.lastActivity ?? issue.session.startedAt;
      if (activityTimestamp) {
        const ageMs = Date.now() - new Date(activityTimestamp).getTime();
        if (ageMs > STALE_SESSION_MS) {
          const ageHours = Math.round(ageMs / (60 * 60 * 1000));
          allItems.push({
            issueNumber: issue.issueNumber,
            issueTitle: issue.title,
            reason: `Session running but no activity for ${ageHours}h`,
            category: "stale_session",
            severity: "medium",
          });
        }
      }
    }

    // health: attention flags from board status classification
    if (issue.attention?.bucket === "needs_attention") {
      // avoid duplicating items already captured as merge_blockers
      const alreadyCaptured = allItems.some(
        (item) => item.issueNumber === issue.issueNumber && item.category === "merge_blocker",
      );
      if (!alreadyCaptured) {
        allItems.push({
          issueNumber: issue.issueNumber,
          issueTitle: issue.title,
          reason: issue.attention.label,
          category: "health",
          severity: "medium",
        });
      }
    }
  }

  // stranded_in_review (#1206): issue In Review + no open workspace + branch exists
  // (closed, non-direct, unmerged) — no train can board it and nothing else on this
  // board flags it as "stuck", since it has no running/idle workspace to be idle in.
  // Remedy: reopen_workspace on the latest workspace. Distinct from the generic
  // "closed-in-review" attention reason above (which fires from the FIRST closed
  // workspace `get_board_status` happens to pick as `mainWs`); this predicate checks
  // that EVERY workspace for the issue is closed, so it doesn't double-count an
  // issue that merely has a stale closed workspace alongside a live one.
  const inReviewIssueIds = boardStatus.issues
    .filter((i) => i.statusName === "In Review")
    .map((i) => i.issueId);
  const strandedIds = new Set(await findStrandedInReviewIssueIds(inReviewIssueIds, database));
  for (const issue of boardStatus.issues) {
    if (!strandedIds.has(issue.issueId)) continue;
    allItems.push({
      issueNumber: issue.issueNumber,
      issueTitle: issue.title,
      reason: "In Review with no open workspace — every workspace is closed and unmerged. Use reopen_workspace to recover.",
      category: "stranded_in_review",
      severity: "high",
    });
  }

  // plugin skill health: an enabled plugin's skill that this checkout cannot resolve, or that
  // had gone missing and was just re-materialized (#1053 — #1039's heal only ran when a
  // workspace was created; this makes the SAME check visible on the board independent of one).
  const repoPath = await getProjectRepoPath(projectId, database);
  if (repoPath) {
    const pluginHealth = await checkPluginSkillHealth(projectId, repoPath, database);
    for (const finding of pluginHealth.missing) {
      allItems.push({
        issueNumber: 0,
        issueTitle: "Plugin skills",
        reason: `${finding.pluginName}: "${finding.skillName}" cannot be materialized here — ${finding.reason}`,
        category: "health",
        severity: "high",
      });
    }
    for (const finding of pluginHealth.healed) {
      allItems.push({
        issueNumber: 0,
        issueTitle: "Plugin skills",
        reason: `${finding.pluginName}: "${finding.skillName}" was missing from this checkout and has just been re-materialized`,
        category: "health",
        severity: "medium",
      });
    }
  }

  // stable_skew: the default branch has fix-shaped commits the operating (stable) board
  // hasn't promoted yet (#1055) — a "Done" ticket whose fix isn't live.
  const repoFields = await getProjectRepoFields(projectId, database);
  const stableSkew = repoFields?.repoPath
    ? await computeStableSkew(repoFields.repoPath, repoFields.defaultBranch || "master")
    : null;
  if (stableSkew && stableSkew.fixShapedCount > 0) {
    allItems.push({
      issueNumber: 0,
      issueTitle: "Two-board skew",
      reason: `${stableSkew.aheadCount} commit${stableSkew.aheadCount === 1 ? "" : "s"} ahead of ${stableSkew.stableTag} `
        + `(${stableSkew.fixShapedCount} fix/feat) not yet live on the operating board`,
      category: "stable_skew",
      severity: "medium",
    });
  }

  // low_backlog: single synthetic item
  const lowBacklog = backlogCount < LOW_BACKLOG_THRESHOLD;
  if (lowBacklog) {
    allItems.push({
      issueNumber: 0,
      issueTitle: "Backlog",
      reason: `Only ${backlogCount} ticket${backlogCount === 1 ? "" : "s"} in backlog — consider refilling`,
      category: "low_backlog",
      severity: backlogCount === 0 ? "high" : "low",
    });
  }

  const severityOrder: Record<RiskSeverity, number> = { high: 0, medium: 1, low: 2 };
  allItems.sort((a, b) => {
    const sv = severityOrder[a.severity] - severityOrder[b.severity];
    if (sv !== 0) return sv;
    return (a.issueNumber ?? 0) - (b.issueNumber ?? 0);
  });

  const topItems = allItems.slice(0, 3);

  const mergeBlockers = allItems.filter((i) => i.category === "merge_blocker").length;
  const staleSessions = allItems.filter((i) => i.category === "stale_session").length;
  const healthIssues = allItems.filter((i) => i.category === "health").length;
  const strandedInReview = allItems.filter((i) => i.category === "stranded_in_review").length;

  return {
    projectId,
    generatedAt: boardStatus.generatedAt,
    summary: {
      mergeBlockers,
      staleSessions,
      lowBacklog,
      backlogCount,
      healthIssues,
      strandedInReview,
    },
    topItems,
    allItems,
    stableSkew,
  };
}
