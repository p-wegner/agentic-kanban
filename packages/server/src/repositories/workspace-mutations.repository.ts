import { workspaces } from "@agentic-kanban/shared/schema";
import { deleteWorkspaceCascade as deleteWorkspaceCascadeShared } from "@agentic-kanban/shared/lib/cascade-delete";
import { setWorkspaceStatus, type WorkspaceStatus } from "./workspace-status.repository.js";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

type Workspace = typeof workspaces.$inferSelect;

export async function updateWorkspaceStatus(
  workspaceId: string,
  status: string,
  extra: Partial<Omit<Workspace, "id" | "status" | "updatedAt">> = {},
  database: Database = db,
): Promise<void> {
  await setWorkspaceStatus(database, workspaceId, status as WorkspaceStatus, { set: extra });
}

/** Cascade delete a workspace and every table that directly FK-references it. */
export async function deleteWorkspaceCascade(
  workspaceId: string,
  database: Database = db,
): Promise<void> {
  await deleteWorkspaceCascadeShared(workspaceId, database);
}
