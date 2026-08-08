import type { workspaces } from "@agentic-kanban/shared/schema";
import { isFailedLaunchSession } from "@agentic-kanban/shared/lib/workspace-activity-state.js";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import {
  countSessionMessages,
  getLatestSessionForWorkspace,
  getLatestSessionStatusForWorkspace,
  markSessionStopped,
} from "../repositories/workspace-merge.repository.js";
import { updateWorkspaceStatus } from "../repositories/workspace.repository.js";

/**
 * Pre-merge recovery of STRANDED fix-and-merge sessions.
 *
 * Extracted from `workspace-merge.service.ts` (which crossed the 1000-line god-module ceiling):
 * these three functions form one concern — "before merging, un-wedge a workspace whose previous
 * fix-and-merge attempt died in a way that left the row claiming work is in flight". They share
 * no state with the merge pipeline itself beyond the session manager and the database, so they
 * take both explicitly rather than closing over the service factory's locals.
 */

export interface FixAndMergeRecoveryDeps {
  database: Database;
  getSessionManager?: () => SessionManager;
  /** Only `abortRebase`/`ensureOnBranch` are used — narrowed so the module needs no GitService type. */
  gitService: {
    abortRebase: (workingDir: string) => Promise<unknown>;
    ensureOnBranch: (workingDir: string, branch: string) => Promise<unknown>;
  };
}

type Workspace = typeof workspaces.$inferSelect;

export async function forceStopSession(
  sessionId: string,
  label: string,
  deps: FixAndMergeRecoveryDeps,
): Promise<void> {
  try {
    await deps.getSessionManager?.().stopSession(sessionId);
  } catch (err) {
    console.warn(`[workspace-merge] failed to force-stop ${label} ${sessionId}:`, err instanceof Error ? err.message : String(err));
  }
  await markSessionStopped(sessionId, new Date().toISOString(), deps.database);
}

/** A `fixing` workspace whose latest session failed to launch is reset to `idle` so a merge can retry. */
export async function recoverFailedFixAndMergeSessionIfNeeded(
  workspace: Workspace,
  deps: FixAndMergeRecoveryDeps,
): Promise<void> {
  if (workspace.status !== "fixing") return;
  if (!deps.getSessionManager) return;

  const latestSession = await getLatestSessionForWorkspace(workspace.id, deps.database);
  if (!latestSession) return;

  const isFailed = isFailedLaunchSession({
    status: latestSession.status,
    startedAt: latestSession.startedAt,
    endedAt: latestSession.endedAt,
    stats: latestSession.stats,
  });
  if (!isFailed) return;

  await forceStopSession(latestSession.id, "stale session", deps);
  await updateWorkspaceStatus(workspace.id, "idle", {}, deps.database);
}

/**
 * A fix-and-merge session that has been `running` for over a minute with ZERO messages never
 * really started. Stop it, un-wedge the worktree (a stranded attempt can leave it detached
 * mid-rebase, which re-strands the retry), and return the row to `idle`.
 */
export async function recoverZeroOutputRunningFixAndMergeSession(
  workspace: Workspace,
  deps: FixAndMergeRecoveryDeps,
): Promise<void> {
  if (!deps.getSessionManager) return;
  const latestSession = await getLatestSessionStatusForWorkspace(workspace.id, deps.database);
  if (!latestSession) return;
  if (latestSession.triggerType !== "fix-and-merge") return;
  const ageMs = Date.now() - new Date(latestSession.startedAt).getTime();
  if (ageMs < 60_000) return;
  if (latestSession.status !== "running") return;

  const msgCount = await countSessionMessages(latestSession.id, deps.database);
  if (msgCount !== 0) return;

  try {
    console.log(
      `[workspace-merge] stopping stale zero-output fix-and-merge session ${latestSession.id} for workspace ${workspace.id} ` +
        `after ${Math.round(ageMs / 1000)}s with no messages`,
    );
    await forceStopSession(latestSession.id, "stale zero-output session", deps);
  } catch (err) {
    console.warn(
      `[workspace-merge] failed to force-stop stale zero-output session ${latestSession.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  if (workspace.workingDir && !workspace.isDirect && workspace.branch) {
    await deps.gitService.abortRebase(workspace.workingDir).catch(() => { /* nothing to abort */ });
    await deps.gitService.ensureOnBranch(workspace.workingDir, workspace.branch).catch(() => { /* best effort */ });
  }
  await updateWorkspaceStatus(workspace.id, "idle", {}, deps.database);
}
