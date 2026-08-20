/**
 * Path A of the interrupted-merge recovery pair (#380).
 *
 * Extracted from `startup-tasks.ts` so it can be shared onto the ancestor-branch
 * reconciler's periodic tick. Importing it from `startup-tasks` directly would close a
 * dependency cycle (`startup-tasks` already imports `reconcileAncestorBranchWorkspaces`),
 * which `pnpm lint:arch` rejects — and a dynamic `import()` does not help, dependency-cruiser
 * counts it. One reconciler per module is also the pattern every sibling here already follows.
 *
 * `startup-tasks` re-exports this so existing importers (and its own boot-time call) are
 * unaffected.
 */
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { issues, projects, workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import { finalizeMergeCleanup, reconcileMergedIssue } from "../services/merge-cleanup.service.js";
import * as gitService from "../services/git.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Reconcile workspaces whose branch was merged (mergedAt IS NOT NULL) but whose
 * status was reset to something other than "closed" — e.g. when cleanupStaleSessions()
 * marked a dead session's workspace as "idle" after the server died mid-merge-response.
 *
 * Must run AFTER cleanupStaleSessions() so it can override any incorrect status reset.
 */
export async function reconcileSilentlyMergedWorkspaces(database: Database = db): Promise<void> {
  try {
  const stale = await database
      .select({
        id: workspaces.id,
        issueId: workspaces.issueId,
        mergedAt: workspaces.mergedAt,
        closedAt: workspaces.closedAt,
        branch: workspaces.branch,
        isDirect: workspaces.isDirect,
        repoPath: projects.repoPath,
        issueNumber: issues.issueNumber,
        projectId: issues.projectId,
      })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .innerJoin(projects, eq(issues.projectId, projects.id))
      .where(
        // mergedAt is set (git merge already landed) but workspace is not closed
        and(isNotNull(workspaces.mergedAt), ne(workspaces.status, "closed")),
      );

    if (stale.length === 0) return;

    console.log(`[startup] Reconciling ${stale.length} silently-merged workspace(s) left open by a dropped HTTP response`);
    const now = new Date().toISOString();

    for (const ws of stale) {
      try {
        if (!ws.isDirect && ws.repoPath && ws.branch) {
          try {
            await gitService.deleteBranch(ws.repoPath, ws.branch);
          } catch (err) {
            console.warn(
              `[startup] reconcileSilentlyMergedWorkspaces: failed to delete branch ${ws.branch} for workspace ${ws.id}:`,
              errorMessage(err),
            );
          }
        }
        // Converge the issue to Done first via the shared idempotent helper, so a
        // dropped merge response still lands the issue even if the later workspace
        // close throws (mirrors the #668 no-rollback guarantee).
        await reconcileMergedIssue({
          database,
          issueId: ws.issueId,
          now,
          projectId: ws.projectId,
        });
        await finalizeMergeCleanup({
          database,
          workspaceId: ws.id,
          issueId: ws.issueId,
          now,
          closedAt: ws.closedAt ?? now,
          mergedAt: ws.mergedAt!,
          workingDir: null,
          projectId: ws.projectId,
        });

        console.log(
          `[startup] auto-Done audit: issue=${ws.issueNumber ?? "?"} ws=${ws.id} mergedAt=${ws.mergedAt} reconciledAt=${now}`,
        );
        try {
          await logBoardHealthEvent({
            projectId: ws.projectId,
            cycleId: `startup-reconcile-${ws.id}`,
            eventType: "action",
            category: "merge",
            issueNumber: ws.issueNumber ?? undefined,
            summary: `Startup reconciliation: workspace ${ws.branch} was already merged at ${ws.mergedAt} but left open by a dropped HTTP response. Closed workspace and moved issue to Done.`,
            details: { workspaceId: ws.id, mergedAt: ws.mergedAt, reconciledAt: now },
          }, database);
        } catch { /* health event logging is non-fatal */ }
      } catch (err) {
        console.warn(`[startup] reconcileSilentlyMergedWorkspaces: failed for workspace ${ws.id}:`, errorMessage(err));
      }
    }
  } catch (err) {
    console.warn("[startup] reconcileSilentlyMergedWorkspaces failed (non-fatal):", errorMessage(err));
  }
}
