import type { SessionManager } from "../services/session.manager.js";
import type { BoardEventSink } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { getMergeJob } from "../services/merge-job.service.js";
import { mergeFixHintFromJob } from "../services/merge-failure-fix-hint.js";
import { bankMergeShrinks } from "../services/merge-bank-shrinks.service.js";
import { getWorkspaceById } from "../repositories/workspace-reads.repository.js";
import { getIssueSummary } from "../repositories/issue.repository.js";
import { ConflictError, NotFoundError, UnprocessableError } from "../errors/index.js";
import { runWorkspaceMergeJob } from "./workspace-merge-actions.js";

/**
 * `POST /api/workspaces/:id/merge/bank-shrinks` (#1250) — the one-click answer to a
 * deterministic shrink-only red.
 *
 * Reads the fix hint off the workspace's LAST merge job (`mergeFixHintFromJob`, the same
 * projection `GET /merge-status` shows), applies its edits to the branch worktree, commits
 * `test(#N): bank the nloc shrinks the merge gate named`, and re-triggers the merge through
 * `runWorkspaceMergeJob` — exactly what the operator did by hand three times on #1243.
 *
 * Refusals, each its own status so a client can tell them apart:
 *  - 409 while a merge job is RUNNING for the workspace (its verdict may change the hint);
 *  - 422 when there is no hint (the last attempt passed, failed on something else, or the
 *    job map lost it to a restart), when the worktree is dirty outside the baseline files, or
 *    when a baseline no longer holds the number the gate saw (`merge-bank-shrinks.service`);
 *  - 404 for an unknown workspace or one without a worktree.
 *
 * Its own router, mounted beside `createWorkspaceActionsRoute` under `/workspaces`, because
 * that factory is on the `function-nloc-ratchet` shrink-only ring and cannot grow.
 */
export function createWorkspaceMergeBankShrinksRoute(
  getSessionManager: () => SessionManager,
  database: Database,
  options?: { boardEvents?: BoardEventSink },
) {
  const router = createRouter();
  const workspaceService = createWorkspaceService({ database, getSessionManager, boardEvents: options?.boardEvents });

  router.post("/:id/merge/bank-shrinks", async (c) => {
    const id = c.req.param("id");
    const job = getMergeJob(id);
    if (job?.state === "running") {
      throw new ConflictError("a merge job is running for this workspace; wait for its verdict before banking");
    }
    const hint = mergeFixHintFromJob(job);
    if (!hint) {
      throw new UnprocessableError(
        "the last merge attempt did not fail on a stale shrink-only baseline, so there is nothing to bank",
      );
    }
    const workspace = await getWorkspaceById(id, database);
    if (!workspace?.workingDir) throw new NotFoundError("workspace not found, or it has no worktree");
    const issue = await getIssueSummary(workspace.issueId, database).catch(() => null);
    const banked = await bankMergeShrinks({
      workingDir: workspace.workingDir,
      issueNumber: issue?.issueNumber ?? null,
      hint,
    });
    const { jobId, run } = runWorkspaceMergeJob(id, workspaceService, { database });
    // The job record is the report, as for `POST /merge?async=1`.
    void run.catch(() => {});
    return c.json({ ...banked, jobId, workspaceId: id, statusUrl: `/api/workspaces/${id}/merge-status` }, 202);
  });

  return router;
}
