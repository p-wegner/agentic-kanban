import { Hono } from "hono";
import * as gitService from "../../services/git.service.js";
import type { SessionManager } from "../../services/session.manager.js";
import type { Database } from "../../db/index.js";
import type { BoardEvents } from "../../services/board-events.js";
import { resolveProjectRepo, resolveProjectId, getWorkspaceById, updateWorkspaceStatus } from "../../repositories/workspace.repository.js";
import { loadAgentSettings, toExecutorProvider } from "../../services/agent-settings.service.js";
import { getConflictingFiles, buildConflictResolutionPrompt, buildFixAndMergePrompt } from "../../services/merge-helpers.service.js";
import { applyWorkspaceAgentSelection, requireBaseBranch } from "./helpers.js";

export function createConflictRoutes(
  getSessionManager: () => SessionManager,
  database: Database,
  options?: { boardEvents?: BoardEvents; fixAndMergeSessionIds?: Set<string> },
) {
  const router = new Hono();

  // GET /api/workspaces/:id/conflicts — on-demand conflict detection
  router.get("/:id/conflicts", async (c) => {
    const id = c.req.param("id");
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir || workspace.isDirect) {
      return c.json({ hasConflicts: false, conflictingFiles: [] });
    }
    try {
      const { defaultBranch } = await resolveProjectRepo(id, database);
      const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
      const result = await gitService.detectConflicts(workspace.workingDir, baseBranch);
      return c.json(result);
    } catch (err) {
      return c.json({ error: `Conflict detection failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/update-base — rebase or merge base branch into workspace
  router.post("/:id/update-base", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const mode = body.mode === "merge" ? "merge" : "rebase";

    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir || workspace.isDirect) {
      return c.json({ error: "Not supported for direct workspaces" }, 400);
    }
    if (workspace.status === "closed") {
      return c.json({ error: "Workspace is closed" }, 400);
    }

    try {
      const { defaultBranch } = await resolveProjectRepo(id, database);
      const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

      let result: { success: boolean; conflictingFiles?: string[]; error?: string };
      if (mode === "merge") {
        result = await gitService.mergeBaseIntoBranch(workspace.workingDir, baseBranch);
      } else {
        result = await gitService.rebaseOntoBase(workspace.workingDir, baseBranch, workspace.branch);
      }

      console.log(`[workspace-actions] update-base: workspaceId=${id} mode=${mode} success=${result.success} conflicts=${result.conflictingFiles?.length ?? 0}`);

      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "board_changed");

      return c.json(result);
    } catch (err) {
      return c.json({ error: `Update base failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/abort-rebase — abort in-progress rebase
  router.post("/:id/abort-rebase", async (c) => {
    const id = c.req.param("id");
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir) {
      return c.json({ error: "Workspace not set up" }, 400);
    }

    try {
      await gitService.abortRebase(workspace.workingDir);
      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "board_changed");
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: `Abort rebase failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/resolve-conflicts — launch AI agent to resolve conflicts
  router.post("/:id/resolve-conflicts", async (c) => {
    const id = c.req.param("id");
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir) {
      return c.json({ error: "Workspace not set up" }, 400);
    }
    if (workspace.status === "fixing") {
      return c.json({ error: "Conflict resolution already in progress" }, 409);
    }

    try {
      const conflictingFiles = await getConflictingFiles(workspace.workingDir);

      const { defaultBranch } = await resolveProjectRepo(id, database);
      const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

      const prompt = buildConflictResolutionPrompt(conflictingFiles, baseBranch);

      const { agentCommand, agentArgs, claudeProfile, profile, provider } =
        applyWorkspaceAgentSelection(await loadAgentSettings(database), workspace);

      const sessionId = await getSessionManager().startSession({ workspaceId: id, prompt, agentCommand, agentArgs, claudeProfile, profile, provider: toExecutorProvider(provider), multiTurn: true, triggerType: "fix-conflicts" });
      options?.fixAndMergeSessionIds?.add(sessionId);

      await updateWorkspaceStatus(id, "fixing", {}, database);

      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "session_launched");

      return c.json({ sessionId });
    } catch (err) {
      return c.json({ error: `Resolve conflicts failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  // POST /api/workspaces/:id/fix-and-merge — launch AI agent to fix merge error and retry
  router.post("/:id/fix-and-merge", async (c) => {
    const id = c.req.param("id");
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    if (!workspace.workingDir) {
      return c.json({ error: "Workspace not set up" }, 400);
    }
    if (workspace.status === "fixing") {
      return c.json({ error: "Fix already in progress" }, 409);
    }

    try {
      const body: { mergeError?: string } = await c.req.json<{ mergeError?: string }>().catch(() => ({}));
      const errorMessage = body.mergeError || "Unknown merge error";

      const { defaultBranch } = await resolveProjectRepo(id, database);
      const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);

      const prompt = buildFixAndMergePrompt(errorMessage, baseBranch);

      const { agentCommand, agentArgs, claudeProfile, profile, provider } =
        applyWorkspaceAgentSelection(await loadAgentSettings(database), workspace);

      const sessionId = await getSessionManager().startSession({
        workspaceId: id,
        prompt,
        agentCommand,
        agentArgs,
        claudeProfile,
        profile,
        provider: toExecutorProvider(provider),
        multiTurn: true,
        triggerType: "fix-and-merge",
      });
      options?.fixAndMergeSessionIds?.add(sessionId);

      await updateWorkspaceStatus(id, "fixing", {}, database);

      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "session_launched");

      return c.json({ sessionId });
    } catch (err) {
      return c.json({ error: `Fix-and-merge failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
  });

  return router;
}
