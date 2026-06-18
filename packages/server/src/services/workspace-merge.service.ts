import type { projects, workspaces } from "@agentic-kanban/shared/schema";
import { isFailedLaunchSession } from "@agentic-kanban/shared/lib/workspace-activity-state.js";
import {
  getLatestSessionForWorkspace,
  getLatestSessionStatusForWorkspace,
  markSessionStopped,
  countSessionMessages,
  getIssueNumberById,
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
import { computeWorkspaceCodeMetrics } from "./workspace-code-metrics.service.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import {
  WorkspaceError,
  resolveRelaunchAgentSelection,
  requireBaseBranch,
  activeMerges,
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
import { finalizeMergeCleanup } from "./merge-cleanup.service.js";

export function createWorkspaceMergeService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  gitService?: GitService;
  createBackup?: (reason: string) => Promise<unknown>;
  /** Injectable process killer for testing (defaults to the real killProcessesInDir). */
  processKiller?: (dir: string) => Promise<number>;
}) {
  const { database, getSessionManager, boardEvents } = deps;
  const gitService = deps.gitService ?? realGitService;
  const createBackup = deps.createBackup ?? realCreateBackup;
  const killProcesses = deps.processKiller ?? killProcessesInDir;

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
    eventType: "conflict" | "fix-and-merge-launched" | "reconcile-launched" | "merged" | "warning" | "already-merged" | "direct-closed",
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

  async function recoverFailedFixAndMergeSessionIfNeeded(workspace: typeof workspaces.$inferSelect) {
    if (workspace.status !== "fixing") return;
    if (!getSessionManager) return;

    const latestSession = await getLatestSessionForWorkspace(workspace.id, database);
    if (!latestSession) return;

    const isFailed = isFailedLaunchSession({
      status: latestSession.status,
      startedAt: latestSession.startedAt,
      endedAt: latestSession.endedAt,
      stats: latestSession.stats,
    });
    if (!isFailed) return;

    await forceStopSession(latestSession.id, "stale session");
    await updateWorkspaceStatus(workspace.id, "idle", {}, database);
  }

  async function forceStopSession(sessionId: string, label: string): Promise<void> {
    try {
      await getSessionManager?.().stopSession(sessionId);
    } catch (err) {
      console.warn(`[workspace-merge] failed to force-stop ${label} ${sessionId}:`, err instanceof Error ? err.message : String(err));
    }
    await markSessionStopped(sessionId, new Date().toISOString(), database);
  }

  async function recoverZeroOutputRunningFixAndMergeSession(workspace: typeof workspaces.$inferSelect) {
    if (!getSessionManager) return;
    const latestSession = await getLatestSessionStatusForWorkspace(workspace.id, database);
    if (!latestSession) return;
    if (latestSession.triggerType !== "fix-and-merge") return;
    const ageMs = Date.now() - new Date(latestSession.startedAt).getTime();
    if (ageMs < 60_000) return;
    if (latestSession.status !== "running") return;

    const msgCount = await countSessionMessages(latestSession.id, database);
    if (msgCount !== 0) return;

    try {
      console.log(
        `[workspace-merge] stopping stale zero-output fix-and-merge session ${latestSession.id} for workspace ${workspace.id} ` +
          `after ${Math.round(ageMs / 1000)}s with no messages`,
      );
      await forceStopSession(latestSession.id, "stale zero-output session");
    } catch (err) {
      console.warn(
        `[workspace-merge] failed to force-stop stale zero-output session ${latestSession.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    await updateWorkspaceStatus(workspace.id, "idle", {}, database);
  }

  async function mergeWorkspace(id: string) {
    let workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    await recoverFailedFixAndMergeSessionIfNeeded(workspace);
    await recoverZeroOutputRunningFixAndMergeSession(workspace);
    workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");

    const { project, repoPath, defaultBranch } = await resolveProjectFull(id, database);

    const existingLock = activeMerges.get(repoPath);
    if (existingLock) {
      const diagnostic = describeMergeLock(existingLock);
      if (diagnostic.isStale) {
        console.warn(
          `[workspace-merge] recovering stale merge lock: repoPath=${repoPath} ` +
            `activeWorkspaceId=${diagnostic.activeWorkspaceId} ageMs=${diagnostic.ageMs}`,
        );
        activeMerges.delete(repoPath);
      } else {
        if (existingLock.workspaceId === id) {
          console.log(`[workspace-merge] reusing in-flight merge result for workspace ${id} on repo ${repoPath}`);
          return await existingLock.promise;
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

    const rawMergePromise = doMerge(id, workspace, project, repoPath, defaultBranch);
    const mergePromise = rawMergePromise.catch((err) => {
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
    });
    const lock = {
      promise: mergePromise,
      workspaceId: id,
      repoPath,
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
    };
    activeMerges.set(repoPath, lock);
    // Always clear the lock - both on success and on rejection - so a crashed
    // merge never strands the repo behind a stale in-memory lock.
    mergePromise.finally(() => {
      if (activeMerges.get(repoPath) === lock) {
        activeMerges.delete(repoPath);
      }
    }).catch(() => { /* swallow: caller awaits mergePromise below */ });

    return await mergePromise;
  }

  async function doMerge(
    id: string,
    workspace: typeof workspaces.$inferSelect,
    project: typeof projects.$inferSelect | null,
    repoPath: string,
    defaultBranch: string | null,
  ) {
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
    const prefMap = await loadMergePreferences(database);
    const autoMergeInReview = prefMap.get("auto_merge_in_review") === "true";
    const resolution = await resolveMergeState(workspace, repoPath, baseBranch, { gitService, autoMergeInReview });
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
      killProcesses,
      killWorktreeProcesses,
      addRecoverableWarning,
      recordMergeAttempt,
    });
    if (preflight.kind === "completed") return preflight.result;
    await runWorkspacePreMergeValidation({ workspace, repoPath, baseBranch, gitService });

    const targetBranch = baseBranch;
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
    });

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
    };
    setImmediate(() => {
      void runWorkspacePostMergeCleanup(postMergeArgs, { database, gitService, killProcesses, getSessionManager, boardEvents });
    });

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

    // Stop any processes the agent left running in the worktree before we rewrite history.
    await killWorktreeProcesses(workspace.workingDir, `update-base:pre`);

    let result: { success: boolean; conflictingFiles?: string[]; error?: string };
    if (mode === "merge") {
      result = await gitService.mergeBaseIntoBranch(workspace.workingDir, baseBranch);
    } else {
      result = await gitService.rebaseOntoBase(workspace.workingDir, baseBranch, workspace.branch, { preferLocalBase: true });
    }

    // And again after - rebase/merge can spawn helpers (hook scripts, editors) that linger.
    await killWorktreeProcesses(workspace.workingDir, `update-base:post`);

    console.log(`[workspace-service] update-base: workspaceId=${id} mode=${mode} success=${result.success} conflicts=${result.conflictingFiles?.length ?? 0}`);

    if (result.success) {
      await computeWorkspaceCodeMetrics(id, database).catch(() => null);
    }

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "board_changed");

    return result;
  }

  async function abortRebase(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) {
      throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    }

    await gitService.abortRebase(workspace.workingDir);
    await killWorktreeProcesses(workspace.workingDir, "abort-rebase");
    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "board_changed");
    return { ok: true };
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
    const prompt = buildConflictResolutionPrompt(conflictingFiles, baseBranch);

    const resolverProjectId = await resolveProjectId(id, database);
    const { agentCommand, agentArgs, claudeProfile, profile, provider } =
      await resolveRelaunchAgentSelection(database, resolverProjectId, refreshedWorkspace);
    const executorProvider = toExecutorProvider(provider);

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt, agentCommand, agentArgs, claudeProfile, profile,
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
    const { agentCommand, agentArgs, claudeProfile, profile, provider } =
      await resolveRelaunchAgentSelection(database, fixProjectId, workspace);
    const executorProvider = toExecutorProvider(provider);

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt, agentCommand, agentArgs, claudeProfile, profile,
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
    const rebaseResult = await gitService.rebaseOntoBase(workspace.workingDir, baseBranch, workspace.branch, {
      preferLocalBase: true,
    });
    if (rebaseResult.success) {
      await computeWorkspaceCodeMetrics(id, database).catch(() => null);
      return `Before launching this fix-and-merge agent, the app rebased the workspace branch onto '${baseBranch}' successfully.`;
    }

    const conflictingFiles = rebaseResult.conflictingFiles ?? [];
    return `Before launching this fix-and-merge agent, the app tried to rebase the workspace branch onto '${baseBranch}' ` +
      "and left the rebase in progress for you to resolve." +
      (conflictingFiles.length > 0 ? ` Conflicting files: ${conflictingFiles.join(", ")}.` : "") +
      (rebaseResult.error ? ` Rebase error: ${rebaseResult.error}` : "");
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

    const { agentCommand, agentArgs, claudeProfile, profile, provider } =
      await resolveRelaunchAgentSelection(database, projectId, workspace);
    const executorProvider = toExecutorProvider(provider);

    const sessionId = await getSessionManager().startSession({
      workspaceId: integrationWorkspaceId, prompt, agentCommand, agentArgs, claudeProfile, profile,
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

  /**
   * Check whether a workspace's branch is already fully merged into the default branch:
   * no diff against the base branch AND the branch's HEAD commit is reachable from it.
   * Returns a summary the operator can review before confirming reconciliation.
   */
  async function checkAlreadyMerged(id: string): Promise<{
    isAlreadyMerged: boolean;
    branch: string;
    baseBranch: string;
    mergeCommitSha: string | null;
    issueNumber: number | null;
    reason?: string;
  }> {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (workspace.isDirect) throw new WorkspaceError("Not applicable to direct workspaces", "BAD_REQUEST");
    if (!workspace.branch) throw new WorkspaceError("Workspace has no branch", "BAD_REQUEST");

    const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

    // Resolve issue number for the confirmation summary
    const issueNumber = await getIssueNumberById(workspace.issueId, database);

    // Check working-dir exists for accurate diff
    let diffOutput = "";
    let diffFromWorktree = false;
    if (workspace.workingDir) {
      try {
        diffOutput = await gitService.getDiff(workspace.workingDir, baseBranch);
        diffFromWorktree = true;
      } catch {
        // worktree gone - fall through to repo-level diff
      }
    }
    if (!diffFromWorktree) {
      diffOutput = await gitService.getDiffFromRepo(repoPath, workspace.branch, baseBranch);
    }

    if (diffOutput.trim() !== "") {
      return {
        isAlreadyMerged: false,
        branch: workspace.branch,
        baseBranch,
        mergeCommitSha: null,
        issueNumber,
        reason: "Branch still has a diff against " + baseBranch,
      };
    }

    const ancestryResult = await gitService.checkBranchTipIsAncestor(repoPath, workspace.branch, baseBranch, workspace.workingDir ?? undefined);
    if (ancestryResult.branchSha === null) {
      return {
        isAlreadyMerged: false,
        branch: workspace.branch,
        baseBranch,
        mergeCommitSha: null,
        issueNumber,
        reason: ancestryResult.reason === "base-not-found"
          ? "Could not resolve base branch " + baseBranch
          : "Branch ref not found and no worktree available",
      };
    }
    const branchSha = ancestryResult.branchSha;
    const baseSha = ancestryResult.baseSha;
    if (!ancestryResult.isAncestor) {
      return {
        isAlreadyMerged: false,
        branch: workspace.branch,
        baseBranch,
        mergeCommitSha: null,
        issueNumber,
        reason: "Branch commit is not reachable from " + baseBranch,
      };
    }

    let uniqueCommits = 0;
    try {
      uniqueCommits = await gitService.countUniqueCommits(repoPath, baseSha, branchSha);
    } catch {
      uniqueCommits = 0;
    }
    const originalUniqueCommits = uniqueCommits === 0 && branchSha !== baseSha && workspace.baseCommitSha
      ? await gitService.countUniqueCommits(repoPath, workspace.baseCommitSha, branchSha).catch(() => 0)
      : 0;
    if (uniqueCommits === 0 && originalUniqueCommits === 0) {
      return {
        isAlreadyMerged: false,
        branch: workspace.branch,
        baseBranch,
        mergeCommitSha: null,
        issueNumber,
        reason: "Branch has no unique commits relative to " + baseBranch,
      };
    }

    // Find the merge commit: the commit on baseBranch that first introduced this SHA
    let mergeCommitSha: string | null = null;
    try {
      mergeCommitSha = (await gitService.revParse(repoPath, baseBranch)).trim() || null;
    } catch { /* non-fatal */ }

    return {
      isAlreadyMerged: true,
      branch: workspace.branch,
      baseBranch,
      mergeCommitSha,
      issueNumber,
    };
  }

  /**
   * Reconcile an already-merged workspace as Done without running git merge:
   * close the workspace and move the issue to Done.
   */
  async function reconcileAlreadyMerged(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (workspace.status === "closed") throw new WorkspaceError("Workspace is already closed", "BAD_REQUEST");

    const check = await checkAlreadyMerged(id);
    if (!check.isAlreadyMerged) {
      throw new WorkspaceError(
        check.reason ?? "Branch is not fully merged into " + check.baseBranch,
        "BAD_REQUEST",
        { reason: check.reason },
      );
    }

    const { repoPath } = await resolveProjectRepo(id, database);
    const now = new Date().toISOString();

    await finalizeMergeCleanup({
      database,
      boardEvents,
      workspaceId: id,
      issueId: workspace.issueId,
      now,
      closedAt: workspace.closedAt ?? now,
      mergedAt: workspace.mergedAt ?? now,
      workingDir: null,
    });

    // Best-effort worktree cleanup
    if (workspace.workingDir && !workspace.isDirect) {
      try { await gitService.removeWorktree(repoPath, workspace.workingDir); } catch { /* non-fatal */ }
    }

    try {
      await recordMergeAttempt(
        workspace,
        "already-merged",
        `Reconciled as Done: branch ${workspace.branch} was already merged into ${check.baseBranch} (commit ${check.mergeCommitSha ?? "unknown"}).`,
        { baseBranch: check.baseBranch, mergeCommitSha: check.mergeCommitSha, reconciledAt: now },
        now,
      );
    } catch { /* non-fatal */ }

    return {
      id,
      branch: check.branch,
      baseBranch: check.baseBranch,
      mergeCommitSha: check.mergeCommitSha,
      issueNumber: check.issueNumber,
      reconciledAt: now,
    };
  }

  /**
   * Deduplicating entry point for HTTP merge requests: if a merge for this workspace is
   * already in-flight (e.g. a double-click or a monitor retry while the first request is
   * still pending), the caller receives the same promise instead of starting a second
   * merge. The lock lives at the service level so tests can verify deduplication without
   * spinning up an HTTP server.
   */
  const activeRequests = new Map<string, Promise<Awaited<ReturnType<typeof mergeWorkspace>>>>();

  function mergeWorkspaceDeduped(id: string): Promise<Awaited<ReturnType<typeof mergeWorkspace>>> {
    const existing = activeRequests.get(id);
    if (existing) return existing;

    const promise = mergeWorkspace(id);
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

  return { mergeWorkspace, mergeWorkspaceDeduped, updateBase, abortRebase, resolveConflicts, fixAndMerge, reconcileBatch, checkAlreadyMerged, reconcileAlreadyMerged };
}
