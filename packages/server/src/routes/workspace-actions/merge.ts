import { Hono } from "hono";
import { workspaces, preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import * as gitService from "../../services/git.service.js";
import { killProcessesInDir } from "../../services/process-cleanup.js";
import { runScript } from "../../services/script-runner.js";
import type { SessionManager } from "../../services/session.manager.js";
import type { Database } from "../../db/index.js";
import type { BoardEvents } from "../../services/board-events.js";
import { resolveProjectFull, resolveProjectId, moveIssueToDone, getWorkspaceById, updateWorkspaceStatus } from "../../repositories/workspace.repository.js";
import { PREF_AUTO_START_FOLLOWUP } from "../../constants/preference-keys.js";
import { autoStartFollowups } from "../../services/followup-workspace.service.js";
import { runLearningStep } from "../../services/merge-helpers.service.js";
import { requireBaseBranch } from "./helpers.js";

export function createMergeRoutes(
  getSessionManager: () => SessionManager,
  database: Database,
  options?: { boardEvents?: BoardEvents },
) {
  const router = new Hono();

  // POST /api/workspaces/:id/merge — merge branch, cleanup, close
  router.post("/:id/merge", async (c) => {
    const id = c.req.param("id");

    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);

    try {
      const { project, repoPath, defaultBranch } = await resolveProjectFull(id, database);

      if (workspace.workingDir && !workspace.isDirect) {
        try {
          const killed = await killProcessesInDir(workspace.workingDir);
          if (killed > 0) console.log(`[workspace-actions] killed ${killed} process(es) in ${workspace.workingDir}`);
        } catch { /* ignore */ }
        if (project?.teardownScript && project.setupEnabled !== false) {
          try {
            const r = await runScript(project.teardownScript, workspace.workingDir, `teardown:${id}`);
            console.log(`[workspace-actions] teardown script: ${r.ok ? "ok" : "failed"} — ${r.output.slice(0, 100)}`);
          } catch { /* ignore */ }
        }
      }

      if (workspace.isDirect) {
        const now = new Date().toISOString();
        await updateWorkspaceStatus(id, "closed", { closedAt: now }, database);

        await moveIssueToDone(id, workspace.issueId, now, database, true);

        const projectId = await resolveProjectId(id, database);
        if (projectId) options?.boardEvents?.broadcast(projectId, "workspace_merged");

        return c.json({ id, mergeOutput: "Direct workspace closed (no merge needed)" });
      }

      const prefRows = await database.select().from(preferences);
      const prefMap = new Map(prefRows.map(r => [r.key, r.value]));

      if (workspace.workingDir && getSessionManager) {
        await runLearningStep(id, prefMap, database, getSessionManager);
      }

      if (workspace.workingDir) {
        const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
        const conflicts = await gitService.detectConflicts(workspace.workingDir, baseBranch);
        if (conflicts.hasConflicts) {
          return c.json({ error: "Merge conflicts detected", conflictingFiles: conflicts.conflictingFiles }, 409);
        }
      }

      console.log(`[workspace-actions] merge: workspaceId=${id} branch=${workspace.branch} repoPath=${repoPath}`);

      if (workspace.workingDir) {
        const synced = await gitService.syncBranchToHead(workspace.workingDir, workspace.branch);
        if (synced) {
          console.log(`[workspace-actions] merge: synced branch ${workspace.branch} to worktree HEAD (was detached or ahead)`);
        }
      }

      const result = await gitService.mergeBranch(repoPath, workspace.branch);

      if (workspace.workingDir) {
        try {
          await gitService.removeWorktree(repoPath, workspace.workingDir);
        } catch {
          // Best effort
        }
      }

      try {
        await gitService.deleteBranch(repoPath, workspace.branch);
        console.log(`[workspace-actions] deleted branch ${workspace.branch}`);
      } catch {
        // Branch may not exist
      }

      const now = new Date().toISOString();
      await updateWorkspaceStatus(id, "closed", { workingDir: null, closedAt: now }, database);

      await moveIssueToDone(id, workspace.issueId, now, database);

      const projectId = await resolveProjectId(id, database);
      if (projectId) options?.boardEvents?.broadcast(projectId, "workspace_merged");

      try {
        if (prefMap.get(PREF_AUTO_START_FOLLOWUP) === "true" && projectId) {
          await autoStartFollowups(workspace.issueId, projectId, database, getSessionManager, prefMap, options);
        }
      } catch (err) {
        console.warn("[workspace-actions] auto_start_followup check failed:", err);
      }

      return c.json({ id, mergeOutput: result });
    } catch (err) {
      return c.json(
        { error: `Merge failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
  });

  return router;
}
