import type { projects, workspaces } from "@agentic-kanban/shared/schema";
import { LEADING_REPO_KEY, type RepoRebaseResponse } from "@agentic-kanban/shared";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import {
  recoverFailedFixAndMergeSessionIfNeeded as recoverFailedFixAndMergeSession,
  recoverZeroOutputRunningFixAndMergeSession as recoverZeroOutputRunningFixAndMerge,
} from "./fix-and-merge-session-recovery.service.js";
import {
} from "../repositories/workspace-merge.repository.js";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import * as realGitService from "./git.service.js";
import { createBackup as realCreateBackup } from "../db/backup.js";
import {
  resolveProjectFull,
  resolveProjectId,
  resolveProjectRepo,
  getWorkspaceById,
  updateWorkspaceStatus,
} from "../repositories/workspace.repository.js";
import { killProcessesInDir } from "./process-cleanup.js";
import {
  getConflictingFiles,
  buildConflictResolutionPrompt,
  buildFixAndMergePrompt,
} from "./merge-helpers.service.js";
import { toExecutorProvider } from "./agent-settings.service.js";
import { buildConflictContext } from "./phase-context.service.js";
import { computeWorkspaceCodeMetrics } from "./workspace-code-metrics.service.js";
import { refreshWorkspaceBuildArtifacts } from "./workspace-build-refresh.service.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { markWorkspaceSummaryDirty } from "../repositories/workspace-summary-projection.repository.js";
import {
  WorkspaceError,
  resolveRelaunchAgentSelection,
  requireBaseBranch,
  activeMerges,
  acquireRepoMergeLock,
  tryRecoverStaleMergeLock,
  describeMergeLock,
  resolveMergeState,
  type GitService,
} from "./workspace-internals.js";
import { buildReconcilerPrompt } from "./reconciler.service.js";
import {
  handleWorkspaceMergeResolution,
  loadMergePreferences,
  runWorkspacePreMergeValidation,
  type MergeWarning,
} from "./workspace-merge-prevalidation.service.js";
import { executeWorkspaceMerge } from "./workspace-merge-execution.service.js";
import { runWorkspacePostMergeCleanup } from "./workspace-merge-cleanup.service.js";
import { prevalidateSiblingMerges, executeSiblingMerges } from "./workspace-repos.service.js";
import { getAllWorkspaceRepos } from "./workspace-all-repos.js";
import { getRepoMergeStatus } from "./repo-merge-status.service.js";
import { checkAlreadyMerged as checkAlreadyMergedImpl, reconcileAlreadyMerged as reconcileAlreadyMergedImpl } from "./workspace-already-merged.service.js";
import { resolveMergeGate, RUN_GATE, type MergeGateToken } from "./pre-merge-gate.service.js";
import { recordGateFailureNote as recordGateFailureNoteImpl, runPreLockGate } from "./workspace-merge-gate.js";

