import { issues, projectStatuses, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";

export interface FinalizeMergeCleanupInput {
  database: Database;
  boardEvents?: BoardEvents;
  workspaceId: string;
  issueId: string;
  now?: string;
  projectId?: string | null;
  closedAt?: string | null;
  mergedAt?: string | null;
  workingDir?: string | null;
  markMerged?: boolean;
  fallbackToAiReviewed?: boolean;
}

export interface FinalizeMergeCleanupResult {
  projectId: string | null;
  closedAt: string;
  mergedAt: string | null;
  workspaceUpdated: boolean;
  issueTransitioned: boolean;
  sessionsStopped: boolean;
  broadcasted: boolean;
}

/**
 * Finalize the DB-visible merge state before slower post-merge cleanup runs.
 * Existing closedAt/mergedAt values win so retries do not rewrite merge history
 * or repeatedly invalidate board caches.
 */
export async function finalizeMergeCleanup(
  input: FinalizeMergeCleanupInput,
): Promise<FinalizeMergeCleanupResult> {
  const now = input.now ?? new Date().toISOString();
  const shouldMarkMerged = input.markMerged ?? true;

  const [workspace] = await input.database
    .select({
      status: workspaces.status,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
      readyForMerge: workspaces.readyForMerge,
      workingDir: workspaces.workingDir,
    })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);

  if (!workspace) {
    throw new Error(`Workspace not found: ${input.workspaceId}`);
  }

  const [issue] = await input.database
    .select({
      statusId: issues.statusId,
      projectId: issues.projectId,
      statusChangedAt: issues.statusChangedAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1);

  if (!issue) {
    throw new Error(`Issue not found: ${input.issueId}`);
  }

  const projectId = input.projectId ?? issue.projectId ?? null;
  const closedAt = workspace.closedAt ?? input.closedAt ?? now;
  const mergedAt = shouldMarkMerged
    ? workspace.mergedAt ?? input.mergedAt ?? now
    : workspace.mergedAt;

  const workspacePatch: Partial<typeof workspaces.$inferSelect> = {
    status: "closed",
    closedAt,
    readyForMerge: false,
    updatedAt: now,
  };
  if (shouldMarkMerged) workspacePatch.mergedAt = mergedAt;
  if (input.workingDir !== undefined) workspacePatch.workingDir = input.workingDir;

  const workspaceUpdated =
    workspace.status !== "closed" ||
    workspace.closedAt !== closedAt ||
    workspace.readyForMerge !== false ||
    (shouldMarkMerged && workspace.mergedAt !== mergedAt) ||
    (input.workingDir !== undefined && workspace.workingDir !== input.workingDir);

  let issueTransitioned = false;
  let targetStatus: { id: string; name: string } | undefined;
  if (projectId) {
    const statuses = await input.database
      .select({ id: projectStatuses.id, name: projectStatuses.name })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId));
    targetStatus = statuses.find((status) => status.name === "Done")
      ?? (input.fallbackToAiReviewed ? statuses.find((status) => status.name === "AI Reviewed") : undefined);

    if (!targetStatus) {
      console.warn(`[merge-cleanup] no Done status found for project ${projectId}`);
    }
  }

  if (targetStatus && issue.statusId !== targetStatus.id) {
    await input.database
      .update(issues)
      .set({ statusId: targetStatus.id, updatedAt: now, statusChangedAt: now })
      .where(eq(issues.id, input.issueId));
    issueTransitioned = true;
  }

  if (workspaceUpdated) {
    try {
      await input.database
        .update(workspaces)
        .set(workspacePatch)
        .where(eq(workspaces.id, input.workspaceId));
    } catch (err) {
      // #668: The git merge has already been verified (ancestry check passed)
      // before we reach this point. Rolling back the issue → Done transition here
      // would strand the issue In Review with the branch already on master.
      // Instead, log the workspace close failure — the startup reconciler
      // (reconcileSilentlyMergedWorkspaces, via mergedAt) will clean up the
      // workspace on next boot if needed.
      console.warn(
        `[merge-cleanup] workspace close failed after issue transitioned to Done (workspaceId=${input.workspaceId}). ` +
          "Issue will remain Done — the workspace can be reconciled on next startup.",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const sessionsStopped = await stopRunningWorkspaceSessions(input.database, input.workspaceId, now).catch((err) => {
    console.warn(
      `[merge-cleanup] failed to stop running sessions after merge finalization (workspaceId=${input.workspaceId}).`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  });

  const broadcasted = Boolean(input.boardEvents && projectId && (workspaceUpdated || issueTransitioned || sessionsStopped));
  if (broadcasted) {
    input.boardEvents?.broadcast(projectId!, "workspace_merged");
  }

  return {
    projectId,
    closedAt,
    mergedAt: shouldMarkMerged ? mergedAt : null,
    workspaceUpdated,
    issueTransitioned,
    sessionsStopped,
    broadcasted,
  };
}

async function stopRunningWorkspaceSessions(
  database: Database,
  workspaceId: string,
  endedAt: string,
): Promise<boolean> {
  const runningRows = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, "running")));
  if (runningRows.length === 0) return false;

  await database
    .update(sessions)
    .set({ status: "stopped", endedAt })
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, "running")));
  return true;
}
