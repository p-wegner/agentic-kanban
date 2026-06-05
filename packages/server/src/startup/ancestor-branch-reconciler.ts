import { and, eq, isNull, ne, notInArray } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { checkBranchTipIsAncestor } from "@agentic-kanban/shared/lib/git-service";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { moveIssueToDone, updateWorkspaceStatus } from "../repositories/workspace.repository.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";

/** Issue status names that are already terminal — skip these workspaces. */
const TERMINAL_STATUS_NAMES = ["Done", "AI Reviewed", "Closed", "Cancelled"];

export interface AncestorBranchReconcilerDeps {
  database?: Database;
  /** Injectable for testing. Defaults to the real checkBranchTipIsAncestor from git-service. */
  checkAncestor?: typeof checkBranchTipIsAncestor;
}

/**
 * Reconcile workspaces whose branch tip is already an ancestor of the base
 * branch (i.e. the work was genuinely merged into base) but whose issue is
 * still stuck in a non-terminal status (e.g. "In Review" or "In Progress").
 *
 * This happens when the merge HTTP response was interrupted after the git
 * operation completed but before the DB was updated — the DB never recorded
 * `mergedAt`, so `reconcileSilentlyMergedWorkspaces` (which checks mergedAt)
 * cannot catch it. This reconciler catches it by asking git directly.
 *
 * Complementary safety net: `reconcileSilentlyMergedWorkspaces` handles the
 * case where mergedAt is set; this handles the case where git says merged but
 * mergedAt is null.
 *
 * Idempotent: once the workspace is closed and the issue is Done, subsequent
 * runs find the issue in a terminal status and skip it.
 */
export async function reconcileAncestorBranchWorkspaces(
  deps: AncestorBranchReconcilerDeps = {},
): Promise<number> {
  const database = deps.database ?? db;
  const ancestorCheck = deps.checkAncestor ?? checkBranchTipIsAncestor;

  // Find non-closed, non-direct workspaces whose issue is NOT in a terminal status
  // and whose mergedAt is null (mergedAt set = already handled by reconcileSilentlyMergedWorkspaces).
  const candidates = await database
    .select({
      wsId: workspaces.id,
      branch: workspaces.branch,
      baseBranch: workspaces.baseBranch,
      workingDir: workspaces.workingDir,
      wsStatus: workspaces.status,
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
        ne(workspaces.status, "closed"),
        eq(workspaces.isDirect, false),
        isNull(workspaces.mergedAt),
        notInArray(projectStatuses.name, TERMINAL_STATUS_NAMES),
      ),
    );

  if (candidates.length === 0) return 0;

  let reconciled = 0;
  const now = new Date().toISOString();

  for (const c of candidates) {
    if (!c.branch || !c.baseBranch || !c.repoPath) continue;

    let result: Awaited<ReturnType<typeof checkBranchTipIsAncestor>>;
    try {
      result = await ancestorCheck(c.repoPath, c.branch, c.baseBranch, c.workingDir ?? undefined);
    } catch (err) {
      console.warn(`[ancestor-reconciler] git check failed for workspace ${c.wsId}:`, err instanceof Error ? err.message : err);
      continue;
    }

    if (!result.isAncestor) continue;

    console.log(
      `[ancestor-reconciler] workspace ${c.wsId} (issue #${c.issueNumber ?? "?"}, branch=${c.branch}) — branch tip is ancestor of ${c.baseBranch} but issue is '${c.statusName}'; reconciling`,
    );

    try {
      const mergedAt = now;
      await updateWorkspaceStatus(c.wsId, "closed", {
        mergedAt,
        closedAt: now,
        readyForMerge: false,
        workingDir: null,
      }, database);
      await moveIssueToDone(c.wsId, c.issueId, now, database);

      try {
        await logBoardHealthEvent({
          projectId: c.projectId,
          cycleId: `ancestor-reconcile-${c.wsId}`,
          eventType: "action",
          category: "merge",
          issueNumber: c.issueNumber ?? undefined,
          summary: `Ancestor-branch reconciliation: workspace ${c.branch} branch tip was already merged into ${c.baseBranch} but issue was '${c.statusName}'. Closed workspace and moved issue to Done.`,
          details: { workspaceId: c.wsId, branchSha: result.branchSha, baseSha: result.baseSha, reconciledAt: now },
        }, database);
      } catch { /* health event logging is non-fatal */ }

      reconciled++;
    } catch (err) {
      console.warn(`[ancestor-reconciler] failed to reconcile workspace ${c.wsId}:`, err instanceof Error ? err.message : err);
    }
  }

  if (reconciled > 0) {
    console.log(`[ancestor-reconciler] reconciled ${reconciled} stranded workspace(s) whose branch was already merged`);
  }
  return reconciled;
}
