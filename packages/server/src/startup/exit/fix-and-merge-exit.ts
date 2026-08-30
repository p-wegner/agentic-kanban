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
import { finalizeMergeCleanup } from "../../services/merge-cleanup.service.js";
import { cleanupSiblingWorktrees, stampReconciledLeadingMerge } from "../../services/workspace-repos.service.js";
import { releaseWorkspaceResources } from "../../services/workspace-resource-release.js";
import { removeWorktreeUnlessShared } from "@agentic-kanban/shared/lib/worktree-claim";
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
   * #950: record a merge the FIX AGENT performed itself, so the row matches git.
   *
   * Mirrors the two writes `reconcileAlreadyMerged` makes for the same situation, in the same
   * order and for the same reasons:
   *   1. `finalizeMergeCleanup` — closes the workspace, stamps `mergedAt`, and converges the
   *      issue (plus any ticket-group members) to Done.
   *   2. `stampReconciledLeadingMerge` — records the landed leading tip in `mergedHeadSha`,
   *      which `finalizeMergeCleanup` cannot write (it is a leading-repo mirror column, the
   *      same reason `merge-workflow.ts` routes it through `stampWorkspaceMergedAt`). It must
   *      run BEFORE any later branch cleanup, or the ref it reads is already gone.
   *
   * Deliberately NOT `reconcileAlreadyMerged` itself: that entry point additionally needs a
   * `recordMergeAttempt` writer and a session killer, neither of which this exit handler has,
   * and it re-derives an ancestry verdict the caller has just established.
   *
   * But the TEARDOWN is not optional here, and "left to the paths that already own it" was
   * wrong: closing the row with `workingDir: null` is precisely what makes every other path
   * blind to this worktree. `runWorkspacePostMergeCleanup` (`teardownMergedWorktree`),
   * `deleteWorkspace` and `pruneStaleWorktrees` all gate their teardown on a NON-NULL
   * `workingDir` read from the DB, so after this function ran, nothing would ever release the
   * per-workspace Docker service stack, remove the worktree, or drop the sibling
   * worktrees/branches. Before #950 the row stayed OPEN with a live `workingDir`, so a later
   * retry/merge/delete could still reach them — nulling it without tearing down converts a
   * bookkeeping bug into a resource leak. (The startup orphan reconciler recovers the LEADING
   * directory from git truth, but only at the next server boot, and it never deletes a branch
   * or a sibling.) So this mirrors `reconcileAlreadyMerged`'s teardown too, from the
   * PRE-NULL snapshot, in the same order: resources first, then the worktree, then siblings.
   *
   * Best-effort throughout: a stamp that fails must not turn a landed merge into a thrown exit
   * handler, so every step warns and continues. The worst case is the state we already had.
   */
  async function finalizeLandedResolverWorkspace(
    fresh: NonNullable<Awaited<ReturnType<typeof getWorkspaceById>>>,
    projectId: string,
    issueId: string,
    baseBranch: string | null,
    repoPath: string | null,
    sessionId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    try {
      await finalizeMergeCleanup({
        database: db,
        boardEvents,
        workspaceId: fresh.id,
        issueId,
        now,
        mergedAt: now,
        closedAt: now,
        workingDir: null,
        projectId,
      });
    } catch (err) {
      console.warn(`[workflow] #950 could not finalize landed fix-and-merge workspace ${fresh.id}:`, errorMessage(err));
      return;
    }
    try {
      await stampReconciledLeadingMerge({ gitService, database: db, workspaceId: fresh.id, now });
    } catch (err) {
      console.warn(`[workflow] #950 leading mergedHeadSha stamp failed (non-fatal) for workspace ${fresh.id}:`, errorMessage(err));
    }
    // Teardown, from the PRE-NULL snapshot (`fresh`) — see the note above on why this cannot be
    // deferred to another path once `workingDir` is null. Ordered exactly as every other
    // terminal path: the service stack/container holds the directory's bind mount, so it is
    // released BEFORE anything removes the directory.
    try {
      if (fresh.workingDir && !fresh.isDirect) {
        await releaseWorkspaceResources({ ...fresh, id: fresh.id }, { phase: "fix-and-merge-landed" });
        if (repoPath) {
          const workingDir = fresh.workingDir;
          // #713 co-residency: a co-resident sharer's live checkout must survive this removal.
          await removeWorktreeUnlessShared({
            database: db,
            workingDir,
            workspaceId: fresh.id,
            label: "merge:fix-and-merge-landed",
            removeWorktree: () => gitService.removeWorktree(repoPath, workingDir),
          });
        }
      }
      // Multi-repo (#114/#115): siblings orphan forever otherwise, for the same reason —
      // `preserveUnmerged` re-verifies each repo, so a sibling still carrying unmerged commits
      // keeps its worktree and branch.
      await cleanupSiblingWorktrees(gitService, fresh.id, db, { preserveUnmerged: true });
    } catch (err) {
      console.warn(`[workflow] #950 worktree teardown failed (non-fatal) for workspace ${fresh.id}:`, errorMessage(err));
    }
    // No broadcast here: `finalizeMergeCleanup` already emits `workspace_merged` when it
    // actually changed something, which is a strictly better condition than an unconditional one.
    console.log(
      `[workflow] #950 fix-and-merge resolver for workspace ${fresh.id} (session ${sessionId}) landed branch ${fresh.branch} `
        + `on ${baseBranch ?? "base"} itself${repoPath ? ` in ${repoPath}` : ""} — stamped mergedAt + closed the workspace `
        + `(autoMerge had nothing to merge, so nothing else would have)`,
    );
  }

  /**
   * #764 stranded-resolver guard. After a fix-and-merge resolver session exits, verify the
   * branch actually landed on its base. If it did NOT (the concurrent-merge loser whose
   * conflict against the moved base is real — autoMerge's plumbing merge threw and was
   * swallowed), make sure the workspace stays OPEN and idle so it is retryable, and clear the
   * stale readyForMerge flag so nothing re-treats a conflicted branch as mergeable. Never close
   * it — that is exactly the strand (ticket conflicted, no workspace) this guard prevents.
   *
   * Best-effort and idempotent: if the branch DID land, this stamps the merge and closes the
   * workspace (see {@link finalizeLandedResolverWorkspace}). If the ancestry check can't run, we
   * conservatively leave the open workspace idle (still retryable) rather than risk stranding it.
   */
  async function keepResolverWorkspaceRetryableIfUnlanded(
    workspace: WorkspaceRow,
    projectId: string,
    issueId: string,
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

      if (landed) {
        // #950: "cleanup runs elsewhere" was the assumption, and it does not hold when the fix
        // agent lands the branch ITSELF (hand `git merge` in the worktree). Then autoMerge's
        // `runMergeCore` has nothing to merge, so `merge.landed` stays null and the close in
        // `merge-workflow.ts` writes no `mergedAt` — while git says the branch is unambiguously
        // on base. The row is left OPEN with `mergedAt: null`, and `findOpenUnmergedWorkspace`
        // (the Done guard) keys on exactly `status != "closed"`, so a CORRECT guard then refuses
        // the Done transition on a FALSE premise. Observed live on #944: merge commit e586e93f90,
        // `rev-list --count master..branch` = 0, and the only way forward was deleting the
        // workspace.
        //
        // The ancestor-branch reconciler does NOT recover it, and must not be changed to: it
        // skips any candidate whose `countUniqueCommits(baseSha..branchSha)` is 0, which is true
        // of a merged branch AND of a never-committed one, and that guard is what prevents the
        // #585 mass silent-merge-loss incident (auto-Done-ing work that never landed). From the
        // reconciler's vantage the two cases are genuinely indistinguishable.
        //
        // Here they are not: this path KNOWS a fix agent just ran against this branch, and has
        // just proven landing from git ground truth. So the stamp belongs here, where the
        // evidence is, rather than in a sweep that would have to guess.
        await finalizeLandedResolverWorkspace(fresh, projectId, issueId, baseBranch, repoPath, sessionId);
        return;
      }

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
    await keepResolverWorkspaceRetryableIfUnlanded(workspace, projectId, issueId, defaultBranch, sessionId);
  }

  return { handleFixAndMergeExit };
}
