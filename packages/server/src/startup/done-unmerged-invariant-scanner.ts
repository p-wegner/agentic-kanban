import { and, eq, inArray, isNull } from "drizzle-orm";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { checkBranchTipIsAncestor, countUniqueCommits } from "@agentic-kanban/shared/lib/git-service";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import { PREF_DONE_UNMERGED_SCANNER_ENABLED } from "../constants/preference-keys.js";

/** Issue status names that count as "terminal Done" — these are the ones we scan. */
const DONE_STATUS_NAMES = ["Done", "AI Reviewed"];

export interface DoneUnmergedScannerDeps {
  database?: Database;
  /** Injectable for testing. Defaults to the real checkBranchTipIsAncestor from git-service. */
  checkAncestor?: typeof checkBranchTipIsAncestor;
  /** Injectable for testing. Defaults to the real countUniqueCommits from git-service. */
  countCommits?: typeof countUniqueCommits;
  /**
   * Override enabled state for testing. When undefined (production path), the scanner
   * reads the live preference from the DB at call time.
   */
  enabled?: boolean;
}

export interface DoneUnmergedFinding {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  projectId: string;
  branch: string;
  baseBranch: string;
  branchSha: string;
  baseSha: string;
  uniqueCommitCount: number;
  statusName: string;
}

export interface DoneUnmergedScanResult {
  findings: DoneUnmergedFinding[];
  reopened: number;
}

/**
 * Startup invariant scanner that detects issues in a terminal Done status
 * whose latest workspace branch is NOT reachable from base HEAD and is ahead
 * by >=1 unique commit (Done-but-unmerged silent-merge-loss detector).
 *
 * This is the INVERSE of the ancestor-branch reconciler (#576): instead of
 * detecting merged-but-stranded issues, this detects Done-but-unmerged issues
 * where the work was never actually landed on base.
 *
 * Grounded in the #581 incident: the buggy ancestor-branch reconciler marked
 * issues Done while master never advanced; real committed work sat on-branch
 * unreachable from base. This scanner flags (and optionally re-opens) those.
 *
 * READ-ONLY by default: logs structured warnings and board health events.
 * Passes `reopenToInReview: true` to also move the issue back to In Review
 * so the normal merge chain can re-land the work.
 *
 * Idempotent: once an issue is re-opened and later genuinely merged and Done,
 * subsequent scans will no longer flag it (branch will be reachable from base).
 */
