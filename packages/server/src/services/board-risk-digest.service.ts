import { getBoardStatus } from "./board-status.js";
import type { db } from "../db/index.js";

export type RiskCategory = "merge_blocker" | "stale_session" | "low_backlog" | "health";
export type RiskSeverity = "high" | "medium" | "low";

export interface RiskItem {
  issueNumber: number;
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
  };
  topItems: RiskItem[];
  allItems: RiskItem[];
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
    return a.issueNumber - b.issueNumber;
  });

  const topItems = allItems.slice(0, 3);

  const mergeBlockers = allItems.filter((i) => i.category === "merge_blocker").length;
  const staleSessions = allItems.filter((i) => i.category === "stale_session").length;
  const healthIssues = allItems.filter((i) => i.category === "health").length;

  return {
    projectId,
    generatedAt: boardStatus.generatedAt,
    summary: {
      mergeBlockers,
      staleSessions,
      lowBacklog,
      backlogCount,
      healthIssues,
    },
    topItems,
    allItems,
  };
}
