import { preferences, projects, workspaces } from "@agentic-kanban/shared/schema";
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
} from "./merge-helpers.service.js";
import { PREF_AUTO_START_FOLLOWUP } from "../constants/preference-keys.js";
import { autoStartFollowups } from "./followup-workspace.service.js";
import { loadAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import {
  WorkspaceError,
  applyWorkspaceAgentSelection,
  requireBaseBranch,
  activeMerges,
  type GitService,
} from "./workspace-internals.js";

export function createWorkspaceMergeService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  gitService?: GitService;
  createBackup?: (reason: string) => Promise<unknown>;
}) {
  const { database, getSessionManager, boardEvents } = deps;
  const gitService = deps.gitService ?? realGitService;
  const createBackup = deps.createBackup ?? realCreateBackup;

  async function mergeWorkspace(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");

    const { project, repoPath, defaultBranch } = await resolveProjectFull(id, database);

    if (activeMerges.has(repoPath)) {
      throw new WorkspaceError(
        "A merge is already in progress for this repository. Please wait for it to complete.",
        "CONFLICT",
      );
    }

    const mergePromise = doMerge(id, workspace, project, repoPath, defaultBranch);
    activeMerges.set(repoPath, mergePromise);
    try {
      return await mergePromise;
    } finally {
      activeMerges.delete(repoPath);
    }
  }

  async function doMerge(
    id: string,
    workspace: typeof workspaces.$inferSelect,
    project: typeof projects.$inferSelect | null,
    repoPath: string,
    defaultBranch: string | null,
  ) {
    if (workspace.workingDir && !workspace.isDirect) {
      try {
        const killed = await killProcessesInDir(workspace.workingDir);
        if (killed > 0) console.log(`[workspace-service] killed ${killed} process(es) in ${workspace.workingDir}`);
      } catch { /* ignore */ }
      if (project?.teardownScript && project.setupEnabled !== false) {
        try {
          const r = await runScript(project.teardownScript, workspace.workingDir, `teardown:${id}`);
          console.log(`[workspace-service] teardown script: ${r.ok ? "ok" : "failed"} — ${r.output.slice(0, 100)}`);
        } catch { /* ignore */ }
      }
    }

    if (workspace.isDirect) {
      const now = new Date().toISOString();
      await updateWorkspaceStatus(id, "closed", { closedAt: now }, database);
      await moveIssueToDone(id, workspace.issueId, now, database, true);

      const projectId = await resolveProjectId(id, database);
      if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");

      return { id, mergeOutput: "Direct workspace closed (no merge needed)" };
    }

    const prefRows = await database.select().from(preferences);
    const prefMap = new Map(prefRows.map(r => [r.key, r.value]));

    if (workspace.workingDir && getSessionManager) {
      await runLearningStep(id, prefMap, database, getSessionManager!);
    }

    if (workspace.workingDir) {
      const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
      const conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
      if (conflicts.hasConflicts) {
        throw new WorkspaceError(
          "Merge conflicts detected",
          "BAD_REQUEST",
          { conflictingFiles: conflicts.conflictingFiles },
        );
      }
    }

    const uncommittedInMain = await gitService.getUncommittedTrackedChanges(repoPath);
    if (uncommittedInMain.length > 0) {
      const preview = uncommittedInMain.slice(0, 10).join("\n");
      const suffix = uncommittedInMain.length > 10 ? `\n…and ${uncommittedInMain.length - 10} more` : "";
      throw new WorkspaceError(
        `Cannot merge: the main checkout has ${uncommittedInMain.length} uncommitted tracked change(s). ` +
          `Commit or stash these before merging:\n${preview}${suffix}`,
        "CONFLICT",
        { uncommittedFiles: uncommittedInMain },
      );
    }

    console.log(`[workspace-service] merge: workspaceId=${id} branch=${workspace.branch} repoPath=${repoPath}`);

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

    const result = await gitService.mergeBranch(repoPath, workspace.branch);

    if (workspace.workingDir) {
      try { await gitService.removeWorktree(repoPath, workspace.workingDir); } catch { /* best effort */ }
    }

    try {
      await gitService.deleteBranch(repoPath, workspace.branch);
      console.log(`[workspace-service] deleted branch ${workspace.branch}`);
    } catch { /* ignore */ }

    const now = new Date().toISOString();
    await updateWorkspaceStatus(id, "closed", { workingDir: null, closedAt: now }, database);
    await moveIssueToDone(id, workspace.issueId, now, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "workspace_merged");

    try {
      if (prefMap.get(PREF_AUTO_START_FOLLOWUP) === "true" && projectId) {
        await autoStartFollowups(workspace.issueId, projectId, database, getSessionManager!, prefMap, { boardEvents });
      }
    } catch (err) {
      console.warn("[workspace-service] auto_start_followup check failed:", err);
    }

    return { id, mergeOutput: result };
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

    const { defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

    let result: { success: boolean; conflictingFiles?: string[]; error?: string };
    if (mode === "merge") {
      result = await gitService.mergeBaseIntoBranch(workspace.workingDir, baseBranch);
    } else {
      result = await gitService.rebaseOntoBase(workspace.workingDir, baseBranch, workspace.branch);
    }

    console.log(`[workspace-service] update-base: workspaceId=${id} mode=${mode} success=${result.success} conflicts=${result.conflictingFiles?.length ?? 0}`);

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
    const { defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
    const prompt = buildFixAndMergePrompt(errorMessage, baseBranch);

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
