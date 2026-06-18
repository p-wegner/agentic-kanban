import { workspaces, issueArtifacts } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getWorkspaceWorkingDirAndBase(
  workspaceId: string,
  database: Database = db,
) {
  const rows = await database
    .select({ workingDir: workspaces.workingDir, baseBranch: workspaces.baseBranch })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return rows[0] ?? null;
}

export async function workspaceExists(
  workspaceId: string,
  database: Database = db,
): Promise<boolean> {
  const rows = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return !!rows[0];
}

export async function getWorkspaceArtifacts(
  workspaceId: string,
  database: Database = db,
): Promise<(typeof issueArtifacts.$inferSelect)[]> {
  return database
    .select()
    .from(issueArtifacts)
    .where(eq(issueArtifacts.workspaceId, workspaceId))
    .orderBy(issueArtifacts.createdAt);
}
