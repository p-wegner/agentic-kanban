import type { Database } from "../db/index.js";
import type { BoardEventSink } from "./board-events.js";
import { getWorkspaceById, resolveProjectId } from "../repositories/workspace.repository.js";
import { getProjectForWorkspaceCreate, updateLatestSetupRunFields } from "../repositories/workspace-crud.repository.js";
import { runSetupScript } from "./setup-script.js";
import { buildSetupRunFromError, buildSetupRunFromResult, type LatestSetupRun } from "./workspace-run-records.js";
import { WorkspaceError } from "./workspace-internals.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * #1166 — a failed `workspace_setup_run` has no retry door when `setup_blocking = 0`.
 *
 * `POST /:id/setup` (`setupWorkspace`) only RECREATES a missing worktree; when `workingDir` is
 * already set (the normal case — the worktree exists, its install just failed) it returns early
 * and never touches the setup script. `born-blocked-reconciler.ts` retries a failed setup, but
 * only for a workspace born `blocked`, which itself requires `setup_blocking = 1`. A project with
 * `setup_blocking = 0` (background installs — today only `agentic-kanban` itself) therefore has
 * no path back from a failed install: the pre-merge gate (`pre-merge-gate-setup-failure.ts`)
 * refuses the branch forever, and hand-installing dependencies in the worktree does not help,
 * because the gate reads the STORED verdict, not the directory.
 *
 * This re-runs the project's setup script in the workspace's existing worktree and restamps the
 * verdict via `updateLatestSetupRunFields` — the same write the initial creation path uses — so a
 * transient failure (a network blip mid-install) gets an honest, dated retry instead of being
 * stuck on a stale row forever.
 */
export function createWorkspaceSetupRetryService(deps: {
  database: Database;
  boardEvents?: BoardEventSink;
}) {
  const { database, boardEvents } = deps;

  async function retrySetup(workspaceId: string): Promise<{ id: string; latestSetup: LatestSetupRun }> {
    const workspace = await getWorkspaceById(workspaceId, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (!workspace.workingDir) {
      throw new WorkspaceError(
        "Workspace has no worktree to run setup in yet — use POST /:id/setup to create it first.",
        "BAD_REQUEST",
      );
    }

    const projectId = await resolveProjectId(workspaceId, database);
    if (!projectId) throw new WorkspaceError("Workspace has no project", "NOT_FOUND");

    const projectRows = await getProjectForWorkspaceCreate(projectId, database);
    if (projectRows.length === 0) throw new WorkspaceError("Project not found", "NOT_FOUND");
    const setupScript = projectRows[0].setupScript;
    if (!setupScript) {
      throw new WorkspaceError("Project has no setup script configured — nothing to retry.", "BAD_REQUEST");
    }

    const startedAt = new Date().toISOString();
    console.log(`[workspace-setup-retry] retrying setup for workspaceId=${workspaceId} projectId=${projectId}`);
    let latestSetup: LatestSetupRun;
    try {
      const result = await runSetupScript(workspace.workingDir, setupScript);
      latestSetup = buildSetupRunFromResult(setupScript, startedAt, result);
      if (result.exitCode === 0) {
        console.log(`[workspace-setup-retry] setup succeeded on retry for workspaceId=${workspaceId}`);
      } else {
        console.warn(`[workspace-setup-retry] setup failed again (exit ${result.exitCode}) for workspaceId=${workspaceId}: ${result.stderr || result.stdout}`);
      }
    } catch (err) {
      latestSetup = buildSetupRunFromError(setupScript, startedAt, err);
      console.warn(`[workspace-setup-retry] setup error for workspaceId=${workspaceId}: ${errorMessage(err)}`);
    }

    await updateLatestSetupRunFields(workspaceId, {
      command: latestSetup.command,
      state: latestSetup.state,
      startedAt: latestSetup.startedAt,
      endedAt: latestSetup.endedAt,
      exitCode: latestSetup.exitCode,
      durationMs: latestSetup.durationMs,
      stdoutTail: latestSetup.stdoutTail,
      stderrTail: latestSetup.stderrTail,
    }, database);

    boardEvents?.broadcast(projectId, "workspace_setup");

    return { id: workspaceId, latestSetup };
  }

  return { retrySetup };
}
