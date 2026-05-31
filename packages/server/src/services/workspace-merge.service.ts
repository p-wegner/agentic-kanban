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
import {
  getConflictingFiles,
  buildConflictResolutionPrompt,
  buildFixAndMergePrompt,
  runLearningStep,
  rebuildSharedIfChanged,
} from "./merge-helpers.service.js";
import { PREF_AUTO_START_FOLLOWUP } from "../constants/preference-keys.js";
import { autoStartFollowups } from "./followup-workspace.service.js";
import { loadAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import { computeWorkspaceCodeMetrics } from "./workspace-code-metrics.service.js";
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
    if (workspace.workingDir && !workspace.isDirect) {
      await killWorktreeProcesses(workspace.workingDir, "merge:pre");
      if (project?.teardownScript && project.setupEnabled !== false) {
        try {
          const r = await runScript(project.teardownScript, workspace.workingDir, `teardown:${id}`);
          console.log(`[workspace-service] teardown script: ${r.ok ? "ok" : "failed"} — ${r.output.slice(0, 100)}`);
        } catch { /* ignore */ }
      }
    }

    if (workspace.isDirect) {
      const now = new Date().toISOString();
      await computeWorkspaceCodeMetrics(id, database).catch(() => null);
      await updateWorkspaceStatus(id, "closed", { closedAt: now }, database);
      await moveIssueToDone(id, workspace.issueId, now, database, true);

      const projectId = await resolveProjectId(id, database);
      if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");

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

      const conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
      if (conflicts.hasConflicts) {
        throw new WorkspaceError(
          "Merge conflicts detected",
          "BAD_REQUEST",
          { conflictingFiles: conflicts.conflictingFiles },
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
    let result = await gitService.mergeBranch(repoPath, workspace.branch, targetBranch);

    try {
      const changedFiles = preMergeHead
        ? await getChangedFilesBetweenSafe(repoPath, preMergeHead, "HEAD")
        : [];
      const specChangeIds = [...new Set(changedFiles
        .map((file) => file.match(/^openspec\/changes\/([^/]+)\/specs\/[^/]+\/spec\.md$/)?.[1])
        .filter((id): id is string => !!id))];
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
        const committed = await commitOpenSpecPaths(repoPath, workspace.branch);
        result += `\nOpenSpec: applied ${appliedCount} domain delta(s)${committed ? " and committed living specs" : ""}.`;
      }
    } catch (err) {
      console.warn("[workspace-merge] OpenSpec delta application failed:", err instanceof Error ? err.message : String(err));
      throw err;
    }

    if (workspace.workingDir) {
      await computeWorkspaceCodeMetrics(id, database).catch(() => null);
    }

    // Kill any agent-spawned processes (e.g. leaked dev.mjs) before removing the worktree.
    if (workspace.workingDir) {
      await killWorktreeProcesses(workspace.workingDir, "merge:post");
      try { await gitService.removeWorktree(repoPath, workspace.workingDir); } catch { /* best effort */ }
    }

    try {
      await gitService.deleteBranch(repoPath, workspace.branch);
      console.log(`[workspace-service] deleted branch ${workspace.branch}`);
    } catch { /* ignore */ }

    const now = new Date().toISOString();
    await updateWorkspaceStatus(id, "closed", { workingDir: null, closedAt: now, mergedAt: now }, database);
    await moveIssueToDone(id, workspace.issueId, now, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");

    // Post-merge tasks that don't affect the merge result — run in background so /merge returns promptly.
    void runPostMergeTasks({
      workspaceId: id,
      issueId: workspace.issueId,
      repoPath,
      preMergeHead,
      prefMap,
      projectId,
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
  }) {
    const { workspaceId, issueId, repoPath, preMergeHead, prefMap, projectId } = args;
    try {
      if (preMergeHead) {
        const changedFiles = await gitService.getChangedFilesBetween(repoPath, preMergeHead, "HEAD");
        await rebuildSharedIfChanged(repoPath, changedFiles);
      }
    } catch (err) {
      console.warn("[workspace-merge] post-merge shared rebuild failed:", err);
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

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt, agentCommand, agentArgs, claudeProfile, profile,
      provider: toExecutorProvider(provider), multiTurn: true, triggerType: "fix-conflicts",
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
      const rebaseResult = await gitService.rebaseOntoBase(workspace.workingDir, baseBranch, workspace.branch);
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

    const sessionId = await getSessionManager().startSession({
      workspaceId: id, prompt, agentCommand, agentArgs, claudeProfile, profile,
      provider: toExecutorProvider(provider), multiTurn: true, triggerType: "fix-and-merge",
    });

    await updateWorkspaceStatus(id, "fixing", {}, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "session_launched");

    return { sessionId };
  }

  return { mergeWorkspace, updateBase, abortRebase, resolveConflicts, fixAndMerge };
}