export async function scanDoneUnmergedWorkspaces(
  deps: DoneUnmergedScannerDeps & { reopenToInReview?: boolean } = {},
): Promise<DoneUnmergedScanResult> {
  const database = deps.database ?? db;
  const ancestorCheck = deps.checkAncestor ?? checkBranchTipIsAncestor;
  const commitCounter = deps.countCommits ?? countUniqueCommits;
  const reopenToInReview = deps.reopenToInReview ?? true;

  const isEnabled = deps.enabled !== undefined
    ? deps.enabled
    : await (async () => {
        try {
          const row = await database.select({ value: preferences.value }).from(preferences)
            .where(eq(preferences.key, PREF_DONE_UNMERGED_SCANNER_ENABLED)).limit(1);
          return row.length === 0 || row[0].value !== "false";
        } catch {
          return true;
        }
      })();

  if (!isEnabled) {
    console.log("[done-unmerged-scanner] disabled via preference — skipping scan");
    return { findings: [], reopened: 0 };
  }

  // Find non-direct workspaces whose issue IS in a terminal Done status
  // and whose branch was NOT recorded as merged (mergedAt IS NULL).
  // mergedAt set = the workspace was genuinely merged; those are not violations.
  // This mirrors the ancestor-branch-reconciler's mergedAt guard.
  const candidates = await database
    .select({
      wsId: workspaces.id,
      branch: workspaces.branch,
      baseBranch: workspaces.baseBranch,
      workingDir: workspaces.workingDir,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      projectId: issues.projectId,
      repoPath: projects.repoPath,
      statusName: projectStatuses.name,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(
      and(
        eq(workspaces.isDirect, false),
        isNull(workspaces.mergedAt),
        inArray(projectStatuses.name, DONE_STATUS_NAMES),
      ),
    );

  if (candidates.length === 0) return { findings: [], reopened: 0 };

  const findings: DoneUnmergedFinding[] = [];
  let reopened = 0;
  const now = new Date().toISOString();
  // Track which issues have already been re-opened this scan to avoid double-counting
  // when an issue has multiple non-merged workspaces (e.g. one abandoned, one done-but-unmerged).
  const reopenedIssueIds = new Set<string>();

  for (const c of candidates) {
    if (!c.branch || !c.baseBranch || !c.repoPath) continue;

    let result: Awaited<ReturnType<typeof checkBranchTipIsAncestor>>;
    try {
      result = await ancestorCheck(c.repoPath, c.branch, c.baseBranch, c.workingDir ?? undefined);
    } catch (err) {
      console.warn(`[done-unmerged-scanner] git ancestry check failed for workspace ${c.wsId}:`, err instanceof Error ? err.message : err);
      continue;
    }

    // If the branch IS already an ancestor of base, the work landed — skip.
    if (result.isAncestor) continue;

    // Branch is not reachable from base — check how many unique commits it has.
    if (!result.branchSha) continue;

    let uniqueCommits: number;
    try {
      uniqueCommits = await commitCounter(c.repoPath, result.baseSha, result.branchSha);
    } catch {
      uniqueCommits = 0;
    }

    // Only flag if there is at least 1 unique commit (0-commit branches have no real work).
    if (uniqueCommits === 0) continue;

    const finding: DoneUnmergedFinding = {
      workspaceId: c.wsId,
      issueId: c.issueId,
      issueNumber: c.issueNumber,
      projectId: c.projectId,
      branch: c.branch,
      baseBranch: c.baseBranch,
      branchSha: result.branchSha,
      baseSha: result.baseSha,
      uniqueCommitCount: uniqueCommits,
      statusName: c.statusName,
    };
    findings.push(finding);

    console.warn(
      `[done-unmerged-scanner] INVARIANT VIOLATION: issue #${c.issueNumber ?? "?"} is '${c.statusName}' but branch '${c.branch}' has ${uniqueCommits} commit(s) NOT reachable from ${c.baseBranch} (branchSha=${result.branchSha}, baseSha=${result.baseSha}) — silent merge loss detected`,
    );

    try {
      await logBoardHealthEvent({
        projectId: c.projectId,
        cycleId: `done-unmerged-scan-${c.wsId}`,
        eventType: "observation",
        category: "merge",
        issueNumber: c.issueNumber ?? undefined,
        summary: `Done-but-unmerged invariant violation: issue #${c.issueNumber ?? "?"} is '${c.statusName}' but branch '${c.branch}' has ${uniqueCommits} unmerged commit(s) not reachable from ${c.baseBranch}.`,
        details: { workspaceId: c.wsId, branchSha: result.branchSha, baseSha: result.baseSha, uniqueCommitCount: uniqueCommits, detectedAt: now },
      }, database);
    } catch { /* health event logging is non-fatal */ }

    if (reopenToInReview && !reopenedIssueIds.has(c.issueId)) {
      try {
        // Resolve the In Review status for this project.
        const statuses = await database
          .select({ id: projectStatuses.id, name: projectStatuses.name })
          .from(projectStatuses)
          .where(eq(projectStatuses.projectId, c.projectId));

        const inReviewStatus = statuses.find(s => s.name === "In Review");
        if (!inReviewStatus) {
          console.warn(`[done-unmerged-scanner] no 'In Review' status found for project ${c.projectId} — cannot reopen issue #${c.issueNumber ?? "?"}`);
          continue;
        }

        await database
          .update(issues)
          .set({ statusId: inReviewStatus.id, updatedAt: now, statusChangedAt: now })
          .where(eq(issues.id, c.issueId));

        // Also reopen the workspace so it is no longer closed.
        await database
          .update(workspaces)
          .set({ status: "idle", mergedAt: null, closedAt: null, readyForMerge: true, updatedAt: now })
          .where(eq(workspaces.id, c.wsId));

        reopened++;
        reopenedIssueIds.add(c.issueId);

        console.log(
          `[done-unmerged-scanner] re-opened issue #${c.issueNumber ?? "?"} to 'In Review' and workspace ${c.wsId} to idle (branch has ${uniqueCommits} unmerged commit(s))`,
        );

        try {
          await logBoardHealthEvent({
            projectId: c.projectId,
            cycleId: `done-unmerged-reopen-${c.wsId}`,
            eventType: "action",
            category: "merge",
            issueNumber: c.issueNumber ?? undefined,
            summary: `Done-but-unmerged recovery: re-opened issue #${c.issueNumber ?? "?"} to 'In Review' — branch '${c.branch}' has ${uniqueCommits} unmerged commit(s) not yet on ${c.baseBranch}.`,
            details: { workspaceId: c.wsId, branchSha: result.branchSha, baseSha: result.baseSha, uniqueCommitCount: uniqueCommits, reopenedAt: now },
          }, database);
        } catch { /* health event logging is non-fatal */ }
      } catch (err) {
        console.warn(`[done-unmerged-scanner] failed to reopen workspace ${c.wsId}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  if (findings.length > 0) {
    console.warn(`[done-unmerged-scanner] found ${findings.length} Done-but-unmerged issue(s); reopened ${reopened}`);
  }

  return { findings, reopened };
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

// Module-level singleton handles — cleared on each startDoneUnmergedScanner call so
// tsx hot-reload never accumulates duplicate intervals (cycle-39 reaper incident).
let _activeTimer: NodeJS.Timeout | null = null;
let _activeInterval: NodeJS.Timeout | null = null;

/**
 * Schedule the done-unmerged invariant scanner to run shortly after boot and then periodically.
 *
 * Hot-reload-safe: clears any previously registered timer/interval before installing new ones
 * so tsx hot-reload never accumulates duplicate ticks. Both handles are unref'd so they don't
 * prevent the process from exiting cleanly.
 */
export function startDoneUnmergedScanner(
  deps: Omit<DoneUnmergedScannerDeps, "enabled"> & { reopenToInReview?: boolean } = {},
  intervalMs = DEFAULT_INTERVAL_MS,
): { timer: NodeJS.Timeout; interval: NodeJS.Timeout } {
  // Clear any prior handles from a previous hot-reload cycle.
  if (_activeTimer !== null) { clearTimeout(_activeTimer); _activeTimer = null; }
  if (_activeInterval !== null) { clearInterval(_activeInterval); _activeInterval = null; }

  const tick = () => {
    scanDoneUnmergedWorkspaces(deps).catch((err) =>
      console.warn("[done-unmerged-scanner] periodic tick error:", err instanceof Error ? err.message : err),
    );
  };
  const timer = setTimeout(tick, 40_000);
  const interval = setInterval(tick, intervalMs);
  (timer as NodeJS.Timeout).unref?.();
  (interval as NodeJS.Timeout).unref?.();
  _activeTimer = timer;
  _activeInterval = interval;
  return { timer, interval };
}

/**
 * Run the done-unmerged invariant scan immediately (fire-and-forget).
 * Called after a merge completes to catch silent-merge-loss without waiting for the next interval.
 */
export function runDoneUnmergedScannerNow(
  deps: Omit<DoneUnmergedScannerDeps, "enabled"> & { reopenToInReview?: boolean } = {},
): void {
  scanDoneUnmergedWorkspaces(deps).catch((err) =>
    console.warn("[done-unmerged-scanner] post-merge scan error:", err instanceof Error ? err.message : err),
  );
}
