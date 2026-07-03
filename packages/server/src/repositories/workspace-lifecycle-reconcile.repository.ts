import { and, eq } from "drizzle-orm";
import { sessions, workspaces } from "@agentic-kanban/shared/schema";
import { setWorkspaceStatus, type WorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getWorkspaceCloseState(workspaceId: string, database: Database = db) {
  return database
    .select({
      status: workspaces.status,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
      readyForMerge: workspaces.readyForMerge,
      workingDir: workspaces.workingDir,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}

export async function applyWorkspaceClosePatch(
  workspaceId: string,
  patch: Partial<typeof workspaces.$inferSelect>,
  database: Database = db,
): Promise<void> {
  const { status, updatedAt, ...rest } = patch;
  await setWorkspaceStatus(database, workspaceId, (status ?? "closed") as WorkspaceStatus, {
    now: updatedAt,
    set: rest,
  });
}

export async function getRunningSessionIdsForWorkspace(workspaceId: string, database: Database = db) {
  return database
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, "running")));
}

export async function stopRunningSessionsForWorkspace(
  workspaceId: string,
  endedAt: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(sessions)
    .set({ status: "stopped", endedAt })
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, "running")));
}
