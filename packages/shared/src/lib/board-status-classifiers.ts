import type { BoardStatusIssue } from "../types/api.js";

/**
 * Pure classification logic for board-status issues: which issues need attention and which
 * are pending an auto-merge. No I/O — operates on the already-assembled BoardStatusIssue.
 *
 * Lives in the shared leaf (NOT duplicated per transport) because the server board endpoint,
 * the MCP get_board_status tool, and any future consumer must classify identically. The MCP
 * copy previously forked and drifted — it emitted only the "idle-awaiting" bucket and missed
 * "closed-in-review"/"stale-in-review", so an agent over MCP saw a strictly poorer board than
 * a human (the reason this was centralized). mcp-no-server-internals forbids MCP importing the
 * server module, so shared is the only sanctioned home.
 *
 * Pure (type-only import) → safe to consume from the client bundle too, though it is exported
 * via a deep subpath rather than the lib barrel to keep the barrel lean.
 */

function isZeroDiff(stats: BoardStatusIssue["diffStats"]): boolean {
  return !!stats && stats.filesChanged === 0 && stats.insertions === 0 && stats.deletions === 0;
}

function hasDiff(stats: BoardStatusIssue["diffStats"]): boolean {
  return !!stats && (stats.filesChanged > 0 || stats.insertions > 0 || stats.deletions > 0);
}

export interface BoardStatusClassificationOptions {
  autoMergeEnabled: boolean;
  autoMergeInReview: boolean;
}

export function classifyBoardStatusIssueAttention(issue: BoardStatusIssue): BoardStatusIssue["attention"] {
  if (issue.mergeState?.bucket === "pending_merge") return null;

  if (
    issue.statusName === "In Review"
    && issue.workspace
    && !issue.workspace.readyForMerge
  ) {
    if (issue.workspace.status === "closed") {
      return {
        bucket: "needs_attention",
        reason: "closed-in-review",
        label: "In Review issue points at a closed or already-merged workspace",
      };
    }
    if (!issue.diffStats) {
      return {
        bucket: "needs_attention",
        reason: "stale-in-review",
        label: "In Review workspace has no available diff stats and may be stale",
      };
    }
    if (isZeroDiff(issue.diffStats)) {
      return {
        bucket: "needs_attention",
        reason: "idle-awaiting",
        label: "In Review workspace has no file changes and is not ready for merge",
      };
    }
  }
  return null;
}

export function classifyBoardStatusIssueMergeState(
  issue: BoardStatusIssue,
  options: BoardStatusClassificationOptions,
): BoardStatusIssue["mergeState"] {
  if (
    options.autoMergeEnabled
    && options.autoMergeInReview
    && issue.statusName === "In Review"
    && issue.workspace
    && issue.workspace.status === "idle"
    && !issue.workspace.readyForMerge
    && hasDiff(issue.diffStats)
  ) {
    return {
      bucket: "pending_merge",
      reason: "auto-merge-in-review",
      label: "Auto-merge pending for idle In Review workspace",
    };
  }

  return null;
}
