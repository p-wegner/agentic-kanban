import { eq } from "drizzle-orm";
import { preferences, projects, workspaces } from "@agentic-kanban/shared/schema";
import { applyOpenSpecDeltas, OPENSPEC_CHANGES_DIR, OPENSPEC_SPECS_DIR, validateOpenSpecChange } from "@agentic-kanban/shared/lib/openspec";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import * as realGitService from "./git.service.js";
import { createBackup as realCreateBackup } from "../db/backup.js";
import {
  resolveProjectFull,
  resolveProjectId,
  resolveProjectRepo,
  moveIssueToDone,
  getWorkspaceById,
  updateWorkspaceStatus,
} from "../repositories/workspace.repository.js";
import { killProcessesInDir } from "./process-cleanup.js";
import { runScript } from "./script-runner.js";
import { teardownWorktree } from "./workspace-teardown.service.js";
import {
  getConflictingFiles,
  buildConflictResolutionPrompt,
  buildFixAndMergePrompt,
  runLearningStep,
  rebuildSharedIfChanged,
} from "./merge-helpers.service.js";
import { PREF_AUTO_START_FOLLOWUP } from "../constants/preference-keys.js";
import { autoStartFollowups } from "./followup-workspace.service.js";
import { autoStartUnblockedDependencyIssue } from "./dependency-auto-chain.service.js";
import { loadAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import { computeWorkspaceCodeMetrics } from "./workspace-code-metrics.service.js";
import { generateAndPersistGithubHandoffDraft } from "./github-handoff-draft.service.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import {
  WorkspaceError,
  applyWorkspaceAgentSelection,
  requireBaseBranch,
  activeMerges,
  describeMergeLock,
  type GitService,
} from "./workspace-internals.js";

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

  type MergeWarning = { step: string; message: string; recoverable: true };

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
    eventType: "conflict" | "fix-and-merge-launched" | "merged" | "warning" | "already-merged" | "direct-closed",
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

  async function getChangedFilesBetweenSafe(repoPath: string, fromRef: string, toRef: string): Promise<string[]> {
    if (typeof gitService.getChangedFilesBetween !== "function") return [];
    return gitService.getChangedFilesBetween(repoPath, fromRef, toRef);
  }

  async function commitOpenSpecPaths(repoPath: string, branch: string): Promise<boolean> {
    if (typeof gitService.commitPaths !== "function") return false;
    return gitService.commitPaths(
      repoPath,
      [OPENSPEC_SPECS_DIR, OPENSPEC_CHANGES_DIR],
      `Update living OpenSpec specs for ${branch}`,
    );
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

  async function mergeWorkspace(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");

    if (workspace.status === "closed" && workspace.mergedAt) {
      throw new WorkspaceError(
        "Workspace has already been merged.",
        "CONFLICT",
        { mergeReason: "already_merged" },
      );
    }

    if (!workspace.isDirect && !workspace.readyForMerge) {
      throw new WorkspaceError(
        "Workspace is not approved for merge. Mark it as ready-for-merge before merging.",
        "CONFLICT",
        { mergeReason: "not_approved", status: workspace.status },
      );
    }

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
        throw new WorkspaceError(
          `A merge is already in progress for this repository ` +
            `(workspace ${diagnostic.activeWorkspaceId}, age ${Math.round(diagnostic.ageMs / 1000)}s). ` +
            "Please wait for it to complete.",
          "CONFLICT",
          diagnostic,
        );
      }
    }

    const mergePromise = doMerge(id, workspace, project, repoPath, defaultBranch);
    const lock = {
      promise: mergePromise,
      workspaceId: id,
      repoPath,
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
    };
    activeMerges.set(repoPath, lock);
    // Always clear the lock — both on success and on rejection — so a crashed
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
    if (workspace.mergedAt) {
      const warnings: MergeWarning[] = [];
      if (workspace.workingDir && !workspace.isDirect) {
        await teardownWorktree(
          {
            workingDir: workspace.workingDir,
            branch: workspace.branch,
            isDirect: workspace.isDirect,
            teardownScript: project?.teardownScript,
            setupEnabled: project?.setupEnabled,
            label: "merge:already-merged",
          },
          { killDir: killProcesses },
        );
        await killWorktreeProcesses(workspace.workingDir, "merge:already-merged");
        try {
          await gitService.removeWorktree(repoPath, workspace.workingDir);
        } catch (err) {
          addRecoverableWarning(warnings, "remove-worktree", err);
        }
      }

      try {
        await gitService.deleteBranch(repoPath, workspace.branch);
        console.log(`[workspace-service] deleted branch ${workspace.branch}`);
      } catch (err) {
        addRecoverableWarning(warnings, "delete-branch", err);
      }

      const now = new Date().toISOString();
      await updateWorkspaceStatus(id, "closed", {
        workingDir: null,
        closedAt: workspace.closedAt ?? now,
        mergedAt: workspace.mergedAt,
        readyForMerge: false,
      }, database);
      await moveIssueToDone(id, workspace.issueId, now, database);

      const projectId = await resolveProjectId(id, database);
      if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");
      await recordMergeAttempt(
        workspace,
        "already-merged",
        `Merge already recorded for workspace ${id} at ${workspace.mergedAt}. Reconciled cleanup and issue status.`,
        { mergedAt: workspace.mergedAt, warnings },
        now,
      );

      return {
        id,
        mergeOutput: `Workspace was already marked as merged at ${workspace.mergedAt}; reconciled without requiring branch ref.`,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    if (workspace.workingDir && !workspace.isDirect) {
      // Full teardown before merge: kill dir procs + free the worktree's dev ports +
      // run the project's generic teardownScript (with worktree context env).
      await teardownWorktree(
        {
          workingDir: workspace.workingDir,
          branch: workspace.branch,
          isDirect: workspace.isDirect,
          teardownScript: project?.teardownScript,
          setupEnabled: project?.setupEnabled,
          label: "merge",
        },
        { killDir: killProcesses },
      );
    }

    if (workspace.isDirect) {
      const now = new Date().toISOString();
      await computeWorkspaceCodeMetrics(id, database).catch(() => null);
      await updateWorkspaceStatus(id, "closed", { closedAt: now, readyForMerge: false }, database);
      await moveIssueToDone(id, workspace.issueId, now, database, true);

      const projectId = await resolveProjectId(id, database);
      if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");
      await recordMergeAttempt(
        workspace,
        "direct-closed",
        `Direct workspace ${id} was closed without a branch merge.`,
        { closedAt: now },
        now,
      );

      return { id, mergeOutput: "Direct workspace closed (no merge needed)" };
    }

    const prefMap = new Map<string, string>(
      (await database.select().from(preferences)).map((r) => [r.key, r.value]),
    );

    if (workspace.workingDir) {
      const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

      // Auto-renumber any Drizzle migration the feature branch added that collides
      // with one already on the base branch (parallel branches all pick the same
      // "next" number). This rewrites the incoming branch in place so the merge
      // below stays conflict-free. No-op when there's no migration collision.
      try {
        const renumber = await gitService.autoRenumberMigrations(workspace.workingDir, repoPath, baseBranch);
        if (renumber.renumbered) {
          console.log(
            `[workspace-merge] auto-renumbered migrations on ${workspace.branch}: ` +
              renumber.renames.map((r) => `${r.from}→${r.to}`).join(", "),
          );
        }
      } catch (err) {
        console.warn(
          "[workspace-merge] migration auto-renumber failed (continuing to conflict check):",
          err instanceof Error ? err.message : String(err),
        );
      }

      // Before conflict detection: check whether the branch tip is already an ancestor
      // of the target. If so, the branch was fully merged by a previous run that never
      // updated the DB. Treat it as a successful no-op instead of reporting 409.
      let branchSha = "";
      let baseSha = "";
      try {
        branchSha = await gitService.revParse(repoPath, workspace.branch);
        baseSha = await gitService.revParse(repoPath, baseBranch);
      } catch { /* tolerate — fall through to normal path */ }
      if (branchSha && baseSha && await gitService.isAncestor(repoPath, branchSha, baseSha)) {
        console.log(`[workspace-merge] branch ${workspace.branch} tip (${branchSha}) is already an ancestor of ${baseBranch} — treating as successful no-op merge`);
        const now = new Date().toISOString();
        await updateWorkspaceStatus(id, "closed", { workingDir: null, closedAt: now, mergedAt: now, readyForMerge: false }, database);
        await moveIssueToDone(id, workspace.issueId, now, database);
        await recordMergeAttempt(
          workspace,
          "merged",
          `Branch '${workspace.branch}' tip (${branchSha}) is already an ancestor of ${baseBranch} — reconciled as already-merged no-op.`,
          { targetBranch: baseBranch, commitSha: branchSha, mergedAt: now },
          now,
        );
        const projectId = await resolveProjectId(id, database);
        if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");
        return {
          id,
          mergeOutput: `Branch '${workspace.branch}' was already fully merged into ${baseBranch} (tip ${branchSha} is an ancestor). Reconciled as successful no-op.`,
        };
      }

      const conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
      if (conflicts.hasConflicts) {
        await recordMergeAttempt(
          workspace,
          "conflict",
          `Merge attempt blocked by conflicts in ${conflicts.conflictingFiles.length} file${conflicts.conflictingFiles.length === 1 ? "" : "s"}: ${conflicts.conflictingFiles.join(", ")}`,
          { targetBranch: baseBranch, conflictingFiles: conflicts.conflictingFiles },
        );
        throw new WorkspaceError(
          "Merge conflicts detected",
          "CONFLICT",
          { mergeReason: "conflict", conflictFiles: conflicts.conflictingFiles },
        );
      }

      const specValidation = await validateOpenSpecChange(workspace.workingDir);
      if (specValidation.deltas.length > 0) {
        const currentBranch = await gitService.getCurrentBranch(repoPath);
        if (currentBranch !== baseBranch) {
          throw new WorkspaceError(
            `Cannot apply OpenSpec deltas: main checkout HEAD is on '${currentBranch}' but this workspace targets '${baseBranch}'. ` +
              `Check out '${baseBranch}' in the main checkout before merging OpenSpec changes.`,
            "CONFLICT",
            { currentBranch, targetBranch: baseBranch },
          );
        }
        for (const warning of specValidation.warnings) {
          console.warn(`[workspace-merge] OpenSpec warning: ${warning}`);
        }
        if (workspace.baseCommitSha) {
          const domains = new Set(specValidation.deltas.map((delta) => delta.domain));
          const baseSpecChanges = await getChangedFilesBetweenSafe(repoPath, workspace.baseCommitSha, baseBranch);
          for (const domain of domains) {
            if (baseSpecChanges.includes(`openspec/specs/${domain}/spec.md`)) {
              console.warn(
                `[workspace-merge] OpenSpec warning: '${domain}' changed on ${baseBranch} since this workspace branched; review the living spec merge carefully.`,
              );
            }
          }
        }
        if (!specValidation.valid) {
          throw new WorkspaceError(
            `OpenSpec change is invalid: ${specValidation.errors.join("; ")}`,
            "BAD_REQUEST",
            { errors: specValidation.errors, warnings: specValidation.warnings },
          );
        }
      }
    }

    const targetBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

    if (!workspace.isDirect && typeof gitService.getUncommittedTrackedChanges === "function") {
      try {
        const uncommitted = await gitService.getUncommittedTrackedChanges(repoPath);
        if (uncommitted.length > 0) {
          throw new WorkspaceError(
            `Main checkout has ${uncommitted.length} uncommitted tracked change(s) — commit or stash those changes first.`,
            "CONFLICT",
            { mergeReason: "dirty_main", uncommittedFiles: uncommitted },
          );
        }
      } catch (err) {
        if (err instanceof WorkspaceError) throw err;
        console.warn("[workspace-merge] dirty-main check failed (non-fatal):", err instanceof Error ? err.message : String(err));
      }
    }

    console.log(`[workspace-service] merge: workspaceId=${id} branch=${workspace.branch} targetBranch=${targetBranch} repoPath=${repoPath}`);

    if (workspace.workingDir) {
      const synced = await gitService.syncBranchToHead(workspace.workingDir, workspace.branch);
      if (synced) {
        console.log(`[workspace-service] synced branch ${workspace.branch} to worktree HEAD`);
      }
    }

    try {
      await createBackup("pre-merge");
    } catch (err) {
      console.warn("[backup] pre-merge backup failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }

    // Capture pre-merge HEAD so we can diff afterwards to know what landed.
    let preMergeHead = "";
    try { preMergeHead = await gitService.revParse(repoPath, "HEAD"); } catch { /* tolerate */ }

    // Plumbing-based merge: working tree and index are never modified.
    let result: string;
    try {
      result = await gitService.mergeBranch(repoPath, workspace.branch, targetBranch);
    } catch (err) {
      await recordMergeAttempt(
        workspace,
        "conflict",
        `Merge failed while merging ${workspace.branch} into ${targetBranch}: ${err instanceof Error ? err.message : String(err)}`,
        { step: "git-merge", targetBranch },
      );
      throw new WorkspaceError(
        `Merge failed (git-merge step): ${err instanceof Error ? err.message : String(err)}`,
        "CONFLICT",
        { mergeReason: "conflict", step: "git-merge", branch: workspace.branch, targetBranch },
      );
    }
    let mergeCommitSha = "";
    try { mergeCommitSha = await gitService.revParse(repoPath, "HEAD"); } catch { /* tolerate */ }

    const now = new Date().toISOString();
    await updateWorkspaceStatus(id, "closed", { workingDir: null, closedAt: now, mergedAt: now, readyForMerge: false }, database);
    await moveIssueToDone(id, workspace.issueId, now, database);
    await recordMergeAttempt(
      workspace,
      "merged",
      `Merged ${workspace.branch} into ${targetBranch}${mergeCommitSha ? ` at ${mergeCommitSha}` : ""}.`,
      { targetBranch, commitSha: mergeCommitSha || null, mergedAt: now, mergeOutput: result },
      now,
    );

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");

    // Return the response immediately after the merge lands and the board is notified.
    // All post-merge work (OpenSpec, worktree cleanup, branch deletion, learning step,
    // followup auto-start) runs in the background so the HTTP connection is never
    // held open by slow filesystem or git operations.
    void runPostMergeTasks({
      workspaceId: id,
      issueId: workspace.issueId,
      repoPath,
      preMergeHead,
      prefMap,
      projectId,
      workingDir: workspace.workingDir,
      branch: workspace.branch,
      mergeResult: result,
    });

    return { id, mergeOutput: result };
  }

  async function runPostMergeTasks(args: {
    workspaceId: string;
    issueId: string;
    repoPath: string;
    preMergeHead: string;
    prefMap: Map<string, string>;
    projectId: string | null;
    workingDir: string | null | undefined;
    branch: string;
    mergeResult: string;
  }) {
    const { workspaceId, issueId, repoPath, preMergeHead, prefMap, projectId, workingDir, branch } = args;
    let mergeResult = args.mergeResult;
    const warnings: MergeWarning[] = [];

    // Code metrics — run before worktree is torn down.
    if (workingDir) {
      await computeWorkspaceCodeMetrics(workspaceId, database).catch((err) => {
        addRecoverableWarning(warnings, "code-metrics", err);
      });
    }

    // OpenSpec delta application — must run before worktree is torn down.
    try {
      const changedFiles = preMergeHead
        ? await getChangedFilesBetweenSafe(repoPath, preMergeHead, "HEAD")
        : [];
      const specChangeIds = [...new Set(changedFiles
        .map((file) => file.match(/^openspec\/changes\/([^/]+)\/specs\/[^/]+\/spec\.md$/)?.[1])
        .filter((sid): sid is string => !!sid))];
      let appliedCount = 0;
      for (const changeId of specChangeIds) {
        const specResult = await applyOpenSpecDeltas(repoPath, changeId, { removeAppliedDeltas: true });
        if (!specResult.valid) {
          throw new Error(`OpenSpec change '${changeId}' is invalid: ${specResult.errors.join("; ")}`);
        }
        appliedCount += specResult.applied.length;
        for (const warning of specResult.warnings) {
          console.warn(`[workspace-merge] OpenSpec warning: ${warning}`);
        }
      }
      if (appliedCount > 0) {
        const committed = await commitOpenSpecPaths(repoPath, branch);
        const openSpecNote = `OpenSpec: applied ${appliedCount} domain delta(s)${committed ? " and committed living specs" : ""}.`;
        mergeResult += `\n${openSpecNote}`;
        // Persist the OpenSpec note as a follow-up comment since the "merged" comment
        // was already written synchronously (before this background task ran).
        try {
          await insertIssueComment({
            issueId,
            workspaceId,
            kind: "merge-attempt",
            author: "system",
            body: openSpecNote,
            payload: { eventType: "openspec-applied", workspaceId, branch, appliedCount, committed },
            createdAt: new Date().toISOString(),
          }, database);
        } catch (dbErr) {
          console.warn("[workspace-merge] failed to record openspec note:", dbErr instanceof Error ? dbErr.message : String(dbErr));
        }
      }
    } catch (err) {
      addRecoverableWarning(warnings, "openspec-post-merge", err);
    }

    // Kill any agent-spawned processes (e.g. leaked dev.mjs) before removing the worktree.
    if (workingDir) {
      await killWorktreeProcesses(workingDir, "merge:post");
      try {
        await gitService.removeWorktree(repoPath, workingDir);
      } catch (err) {
        addRecoverableWarning(warnings, "remove-worktree", err);
        // Persist the cleanup warning so the UI can surface it for retry.
        const warningMsg = err instanceof Error ? err.message : String(err);
        try {
          await database.update(workspaces)
            .set({ cleanupWarning: warningMsg, workingDir, updatedAt: new Date().toISOString() })
            .where(eq(workspaces.id, workspaceId));
        } catch (dbErr) {
          console.warn("[workspace-merge] failed to persist cleanup warning:", dbErr instanceof Error ? dbErr.message : String(dbErr));
        }
      }
    }

    try {
      await gitService.deleteBranch(repoPath, branch);
      console.log(`[workspace-service] deleted branch ${branch}`);
    } catch (err) { addRecoverableWarning(warnings, "delete-branch", err); }

    if (warnings.length > 0) {
      try {
        const workspace = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1).then((r) => r[0]);
        if (workspace) {
          await insertIssueComment({
            issueId: workspace.issueId,
            workspaceId,
            kind: "merge-attempt",
            author: "system",
            body: `Merge completed, but ${warnings.length} post-merge cleanup step${warnings.length === 1 ? "" : "s"} reported a recoverable warning. The branch was already merged before this response returned.`,
            payload: { eventType: "warning", workspaceId, branch, warnings },
            createdAt: new Date().toISOString(),
          }, database);
        }
      } catch (err) {
        console.warn("[workspace-merge] failed to record post-merge cleanup warnings:", err instanceof Error ? err.message : String(err));
      }
    }

    try {
      if (preMergeHead) {
        const changedFiles = await gitService.getChangedFilesBetween(repoPath, preMergeHead, "HEAD");
        const commits = typeof gitService.getCommitSummariesBetween === "function"
          ? await gitService.getCommitSummariesBetween(repoPath, preMergeHead, "HEAD")
          : [];
        await generateAndPersistGithubHandoffDraft({
          workspaceId,
          issueId,
          database,
          repoPath,
          fromRef: preMergeHead,
          toRef: "HEAD",
          changedFiles,
          commits,
          gitService,
        });
        await rebuildSharedIfChanged(repoPath, changedFiles);
      }
    } catch (err) {
      console.warn("[workspace-merge] post-merge draft/rebuild failed:", err);
    }

    try {
      if (getSessionManager) {
        await runLearningStep(workspaceId, prefMap, database, getSessionManager);
      }
    } catch (err) {
      console.warn("[workspace-merge] post-merge learning step failed:", err);
    }

    try {
      if (prefMap.get(PREF_AUTO_START_FOLLOWUP) === "true" && projectId && getSessionManager) {
        await autoStartFollowups(issueId, projectId, database, getSessionManager, prefMap, { boardEvents });
      }
    } catch (err) {
      console.warn("[workspace-merge] auto_start_followup check failed:", err);
    }

    try {
      await autoStartUnblockedDependencyIssue({
        database,
        projectId,
        completedIssueId: issueId,
        prefMap,
        getSessionManager,
        boardEvents,
        gitService,
      });
    } catch (err) {
      console.warn("[workspace-merge] dependency auto-chain check failed:", err);
    }
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
      result = await gitService.rebaseOntoBase(workspace.workingDir, baseBranch, workspace.branch);
    }

    // And again after — rebase/merge can spawn helpers (hook scripts, editors) that linger.
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
    if (workspace.status === "fixing") throw new WorkspaceError("Conflict resolution already in progress", "CONFLICT");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    // Kill leftover worktree processes before spawning the resolution agent.
    await killWorktreeProcesses(workspace.workingDir, "resolve-conflicts");

    const conflictingFiles = await getConflictingFiles(workspace.workingDir);
    const { defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
    const prompt = buildConflictResolutionPrompt(conflictingFiles, baseBranch);

    const { agentCommand, agentArgs, claudeProfile, profile, provider } =
      applyWorkspaceAgentSelection(await loadAgentSettings(database), workspace);
    const executorProvider = toExecutorProvider(provider);

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt, agentCommand, agentArgs, claudeProfile, profile,
      provider: executorProvider, multiTurn: executorProvider === "codex" ? false : true, triggerType: "fix-conflicts",
    });

    await updateWorkspaceStatus(id, "fixing", {}, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_launched");

    return { sessionId };
  }

  async function fixAndMerge(id: string, mergeError?: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) throw new WorkspaceError("Workspace not set up", "BAD_REQUEST");
    if (workspace.status === "fixing") throw new WorkspaceError("Fix already in progress", "CONFLICT");
    if (!getSessionManager) throw new WorkspaceError("Session manager not available", "BAD_REQUEST");

    const errorMessage = mergeError || "Unknown merge error";
    const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

    // Refuse if main checkout HEAD has drifted off the target branch (consistent with /merge guard).
    const currentHeadBranch = await gitService.getCurrentBranch(repoPath);
    if (currentHeadBranch !== baseBranch) {
      throw new WorkspaceError(
        `Cannot fix-and-merge: main checkout HEAD is on '${currentHeadBranch}' but this workspace targets '${baseBranch}'. ` +
          `Check out '${baseBranch}' in the main checkout before proceeding.`,
        "CONFLICT",
        { currentBranch: currentHeadBranch, targetBranch: baseBranch },
      );
    }

    // Kill leftover worktree processes (e.g. dev.mjs from the prior agent) before rewriting or spawning.
    await killWorktreeProcesses(workspace.workingDir, "fix-and-merge");

    let rebuildNote = "";
    try {
      const synced = await gitService.syncBranchToHead(workspace.workingDir, workspace.branch);
      if (synced) {
        console.log(`[workspace-merge] fix-and-merge synced branch ${workspace.branch} to worktree HEAD`);
      }
      const rebaseResult = await gitService.rebaseOntoBase(workspace.workingDir, baseBranch, workspace.branch, {
        preferLocalBase: true,
      });
      if (rebaseResult.success) {
        rebuildNote = `Before launching this fix-and-merge agent, the app rebased the workspace branch onto '${baseBranch}' successfully.`;
        await computeWorkspaceCodeMetrics(id, database).catch(() => null);
      } else {
        const conflictingFiles = rebaseResult.conflictingFiles ?? [];
        rebuildNote =
          `Before launching this fix-and-merge agent, the app tried to rebase the workspace branch onto '${baseBranch}' ` +
          `and left the rebase in progress for you to resolve.` +
          (conflictingFiles.length > 0 ? ` Conflicting files: ${conflictingFiles.join(", ")}.` : "") +
          (rebaseResult.error ? ` Rebase error: ${rebaseResult.error}` : "");
      }
    } catch (err) {
      rebuildNote =
        `Before launching this fix-and-merge agent, the app tried to rebuild the workspace branch on '${baseBranch}' ` +
        `but the rebuild preflight failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    const prompt = buildFixAndMergePrompt(`${errorMessage}\n\n${rebuildNote}`, baseBranch);

    const { agentCommand, agentArgs, claudeProfile, profile, provider } =
      applyWorkspaceAgentSelection(await loadAgentSettings(database), workspace);
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

    const projectId = await resolveProjectId(id, database);
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
    const { issues: issuesTable } = await import("@agentic-kanban/shared/schema");
    const issueRows = await database
      .select({ issueNumber: issuesTable.issueNumber })
      .from(issuesTable)
      .where(eq(issuesTable.id, workspace.issueId))
      .limit(1);
    const issueNumber = issueRows[0]?.issueNumber ?? null;

    // Check working-dir exists for accurate diff
    let diffOutput = "";
    let diffFromWorktree = false;
    if (workspace.workingDir) {
      try {
        diffOutput = await gitService.getDiff(workspace.workingDir, baseBranch);
        diffFromWorktree = true;
      } catch {
        // worktree gone — fall through to repo-level diff
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

    // Resolve branch HEAD to verify reachability
    let branchSha: string;
    try {
      branchSha = await gitService.revParse(repoPath, workspace.branch);
    } catch {
      // Branch ref doesn't exist in the main repo — check worktree
      if (workspace.workingDir) {
        try {
          branchSha = await gitService.revParse(workspace.workingDir, "HEAD");
        } catch {
          return {
            isAlreadyMerged: false,
            branch: workspace.branch,
            baseBranch,
            mergeCommitSha: null,
            issueNumber,
            reason: "Could not resolve branch HEAD",
          };
        }
      } else {
        return {
          isAlreadyMerged: false,
          branch: workspace.branch,
          baseBranch,
          mergeCommitSha: null,
          issueNumber,
          reason: "Branch ref not found and no worktree available",
        };
      }
    }

    const reachable = await gitService.isAncestor(repoPath, branchSha, baseBranch);
    if (!reachable) {
      return {
        isAlreadyMerged: false,
        branch: workspace.branch,
        baseBranch,
        mergeCommitSha: null,
        issueNumber,
        reason: "Branch commit is not reachable from " + baseBranch,
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

    await updateWorkspaceStatus(id, "closed", {
      closedAt: workspace.closedAt ?? now,
      mergedAt: workspace.mergedAt ?? now,
      readyForMerge: false,
      workingDir: null,
    }, database);
    await moveIssueToDone(id, workspace.issueId, now, database);

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

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");

    return {
      id,
      branch: check.branch,
      baseBranch: check.baseBranch,
      mergeCommitSha: check.mergeCommitSha,
      issueNumber: check.issueNumber,
      reconciledAt: now,
    };
  }

  return { mergeWorkspace, updateBase, abortRebase, resolveConflicts, fixAndMerge, checkAlreadyMerged, reconcileAlreadyMerged };
}
