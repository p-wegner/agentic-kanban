/**
 * The fix-and-merge resolver exit path (#700 extraction).
 *
 * ONE responsibility, and it is a two-part one that must stay together: when a fix-and-merge
 * resolver session exits, retry the merge it was spawned to unblock — and then VERIFY the branch
 * actually landed, keeping the workspace retryable when it did not (#764).
 *
 * The second half is not a helper; it is the reason the first half is safe. `autoMerge` swallows
 * its own conflict errors, so its return tells us nothing: the concurrent-merge LOSER, whose
 * conflict against the moved base is real, exits looking exactly like a success. Left unchecked
 * the ticket ends up conflicted with NO open workspace to retry from — manual git recovery. So
 * the landing check is the retry's postcondition, and splitting the two into different modules
 * would let a future edit to one forget the other. Both live here, and nothing else in the exit
 * workflow calls either.
 *
 * No `db` singleton and no raw drizzle: the connection is injected and both reads go through
 * `getWorkspaceById` / `getProjectRepoPath`.
 */
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { clearMergeGateEvidence } from "../../repositories/merge-gate.repository.js";
import { getProjectRepoPath } from "../../repositories/project.repository.js";
import { getWorkspaceById } from "../../repositories/workspace-reads.repository.js";
import { setWorkspaceStatus } from "../../repositories/workspace-status.repository.js";
import { emitButlerSystemEvent } from "../../services/butler-event-feed.js";
import { RUN_GATE } from "../../services/pre-merge-gate.service.js";
import type { Database } from "../../db/index.js";
import type { createBoardEvents } from "../../services/board-events.js";
import type { GitService } from "../../services/workspace-internals.js";
import type { AutoMergeFn, ExitContext, WorkspaceRow } from "./exit-context.js";

export interface FixAndMergeExitDeps {
  database: Database;
  gitService: GitService;
  boardEvents: ReturnType<typeof createBoardEvents>;
  autoMerge: AutoMergeFn;
  /** The engine's live set of fix-and-merge session ids; this exit retires its own entry. */
  fixAndMergeSessionIds: Set<string>;
}