export function createWorkspaceMergeService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  gitService?: GitService;
  createBackup?: (reason: string) => Promise<unknown>;
  /** Injectable process killer for testing (defaults to the real killProcessesInDir). */
  processKiller?: (dir: string) => Promise<number>;
  /**
   * Injectable port/supervisor killers for the post-merge worktree teardown. Left
   * undefined in production so {@link teardownWorktree} applies its own real defaults
   * (which spawn `netstat`/`taskkill`). Unit tests SHOULD stub them — otherwise the
   * deferred teardown runs real port sweeps on the worktree's derived dev ports (e.g.
   * an `ak-99` worktree → 3100/5272), which is slow AND could kill a genuine dev server
   * listening there. NOT defaulted here: the merge service must not reference the real
   * port killers, so a test that partially mocks `process-cleanup.js` (only
   * killProcessesInDir) does not trip vitest's strict missing-export guard.
   */
  portKiller?: (ports: number[]) => Promise<number>;
  supervisorKiller?: (ports: number[]) => Promise<number>;
}) {
  const { database, getSessionManager, boardEvents } = deps;
  const gitService = deps.gitService ?? realGitService;
  const createBackup = deps.createBackup ?? realCreateBackup;
  const killProcesses = deps.processKiller ?? killProcessesInDir;
  const killPorts = deps.portKiller;
  const killSupervisor = deps.supervisorKiller;

  /**
   * Options threaded from the merge entry points down into {@link doMerge}.
   *
   * `gate` is the explicit merge-gate DECISION token (see pre-merge-gate.service.ts) — it
   * replaced the old opaque `skipPreMergeGate: boolean` (#943 / arch-review §1.2). The single
   * gate owner `resolveMergeGate` interprets it:
   *   - omitted / `run-gate`  → run the verify/smoke gate before landing (manual/operator
   *     `/merge`, the merge-queue/orchestrator, and the LLM-driven batch reconciler all default
   *     here and stay gated);
   *   - `already-passed`      → the in-process monitor already ran the gate this cycle (or the
   *     work was gated at review-exit → readyForMerge) and hands over PROOF, so `doMerge` does
   *     not double an expensive build/boot — but stale/absent proof forces the gate anyway;
   *   - `skip-explicit`       → a documented, deliberate ungated merge.
   */
  type MergeOptions = {
    gate?: MergeGateToken;
    /**
     * Defer the MAIN checkout's post-merge `git reset --hard` past this call (#686). Only the
     * interactive HTTP merge route sets it — see `executeWorkspaceMerge`. Every other caller
     * syncs inline so the main checkout can never be observed contradicting HEAD (#350).
     */
    deferMainCheckoutSync?: boolean;
  };

  function warningMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function addRecoverableWarning(warnings: MergeWarning[], step: string, err: unknown): void {
    const message = warningMessage(err);
    warnings.push({ step, message, recoverable: true });
    console.warn(`[workspace-merge] ${step} failed after git merge landed (recoverable):`, message);
  }

  async function recordMergeAttempt(
    workspace: typeof workspaces.$inferSelect,
    eventType: "conflict" | "fix-and-merge-launched" | "reconcile-launched" | "merged" | "warning" | "already-merged" | "direct-closed" | "gate-failed",
    body: string,
    payload: Record<string, unknown> = {},
    createdAt = new Date().toISOString(),
  ): Promise<void> {
    try {
      await insertIssueComment({
        issueId: workspace.issueId,
        workspaceId: workspace.id,
        kind: "merge-attempt",
        author: "system",
        body,
        payload: { eventType, workspaceId: workspace.id, branch: workspace.branch, ...payload },
        createdAt,
      }, database);
    } catch (err) {
      console.warn("[workspace-merge] failed to record merge timeline event:", err instanceof Error ? err.message : String(err));
    }
  }

  /** Thin binding of the extracted gate-failure recorder to this service's collaborators. */
  const recordGateFailureNote = (
    workspace: typeof workspaces.$inferSelect,
    stage: string,
    gateMessage: string,
    targetBranch: string,
  ): Promise<void> =>
    recordGateFailureNoteImpl({ workspace, stage, gateMessage, targetBranch, database, recordMergeAttempt });

  /** Best-effort kill of processes in the worktree dir using the injected killer. */
  async function killWorktreeProcesses(workingDir: string | null | undefined, label: string): Promise<void> {
    if (!workingDir) return;
    try {
      const killed = await killProcesses(workingDir);
      if (killed > 0) console.log(`[workspace-merge] ${label}: killed ${killed} leftover process(es) in ${workingDir}`);
    } catch (err) {
      console.warn(`[workspace-merge] ${label}: killWorktreeProcesses failed (non-fatal):`, err instanceof Error ? err.message : String(err));
    }
  }

  // Stranded fix-and-merge session recovery lives in its own module (god-module ceiling):
  // see services/fix-and-merge-session-recovery.service.ts. Bound here so the call sites below
  // read unchanged.
  const recoveryDeps = { database, getSessionManager, gitService };
  const recoverFailedFixAndMergeSessionIfNeeded = (workspace: typeof workspaces.$inferSelect) =>
    recoverFailedFixAndMergeSession(workspace, recoveryDeps);
  const recoverZeroOutputRunningFixAndMergeSession = (workspace: typeof workspaces.$inferSelect) =>
    recoverZeroOutputRunningFixAndMerge(workspace, recoveryDeps);

  async function mergeWorkspace(id: string, opts: MergeOptions = {}) {
    let workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    await recoverFailedFixAndMergeSessionIfNeeded(workspace);
    await recoverZeroOutputRunningFixAndMergeSession(workspace);
    workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");

    const { project, repoPath, defaultBranch } = await resolveProjectFull(id, database);

    // Manual-merge semantics are refuse/reuse (intentional, unlike autoMerge's
    // queueing): an in-flight merge for the same workspace is reused; for a
    // different workspace we return "already in progress" instead of queueing.
    const existingLock = activeMerges.get(repoPath);
    if (existingLock) {
      const diagnostic = describeMergeLock(existingLock);
      // Stale-lock recovery goes through tryRecoverStaleMergeLock (#970): it
      // refuses when a fresh .git/index.lock suggests the holder's git process
      // is still alive, in which case we fall through to refuse/reuse below.
      const recovered = diagnostic.isStale && tryRecoverStaleMergeLock(repoPath, existingLock);
      if (!recovered) {
        if (existingLock.workspaceId === id) {
          console.log(`[workspace-merge] reusing in-flight merge result for workspace ${id} on repo ${repoPath}`);
          // resultPromise settles as soon as the merge response is ready; the
          // lock itself may stay held longer for post-merge cleanup (#970).
          return await (existingLock.resultPromise ?? existingLock.promise);
        }
        throw new WorkspaceError(
          `A merge is already in progress for this repository ` +
            `(workspace ${diagnostic.activeWorkspaceId}, age ${Math.round(diagnostic.ageMs / 1000)}s). ` +
            "Please wait for it to complete.",
          "CONFLICT",
          diagnostic,
        );
      }
    }

    // THROUGHPUT: run the verify gate BEFORE taking the repo lock, not inside it.
    //
    // The gate (verify_script — tests + build) is the expensive part of a merge: 20-40 min on
    // this repo. The git work it guards takes seconds. Running it inside the lock turned the
    // per-repo lock into a repo-wide throughput cap of roughly one merge per gate duration, and
    // made a FAILING gate even more costly than a passing one: it blocked every other
    // workspace for its full run while landing nothing (measured: one gate held the lock 41
    // minutes and then failed, with three other workspaces sitting ready behind it).
    //
    // This is NOT a new weakening of the gate. `already-passed` evidence is exactly what the
    // in-process monitor has always handed the merge path (it gates during its cycle, then
    // merges), and `resolveMergeGate` rejects evidence older than
    // MERGE_GATE_EVIDENCE_MAX_AGE_MS — so if we then wait a long time for the lock, doMerge
    // re-runs the gate under the lock exactly as before. Worst case degrades to the old
    // behaviour; the common case holds the lock for seconds.
    //
    // Deliberately placed AFTER the refuse/reuse check above: when another merge is already in
    // flight this call is going to be refused anyway, and gating first would burn a full test
    // run to produce that refusal.
    const gateToken: MergeGateToken = await runPreLockGate({
      workspaceId: id,
      workspace,
      projectId: project?.id ?? null,
      baseBranch: requireBaseBranch(workspace.baseBranch || defaultBranch),
      token: opts.gate ?? RUN_GATE,
      database,
      recordMergeAttempt,
    });

    // Install the lock and run the merge via the shared primitive (#944) so the
    // entry can never be overwritten by a concurrent acquirer.
    return await acquireRepoMergeLock(repoPath, id, (extendHold) =>
      // #943: thread `opts` (e.g. skipPreMergeGate from the monitor auto-merge path) through.
      doMerge(id, workspace, project, repoPath, defaultBranch, extendHold, { ...opts, gate: gateToken }).catch((err) => {
        // A TypeError (e.g. "gitService.X is not a function") means shared/dist is stale —
        // a deploy/build issue, NOT a merge conflict. Return a distinct 503 so the board
        // monitor can rebuild rather than attempting a wasted fix-and-merge.
        if (err instanceof TypeError && !(err instanceof WorkspaceError)) {
          throw new WorkspaceError(
            `Merge helper unavailable — the server build may be stale. Rebuild shared/dist and restart. (${err.message})`,
            "CONFLICT",
            { mergeReason: "server_build_stale", originalMessage: err.message },
          );
        }
        throw err;
      }),
    );
  }

  async function doMerge(
    id: string,
    workspace: typeof workspaces.$inferSelect,
    project: typeof projects.$inferSelect | null,
    repoPath: string,
    defaultBranch: string | null,
    extendHold: (p: Promise<unknown>) => void = () => {},
    opts: MergeOptions = {},
  ) {
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
    console.log(`[workspace-merge] doMerge phase=start workspaceId=${id} repoPath=${repoPath} baseBranch=${baseBranch}`);
    const prefMap = await loadMergePreferences(database);
    const autoMergeInReview = getBool(prefMap, "auto_merge_in_review");
    // `database` makes the pre-flight multi-repo aware: the reconcile/clean-ancestor
    // short-circuits only fire when NO sibling repo has pending unmerged commits.
    const resolution = await resolveMergeState(workspace, repoPath, baseBranch, { gitService, autoMergeInReview, database });
    const preflight = await handleWorkspaceMergeResolution({
      id,
      workspace,
      project,
      repoPath,
      baseBranch,
      resolution,
      database,
      boardEvents,
      gitService,
      createBackup,
      killProcesses,
      killWorktreeProcesses,
      addRecoverableWarning,
      recordMergeAttempt,
    });
    if (preflight.kind === "completed") return preflight.result;
    console.log(`[workspace-merge] doMerge phase=pre-merge-validation workspaceId=${id}`);
    await runWorkspacePreMergeValidation({ workspace, repoPath, baseBranch, gitService });

    // Gate the merge with the SAME verify_script + boot/render smoke gate every path shares
    // (arch-review §1.2). The DECISION is delegated to the single owner `resolveMergeGate`,
    // driven by the caller's explicit token (`opts.gate`):
    //   - manual/operator `/merge`, the merge-queue/orchestrator, and the LLM batch reconciler
    //     default to `run-gate` (no token) → always re-verify before landing (#930). Without this
    //     a hand-merge could land build/test/boot-UNVERIFIED code on a gated project.
    //   - the in-process monitor passes `already-passed` PROOF (#943): it ran the gate this cycle
    //     for un-ready In-Review work, or the work was gated at review-exit (readyForMerge). Valid
    //     proof avoids doubling an expensive build/boot; STALE/absent proof re-runs the gate.
    // On failure we WITHHOLD the merge (throw, surfaced to the operator) rather than land it.
    if (project) {
      console.log(`[workspace-merge] doMerge phase=pre-merge-gate workspaceId=${id}`);
      const gate = await resolveMergeGate({
        token: opts.gate ?? RUN_GATE,
        // `baseBranch` is REQUIRED here, not decorative (#239): without it
        // `resolveMergeGateShas` cannot resolve the base tip, so content-keyed
        // `already-passed` evidence would validate on the branch tip alone — which also
        // waives the 15-minute freshness check. Since the gate runs OUTSIDE the repo lock,
        // that is exactly the window in which another merge moves the base and this
        // workspace's never-verified merge RESULT lands on a stale proof. It also lets the
        // in-lock re-gate read the diff for the docs-only skip and test scoping.
        workspace: { id, workingDir: workspace.workingDir, baseBranch },
        projectId: project.id,
        database,
      });
      if (!gate.passed) {
        await recordGateFailureNote(workspace, gate.stage, gate.message, baseBranch);
        throw new WorkspaceError(
          `Pre-merge gate failed (${gate.stage}) — merge withheld. ${gate.message}`,
          "CONFLICT",
          { mergeReason: "pre_merge_gate_failed", gateStage: gate.stage },
        );
      }
      if (gate.ran) {
        console.log(`[workspace-merge] pre-merge gate passed for workspace ${id} (${gate.stage}); proceeding with merge`);
      } else if (gate.decision !== "run-gate") {
        console.log(`[workspace-merge] pre-merge gate decision '${gate.decision}' for workspace ${id}: ${gate.message}`);
      }
    }

    // Multi-repo (full-peers): prevalidate ALL sibling repos BEFORE anything lands —
    // all-or-nothing, so a conflicted sibling can never strand the leading repo
    // merged alone. Empty for single-repo workspaces. Throws on any failure.
    // Deliberately run AFTER the pre-merge gate above (which can block for
    // minutes on tests/review), not before it — running it earlier would leave
    // a wide TOCTOU window in which sibling repo state could drift before the
    // all-or-nothing sibling merge actually lands (adversarial-review finding 22).
    if (!workspace.isDirect) {
      console.log(`[workspace-merge] doMerge phase=sibling-prevalidation workspaceId=${id}`);
    }
    const siblingPlans = workspace.isDirect
      ? []
      : await prevalidateSiblingMerges({ gitService, database, workspaceId: id });

    const targetBranch = baseBranch;
    console.log(`[workspace-merge] doMerge phase=execute-merge workspaceId=${id} targetBranch=${targetBranch}`);
    const { response, postMergeContext } = await executeWorkspaceMerge({
      id,
      workspace,
      repoPath,
      targetBranch,
      database,
      boardEvents,
      gitService,
      createBackup,
      recordMergeAttempt,
      deferMainCheckoutSync: opts.deferMainCheckoutSync === true,
    });

    // Multi-repo: land the prevalidated sibling merges (leading repo first — just
    // done above). A failure here is a post-prevalidation race; it's recorded
    // per-repo on the issue rather than failing the already-landed leading merge,
    // and post-merge cleanup preserves the unmerged sibling branch for fix-up.
    if (siblingPlans.length > 0) {
      const siblingResults = await executeSiblingMerges({ gitService, database, createBackup, workspaceId: id, plans: siblingPlans });
      const failed = siblingResults.filter((r) => !r.merged);
      if (failed.length > 0) {
        await recordMergeAttempt(
          workspace,
          "conflict",
          `Multi-repo merge PARTIAL: leading repo merged, but ${failed.length} sibling repo merge(s) failed after prevalidation: ` +
            failed.map((f) => `${f.name ?? f.path}: ${f.error}`).join("; ") +
            ". The unmerged sibling branches were preserved — merge them manually.",
          { mergeReason: "sibling_merge_failed", siblingResults, targetBranch },
        );
      }
    }

    const postMergeArgs = {
      workspaceId: id,
      issueId: workspace.issueId,
      repoPath,
      preMergeHead: postMergeContext.preMergeHead,
      prefMap,
      projectId: postMergeContext.projectId,
      workingDir: workspace.workingDir,
      branch: workspace.branch,
      mergeResult: postMergeContext.mergeResult,
      teardownScript: project?.teardownScript ?? null,
      setupEnabled: project?.setupEnabled ?? true,
      isDirect: workspace.isDirect,
      pendingWorkingTreeSyncSha: postMergeContext.pendingWorkingTreeSyncSha,
      serviceState: workspace.serviceState ?? null,
    };
    // Deferred post-merge cleanup. The repo merge lock outlives the response ONLY
    // for the deferred `git reset --hard` sync of the MAIN checkout (#970): until
    // that sync applies, a second merge's dirty-main guard would see the stale
    // tree and block (the recurring "auto-merge blocked by dirty main" incident
    // class). So:
    //
    // - pendingWorkingTreeSyncSha set → extendHold keeps the lock exactly until
    //   the cleanup signals onMainCheckoutSettled (the sync has been applied —
    //   a `finally` inside the cleanup fires it even on a throw, so the lock
    //   can never leak).
    // - pendingWorkingTreeSyncSha null → the main checkout is already consistent
    //   (mergeBranch only emits the pending tag when it actually skipped a
    //   reset), so the lock releases with the merge result itself.
    //
    // The rest of the chain — process kills, worktree/branch removal, metrics,
    // OpenSpec, handoff, learning step, auto-starts — always runs AFTER the lock
    // is released. Holding the lock through that long tail serialized every
    // other merge on the repo behind multi-second subprocess hops (and up to 3
    // MINUTES with the learning-step pref on): callers got "A merge is already
    // in progress". Failures there strand at most resources the startup
    // reconcilers already recover.
    //
    // Two earlier constraints are preserved:
    // - setImmediate defers the cleanup past the current call stack so the Hono
    //   response write (JSON body flush) happens first (#563 keep-alive drop).
    // - The reset --hard runs after the HTTP response is already flushed, so a
    //   tsx hot-reload can no longer drop the in-flight connection (#686).
    // The HTTP caller still receives `response` immediately.
    const scheduleDeferredCleanup = (onMainCheckoutSettled?: () => void) => {
      setImmediate(() => {
        runWorkspacePostMergeCleanup(
          postMergeArgs,
          { database, gitService, killProcesses, killPorts, killSupervisor, getSessionManager, boardEvents },
          { onMainCheckoutSettled },
        )
          .catch((err) => {
            console.warn("[workspace-merge] post-merge cleanup failed (non-fatal):", err instanceof Error ? err.message : String(err));
          })
          // Safety net: resolve is idempotent — this only matters if the cleanup
          // threw before signalling.
          .finally(() => onMainCheckoutSettled?.());
      });
    };
    if (postMergeContext.pendingWorkingTreeSyncSha) {
      extendHold(new Promise<void>((releaseLockHold) => scheduleDeferredCleanup(releaseLockHold)));
    } else {
      scheduleDeferredCleanup();
    }

    console.log(`[workspace-merge] doMerge phase=done workspaceId=${id}`);
    return response;
  }

  async function updateBase(id: string, mode: "rebase" | "merge") {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir || workspace.isDirect) {
      throw new WorkspaceError("Not supported for direct workspaces", "BAD_REQUEST");
    }
    if (workspace.status === "closed") {
      throw new WorkspaceError("Workspace is closed", "BAD_REQUEST");
    }

    const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

    // Multi-repo (#72): a cross-cutting ticket touches every repo, so update-base must
    // rebase/merge the leading repo AND every sibling worktree — otherwise a trailing
    // cross-cutting ticket stays behind base in the siblings and strands on merge.

    // Refuse if main checkout HEAD has drifted off the target branch (consistent with /merge guard).
    const currentHeadBranch = await gitService.getCurrentBranch(repoPath);
    if (currentHeadBranch !== baseBranch) {
      throw new WorkspaceError(
        `Cannot update base: main checkout HEAD is on '${currentHeadBranch}' but this workspace targets '${baseBranch}'. ` +
          `Check out '${baseBranch}' in the main checkout before proceeding.`,
        "CONFLICT",
        { currentBranch: currentHeadBranch, targetBranch: baseBranch },
      );
    }

    const runUpdate = (worktree: string, branch: string | null, base: string) =>
      mode === "merge"
        ? gitService.mergeBaseIntoBranch(worktree, base)
        : gitService.rebaseOntoBase(worktree, base, branch ?? "", { preferLocalBase: true });

    // One loop over the uniform repo view (#168): rebase/merge the leading repo (row 0) AND every
    // sibling worktree onto its own base — replacing the old "leading line, then sibling loop".
    // Leading conflicts are reported bare and its errors PROPAGATE (unchanged); sibling conflicts
    // are namespaced by repo and a sibling error is caught so one unreachable repo doesn't abort the
    // others. A repo whose worktree/branch is gone (already landed/cleaned) is skipped. Overall
    // success requires every repo. Processes are killed around each history rewrite.
    const allRepos = await getAllWorkspaceRepos(id, database);
    // #275 — pinned so the artifact refresh below can tell a real rebase from a no-op.
    const headShaBefore = await gitService.revParse(workspace.workingDir, "HEAD").catch(() => null);
    let result: { success: boolean; conflictingFiles?: string[]; error?: string } = { success: true };
    for (const ref of allRepos) {
      const isLeading = ref.kind === "leading";
      const worktree = isLeading ? workspace.workingDir : ref.worktreePath;
      if (!worktree || !ref.branch) continue;
      const repoBase = isLeading ? baseBranch : requireBaseBranch(ref.baseBranch || baseBranch);
      const ns = isLeading ? null : (ref.name ?? ref.path);
      await killWorktreeProcesses(worktree, isLeading ? `update-base:pre` : `update-base:sibling-pre:${ns}`);
      let repoResult: { success: boolean; conflictingFiles?: string[]; error?: string };
      if (isLeading) {
        repoResult = await runUpdate(worktree, ref.branch, repoBase); // leading errors propagate (as before)
      } else {
        try {
          repoResult = await runUpdate(worktree, ref.branch, repoBase);
        } catch (err) {
          repoResult = { success: false, error: `${ns}: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      await killWorktreeProcesses(worktree, isLeading ? `update-base:post` : `update-base:sibling-post:${ns}`);
      if (!repoResult.success) {
        result = {
          success: false,
          conflictingFiles: [
            ...(result.conflictingFiles ?? []),
            ...(repoResult.conflictingFiles ?? []).map((f) => (ns ? `${ns}::${f}` : f)),
          ],
          error: [result.error, repoResult.error].filter(Boolean).join("; ") || result.error,
        };
      }
    }

    console.log(`[workspace-service] update-base: workspaceId=${id} mode=${mode} repos=${allRepos.length} success=${result.success} conflicts=${result.conflictingFiles?.length ?? 0}`);

    // #399 (decision 014): the rebase/merge rewrote this worktree's history, so the
    // persisted summary projection (head sha, commits-ahead count) is now wrong — mark
    // dirty so the next board read / heal tick refreshes it. Marked even on a failed
    // update: a partial sibling rebase may still have moved HEAD.
    await markWorkspaceSummaryDirty(id, database).catch(() => {});

    const projectId = await resolveProjectId(id, database);

    if (result.success) {
      // #275 — the rebase rewrote this worktree's SOURCE but nothing rebuilt its gitignored
      // generated output, so the next verify gate would type-check fresh src against months-old
      // artifacts and fail for reasons that have nothing to do with the branch. Repair it now,
      // while it is cheap, instead of paying a 20-40 minute gate run to discover it.
      await refreshWorkspaceBuildArtifacts({
        workingDir: workspace.workingDir,
        projectId,
        database,
        headShaBefore,
        headShaAfter: await gitService.revParse(workspace.workingDir, "HEAD").catch(() => null),
      });
      await computeWorkspaceCodeMetrics(id, database).catch(() => null);
    }

    if (projectId) boardEvents?.broadcast(projectId, "board_changed");

    return result;
  }

  async function abortRebase(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) {
      throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    }

    // Idempotent: `git rebase --abort` exits non-zero when no rebase is in progress
    // (e.g. a stale UI retry, or a rebase that already resolved), which previously
    // surfaced as a 500. Only invoke it when a rebase is actually in progress.
    if (await gitService.isRebaseInProgress(workspace.workingDir)) {
      await gitService.abortRebase(workspace.workingDir);
    }
    await killWorktreeProcesses(workspace.workingDir, "abort-rebase");
    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "board_changed");
    return { ok: true };
  }

  /**
   * Per-repo recovery for a stranded sibling (#93): rebase just ONE repo's worktree branch
   * onto its own base — the leading repo (`repoName === LEADING_REPO_KEY`) or a single sibling
   * addressed by name. This is REBASE ONLY: it never lands anything, so the all-or-nothing
   * coordinated-merge invariant (prevalidateSiblingMerges/executeSiblingMerges) is untouched —
   * landing is still the whole-workspace merge. On conflict the in-progress rebase is aborted
   * so the worktree is left clean (there is no per-sibling conflict-resolution flow), and the
   * conflicting files are reported so the strip can surface them. Spawns git only through the
   * sanctioned adapter via gitService.rebaseOntoBase/abortRebase.
   */
  async function rebaseRepo(id: string, repoName: string): Promise<RepoRebaseResponse> {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir || workspace.isDirect) {
      throw new WorkspaceError("Not supported for direct workspaces", "BAD_REQUEST");
    }
    if (workspace.status === "closed") {
      throw new WorkspaceError("Workspace is closed", "BAD_REQUEST");
    }

    // One uniform lookup (#168): the leading repo (addressed by the LEADING_REPO_KEY sentinel)
    // and the siblings come from the same list, so this no longer hand-assembles the leading
    // block separately from a sibling `.find`.
    const allRepos = await getAllWorkspaceRepos(id, database);
    const leadingRef = allRepos.find((r) => r.kind === "leading");
    const workspaceBase = requireBaseBranch(leadingRef?.baseBranch ?? workspace.baseBranch);

    let worktree: string;
    let branch: string;
    let base: string;
    let label: string;

    if (repoName === LEADING_REPO_KEY) {
      if (!workspace.branch) throw new WorkspaceError("Leading repo has no branch to rebase", "BAD_REQUEST");
      worktree = workspace.workingDir;
      branch = workspace.branch;
      base = workspaceBase;
      label = "leading";
    } else {
      const repo = allRepos.find((r) => r.kind === "sibling" && r.name === repoName);
      if (!repo) throw new WorkspaceError(`Repo '${repoName}' is not part of this workspace`, "NOT_FOUND");
      if (!repo.worktreePath || !repo.branch) {
        throw new WorkspaceError(`Repo '${repoName}' has no worktree to rebase`, "BAD_REQUEST");
      }
      worktree = repo.worktreePath;
      branch = repo.branch;
      base = requireBaseBranch(repo.baseBranch || workspaceBase);
      label = repoName;
    }

    // Stop leftover agent processes before rewriting history in the worktree.
    await killWorktreeProcesses(worktree, `rebase-repo:pre:${label}`);
    // preferLocalBase mirrors update-base: the board merges into the LOCAL base, so rebase onto
    // it (a stale origin would replay local-only history and conflict spuriously).
    const result = await gitService.rebaseOntoBase(worktree, base, branch, { preferLocalBase: true });
    if (!result.success) {
      // rebaseOntoBase leaves the conflicted rebase in progress; abort so the worktree is clean.
      await gitService.abortRebase(worktree).catch(() => { /* best effort — nothing to abort */ });
    }
    await killWorktreeProcesses(worktree, `rebase-repo:post:${label}`);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "board_changed");

    console.log(`[workspace-merge] rebase-repo: workspaceId=${id} repo=${label} success=${result.success} conflicts=${result.conflictingFiles?.length ?? 0}`);
    return { repo: label, success: result.success, conflictingFiles: result.conflictingFiles, error: result.error };
  }

  async function resolveConflicts(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    await recoverZeroOutputRunningFixAndMergeSession(workspace);
    await recoverFailedFixAndMergeSessionIfNeeded(workspace);
    const refreshedWorkspace = await getWorkspaceById(id, database);
    if (!refreshedWorkspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!refreshedWorkspace.workingDir) throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    if (refreshedWorkspace.status === "fixing") throw new WorkspaceError("Conflict resolution already in progress", "CONFLICT");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    // Kill leftover worktree processes before spawning the resolution agent.
    await killWorktreeProcesses(refreshedWorkspace.workingDir, "resolve-conflicts");

    const conflictingFiles = await getConflictingFiles(refreshedWorkspace.workingDir);
    const { defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(refreshedWorkspace.baseBranch || defaultBranch);
    const conflictContext = await buildConflictContext(refreshedWorkspace.workingDir, conflictingFiles);
    const prompt = buildConflictResolutionPrompt(conflictingFiles, baseBranch, conflictContext);

    const resolverProjectId = await resolveProjectId(id, database);
    const { agentCommand, agentArgs, claudeProfile, profile, provider, model } =
      await resolveRelaunchAgentSelection(database, resolverProjectId, refreshedWorkspace);
    const executorProvider = toExecutorProvider(provider);

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt, agentCommand, agentArgs, claudeProfile, profile, model,
      provider: executorProvider, multiTurn: executorProvider === "codex" ? false : true, triggerType: "fix-conflicts",
    });

    await updateWorkspaceStatus(id, "fixing", {}, database);

    if (resolverProjectId) boardEvents?.broadcast(resolverProjectId, "session_launched");

    return { sessionId };
  }

  async function fixAndMerge(id: string, mergeError?: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    await recoverFailedFixAndMergeSessionIfNeeded(workspace);
    await recoverZeroOutputRunningFixAndMergeSession(workspace);
    const refreshedWorkspace = await getWorkspaceById(id, database);
    if (!refreshedWorkspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (refreshedWorkspace.status === "fixing") throw new WorkspaceError("Fix already in progress", "CONFLICT");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    const errorMessage = mergeError || "Unknown merge error";
    const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(refreshedWorkspace.baseBranch || defaultBranch);

    const rebuildNote = await prepareFixAndMergeRebuildNote(id, refreshedWorkspace, repoPath, baseBranch);

    const prompt = buildFixAndMergePrompt(`${errorMessage}\n\n${rebuildNote}`, baseBranch);

    const fixProjectId = await resolveProjectId(id, database);
    const { agentCommand, agentArgs, claudeProfile, profile, provider, model } =
      await resolveRelaunchAgentSelection(database, fixProjectId, workspace);
    const executorProvider = toExecutorProvider(provider);

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt, agentCommand, agentArgs, claudeProfile, profile, model,
      provider: executorProvider, multiTurn: executorProvider === "codex" ? false : true, triggerType: "fix-and-merge",
      skipLaunchPreflight: true,
    });

    await updateWorkspaceStatus(id, "fixing", {}, database);
    await recordMergeAttempt(
      workspace,
      "fix-and-merge-launched",
      `Launched a fix-and-merge session for workspace ${id}.`,
      { sessionId, mergeError: errorMessage, targetBranch: baseBranch },
    );

    if (fixProjectId) boardEvents?.broadcast(fixProjectId, "session_launched");

    return { sessionId };
  }

  async function prepareFixAndMergeRebuildNote(
    id: string,
    workspace: typeof workspaces.$inferSelect,
    repoPath: string,
    baseBranch: string,
  ): Promise<string> {
    const currentHeadBranch = await gitService.getCurrentBranch(repoPath);
    if (currentHeadBranch !== baseBranch) {
      throw new WorkspaceError(
        `Cannot fix-and-merge: main checkout HEAD is on '${currentHeadBranch}' but this workspace targets '${baseBranch}'. ` +
          `Check out '${baseBranch}' in the main checkout before proceeding.`,
        "CONFLICT",
        { currentBranch: currentHeadBranch, targetBranch: baseBranch },
      );
    }

    await killWorktreeProcesses(workspace.workingDir, "fix-and-merge");
    try {
      return await rebaseWorkspaceForFixAndMerge(id, workspace, baseBranch);
    } catch (err) {
      return `Before launching this fix-and-merge agent, the app tried to rebuild the workspace branch on '${baseBranch}' ` +
        `but the rebuild preflight failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Rebase ONE worktree onto its base for the fix-and-merge preflight. On success the
   * worktree is left rebased+clean; on conflict the rebase is ABORTED so the worktree
   * returns to its attached branch HEAD (a detached mid-rebase strands the reconciler
   * agent — see the block comment below). Returns the per-worktree reconcile state.
   */
  async function rebaseOneWorktreeForFixAndMerge(
    worktree: string,
    branch: string | null,
    base: string,
    label: string,
    ns?: string,
  ): Promise<{ label: string; worktree: string; branch: string; base: string; status: "clean" | "needs-merge"; conflictingFiles: string[] }> {
    const rebaseResult = await gitService.rebaseOntoBase(worktree, base, branch ?? "", { preferLocalBase: true });
    if (rebaseResult.success) {
      return { label, worktree, branch: branch ?? "", base, status: "clean", conflictingFiles: [] };
    }
    // Rebase conflicted: ABORT it so the worktree returns to its attached branch HEAD. A
    // detached mid-rebase (UU) worktree strands the reconciler agent — the stale-safety guard
    // rejects a detached+dirty worktree (STALE_SAFETY_POLICY), the agent emits zero output, and
    // /resolve-conflicts then refuses to recover the very state this preflight created. Attached,
    // the agent reconciles via `git merge <base>` and lands through the board's own primitives.
    const conflictingFiles = (rebaseResult.conflictingFiles ?? []).map((f) => (ns ? `${ns}::${f}` : f));
    await gitService.abortRebase(worktree).catch(() => { /* best effort */ });
    return { label, worktree, branch: branch ?? "", base, status: "needs-merge", conflictingFiles };
  }

  async function rebaseWorkspaceForFixAndMerge(
    id: string,
    workspace: typeof workspaces.$inferSelect,
    baseBranch: string,
  ): Promise<string> {
    if (!workspace.workingDir) throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    const synced = await gitService.syncBranchToHead(workspace.workingDir, workspace.branch);
    if (synced) {
      console.log(`[workspace-merge] fix-and-merge synced branch ${workspace.branch} to worktree HEAD`);
    }

    // Multi-repo (#105): fix-and-merge was leading-repo-blind — it rebased ONLY the leading
    // worktree and the prompt named ONLY "this branch", so for a cross-cutting overlapping
    // ticket the reconciler resolved the leading repo and reported "ready to land" while every
    // sibling worktree stayed conflicted against its advanced main → the atomic merge stays
    // blocked by prevalidateSiblingMerges forever. Rebase the leading worktree AND every sibling
    // worktree onto its own base (mirroring updateBase's sibling loop), then hand the agent an
    // explicit per-worktree reconcile checklist.
    const states: Awaited<ReturnType<typeof rebaseOneWorktreeForFixAndMerge>>[] = [];
    for (const ref of await getAllWorkspaceRepos(id, database)) {
      const isLeading = ref.kind === "leading";
      const worktree = isLeading ? workspace.workingDir : ref.worktreePath;
      if (!worktree || !ref.branch) continue;
      const ns = isLeading ? undefined : (ref.name ?? ref.path);
      const repoBase = isLeading ? baseBranch : requireBaseBranch(ref.baseBranch || baseBranch);
      const label = isLeading ? "leading repo" : `sibling repo '${ns}'`;
      // Siblings get their processes killed around the history rewrite; the leading worktree's
      // are killed by the caller path (mirrors the pre-#168 split — no leading kill here).
      if (ns) await killWorktreeProcesses(worktree, `fix-and-merge:sibling-pre:${ns}`);
      states.push(await rebaseOneWorktreeForFixAndMerge(worktree, ref.branch, repoBase, label, ns));
      if (ns) await killWorktreeProcesses(worktree, `fix-and-merge:sibling-post:${ns}`);
    }

    await computeWorkspaceCodeMetrics(id, database).catch(() => null);

    const needing = states.filter((s) => s.status === "needs-merge");
    if (needing.length === 0) {
      const scope = states.length > 1 ? `the workspace branch and all ${states.length - 1} sibling repo(s)` : "the workspace branch";
      return `Before launching this fix-and-merge agent, the app rebased ${scope} onto '${baseBranch}' successfully — no conflicts. The worktree(s) are clean and attached, ready for the board's merge.`;
    }

    if (states.length === 1) {
      // Single-repo project: keep the original focused instruction.
      const only = needing[0];
      return `Before launching this fix-and-merge agent, the app tried to rebase the workspace branch onto '${baseBranch}' ` +
        "but it conflicted, so the app ABORTED the rebase — the worktree is back on its branch, clean and attached. " +
        `Reconcile by merging '${baseBranch}' into this branch ('git merge ${baseBranch}'), resolve to keep BOTH sides' ` +
        "intent, then land via the board's merge — do NOT continue a rebase." +
        (only.conflictingFiles.length > 0 ? ` Files that conflicted on rebase: ${only.conflictingFiles.join(", ")}.` : "");
    }

    // Multi-repo: enumerate EVERY worktree that still needs reconciling so the agent cannot
    // stop after the leading repo.
    const lines = needing.map((s) => {
      const files = s.conflictingFiles.length > 0 ? ` — files that conflicted on rebase: ${s.conflictingFiles.join(", ")}` : "";
      return `  - ${s.label}: cd "${s.worktree}", run 'git merge ${s.base}', resolve conflicts, remove all conflict markers, verify syntax, commit${files}`;
    });
    return `Before launching this fix-and-merge agent, the app tried to rebase each repo's worktree onto its base, ` +
      `but ${needing.length} of ${states.length} repo worktree(s) CONFLICTED. Those rebases were ABORTED, so every worktree is ` +
      "back on its branch, clean and ATTACHED. THIS IS A MULTI-REPO WORKSPACE: you MUST reconcile EACH worktree listed below " +
      "SEPARATELY — do NOT stop after the first repo and do NOT continue a rebase. In each one, merge its base into its branch, " +
      "resolve to keep BOTH sides' intent, and commit. The board's atomic multi-repo merge stays BLOCKED until every listed " +
      `worktree is reconciled.\n\nWorktrees needing reconciliation:\n${lines.join("\n")}`;
  }

  /**
   * Launch ONE batch merge-reconciler agent over a set of stranded/conflicting workspaces.
   * Sibling of {@link fixAndMerge}: same preflight (kill worktree procs + rebase the integration
   * worktree onto the current base) and same agent-selection/launch plumbing, but the prompt is
   * the merge-reconciler playbook with the whole stranded batch injected - the agent decides the
   * efficient landing strategy (land clean ones first, resolve each overlapping cluster's union
   * once, sequence migration collisions) and lands them via the board's safe primitives.
   * `integrationWorkspaceId` is the least-overlap batch member; the agent runs IN its worktree.
   */
  async function reconcileBatch(
    integrationWorkspaceId: string,
    opts: { strandedBatchJson: string; serverPort: string },
  ) {
    const workspace = await getWorkspaceById(integrationWorkspaceId, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) throw new WorkspaceError("Integration workspace not set up", "BAD_REQUEST");
    if (workspace.status === "fixing") throw new WorkspaceError("Reconcile already in progress", "CONFLICT");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    const { repoPath, defaultBranch } = await resolveProjectRepo(integrationWorkspaceId, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
    const projectId = await resolveProjectId(integrationWorkspaceId, database);

    // Same guard as fixAndMerge/merge: refuse if the main checkout drifted off the base branch.
    const currentHeadBranch = await gitService.getCurrentBranch(repoPath);
    if (currentHeadBranch !== baseBranch) {
      throw new WorkspaceError(
        `Cannot reconcile: main checkout HEAD is on '${currentHeadBranch}' but base is '${baseBranch}'. ` +
          `Check out '${baseBranch}' in the main checkout before proceeding.`,
        "CONFLICT",
        { currentBranch: currentHeadBranch, targetBranch: baseBranch },
      );
    }

    // Prep the integration worktree: kill leftover procs, then rebase onto the current base so the
    // agent resolves the cluster union against the latest base (best-effort; the agent finishes it).
    await killWorktreeProcesses(workspace.workingDir, "reconcile");
    try {
      await gitService.syncBranchToHead(workspace.workingDir, workspace.branch);
      await gitService.rebaseOntoBase(workspace.workingDir, baseBranch, workspace.branch, { preferLocalBase: true });
    } catch (err) {
      console.warn(`[workspace-merge] reconcile preflight rebase failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    const prompt = await buildReconcilerPrompt(database, {
      baseBranch,
      projectId: projectId ?? "",
      serverPort: opts.serverPort,
      integrationWorkspaceId,
      integrationWorkingDir: workspace.workingDir,
      strandedBatch: opts.strandedBatchJson,
    });

    const { agentCommand, agentArgs, claudeProfile, profile, provider, model } =
      await resolveRelaunchAgentSelection(database, projectId, workspace);
    const executorProvider = toExecutorProvider(provider);

    const sessionId = await getSessionManager().startSession({
      workspaceId: integrationWorkspaceId, prompt, agentCommand, agentArgs, claudeProfile, profile, model,
      provider: executorProvider, multiTurn: executorProvider === "codex" ? false : true, triggerType: "reconcile",
      skipLaunchPreflight: true, extraEnv: { KANBAN_SESSION_TYPE: "reconcile" },
    });

    await updateWorkspaceStatus(integrationWorkspaceId, "fixing", {}, database);
    await recordMergeAttempt(
      workspace,
      "reconcile-launched",
      `Launched a batch merge-reconciler session for integration workspace ${integrationWorkspaceId}.`,
      { sessionId, targetBranch: baseBranch },
    );
    if (projectId) boardEvents?.broadcast(projectId, "session_launched");

    return { sessionId };
  }

  // #103: the already-merged check + reconcile pair was extracted to
  // workspace-already-merged.service.ts to keep this module under the god-module ceiling.
  // These thin facades preserve the closure-captured deps (database/gitService/boardEvents
  // + the recordMergeAttempt closure) so importers and the returned API are unchanged.
  const checkAlreadyMerged = (id: string) => checkAlreadyMergedImpl(id, { database, gitService });
  const reconcileAlreadyMerged = (id: string) =>
    reconcileAlreadyMergedImpl(id, { database, gitService, boardEvents, recordMergeAttempt });

  /**
   * Deduplicating entry point for HTTP merge requests: if a merge for this workspace is
   * already in-flight (e.g. a double-click or a monitor retry while the first request is
   * still pending), the caller receives the same promise instead of starting a second
   * merge. The lock lives at the service level so tests can verify deduplication without
   * spinning up an HTTP server.
   */
  const activeRequests = new Map<string, Promise<Awaited<ReturnType<typeof mergeWorkspace>>>>();

  function mergeWorkspaceDeduped(id: string, opts: MergeOptions = {}): Promise<Awaited<ReturnType<typeof mergeWorkspace>>> {
    const existing = activeRequests.get(id);
    if (existing) return existing;

    const promise = mergeWorkspace(id, opts);
    const tracked = promise.finally(() => {
      if (activeRequests.get(id) === tracked) {
        activeRequests.delete(id);
      }
    });
    activeRequests.set(id, tracked);
    tracked.catch((err) => {
      console.warn(
        `[workspace-merge] deduped merge failed for workspace ${id}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
    return tracked;
  }

  return {
    mergeWorkspace, mergeWorkspaceDeduped, updateBase, abortRebase, rebaseRepo, resolveConflicts, fixAndMerge,
    reconcileBatch, checkAlreadyMerged, reconcileAlreadyMerged,
    // #70: per-repo merge status (extracted to keep this module under the god-module ceiling).
    getRepoMergeStatus: (id: string) => getRepoMergeStatus(id, { database, gitService }),
  };
}