export function createFixAndMergeExitHandler({ database: db, gitService, boardEvents, autoMerge, fixAndMergeSessionIds }: FixAndMergeExitDeps) {
  /**
   * #764 stranded-resolver guard. After a fix-and-merge resolver session exits, verify the
   * branch actually landed on its base. If it did NOT (the concurrent-merge loser whose
   * conflict against the moved base is real — autoMerge's plumbing merge threw and was
   * swallowed), make sure the workspace stays OPEN and idle so it is retryable, and clear the
   * stale readyForMerge flag so nothing re-treats a conflicted branch as mergeable. Never close
   * it — that is exactly the strand (ticket conflicted, no workspace) this guard prevents.
   *
   * Best-effort and idempotent: if the branch DID land, autoMerge has already closed the
   * workspace and this is a no-op (we only touch OPEN workspaces). If the ancestry check can't
   * run, we conservatively leave the open workspace idle (still retryable) rather than risk
   * stranding it.
   */
  async function keepResolverWorkspaceRetryableIfUnlanded(
    workspace: WorkspaceRow,
    projectId: string,
    defaultBranch: string | null,
    sessionId: string,
  ): Promise<void> {
    try {
      // Re-read the live workspace: autoMerge may have closed it on a successful landing.
      const fresh = await getWorkspaceById(workspace.id, db);
      // Already closed/merged (resolver succeeded) or worktree gone — nothing to keep open.
      if (!fresh || fresh.status === "closed" || fresh.mergedAt || !fresh.workingDir || fresh.isDirect) return;

      const baseBranch = fresh.baseBranch || defaultBranch;
      const repoPath = await getProjectRepoPath(projectId, db);

      let landed = false;
      if (baseBranch && repoPath) {
        try {
          const ancestry = await gitService.checkBranchTipIsAncestor(repoPath, fresh.branch, baseBranch, fresh.workingDir ?? undefined);
          landed = ancestry.isAncestor;
        } catch (err) {
          // Couldn't determine — assume NOT landed and keep it retryable (safe default).
          console.warn(`[workflow] #764 landing check failed for workspace ${workspace.id} (treating as not landed):`, errorMessage(err));
        }
      }

      if (landed) return; // Branch is on base; resolver did its job (cleanup runs elsewhere).

      // Not landed: keep the workspace OPEN + idle and retryable. Clear readyForMerge so a
      // conflicted branch is not silently re-queued as "ready". Surface a clear signal.
      const now = new Date().toISOString();
      await setWorkspaceStatus(db, workspace.id, "idle", { now, set: { readyForMerge: false } });
      // #815: the gate evidence moved to `workspace_merge_gate`. Nulling three of the five
      // columns was how this path said "the proof is void"; DELETING the row says the same
      // thing and cannot leave a half-cleared quartet behind.
      await clearMergeGateEvidence(workspace.id, db);
      boardEvents.broadcast(projectId, "workspace_idle");
      boardEvents.broadcast(projectId, "workflow_error");
      emitButlerSystemEvent({
        projectId,
        kind: "merge_failed",
        workspaceId: workspace.id,
        text: `Fix-and-merge resolver for workspace ${workspace.id} (branch ${fresh.branch}) exited but the branch did not land on ${baseBranch ?? "base"} (likely a real concurrent-merge conflict). Workspace left open and idle for retry — not stranded.`,
      });
      console.warn(`[workflow] #764 fix-and-merge resolver for workspace ${workspace.id} (session ${sessionId}) did NOT land branch ${fresh.branch} on ${baseBranch ?? "base"} — kept open + idle for retry`);
    } catch (err) {
      console.warn(`[workflow] #764 stranded-resolver guard failed (non-fatal) for workspace ${workspace.id}:`, errorMessage(err));
    }
  }

  async function handleFixAndMergeExit(ctx: ExitContext): Promise<void> {
    const { workspace, projectId, issueId, sessionId, exitCode, now, findStatus, defaultBranch, autoMergeDisabledProjectIds } = ctx;
    const workspaceId = workspace.id;
    fixAndMergeSessionIds.delete(sessionId);
    if (exitCode === 0) {
      if (autoMergeDisabledProjectIds.has(projectId)) {
        console.log(`[workflow] fix-and-merge session ${sessionId} completed but auto_merge_disabled for project ${projectId} — skipping retry merge`);
        boardEvents.broadcast(projectId, "workspace_idle");
      } else {
        console.log(`[workflow] fix-and-merge session ${sessionId} completed  retrying merge`);
        // autoMerge swallows its own conflict errors, so its return tells us nothing.
        // The landing guard below is what verifies the branch actually merged.
        // #638: this used to pass `gateSkipExplicit("the fix agent already rebuilt/verified the
        // branch in-worktree this session")` — a claim the fix agent's own prompt does not
        // support. That prompt (`merge-helpers.service.ts`) is entirely about working-tree
        // cleanliness; it never instructs the agent to run verify, build or tests. So the
        // "explicit documented skip" documented something that was not happening, and every
        // fix-and-merge landed ungated.
        //
        // It also cannot be right in principle: a fix session exists because the merge did not
        // apply cleanly, so it rebases/resolves — which changes the merge RESULT. Whatever was
        // verified before is not what is about to land. Run the gate. Where the branch is
        // genuinely unchanged, the gate's own SHA-pinned evidence path makes the re-run cheap.
        await autoMerge(workspace, projectId, issueId, findStatus("Done")?.id ?? null, now, RUN_GATE);
      }
    } else {
      console.log(`[workflow] fix-and-merge session ${sessionId} exited with code ${exitCode}  not retrying merge`);
      boardEvents.broadcast(projectId, "workflow_error");
      emitButlerSystemEvent({ projectId, kind: "merge_failed", workspaceId, text: `Fix-and-merge session for workspace ${workspaceId} exited with code ${exitCode}.` });
    }
    // #764: stranded-resolver guard. A fix-and-merge resolver can exit (any code) WITHOUT
    // the branch landing — the concurrent-merge LOSER whose conflict against the moved base
    // is real, so autoMerge's plumbing merge throws and is swallowed. Left unchecked the
    // ticket ends up conflicted with NO open workspace to retry from (manual git recovery).
    // Verify the branch actually landed; if it did NOT, KEEP the workspace OPEN and idle
    // (retryable) and clear the stale readyForMerge flag so nothing treats a conflicted
    // branch as mergeable. Never close/strand it. (Acceptance for the concurrent-merge-loser
    // path; complements #761/#762.)
    await keepResolverWorkspaceRetryableIfUnlanded(workspace, projectId, defaultBranch, sessionId);
  }

  return { handleFixAndMergeExit };
}
