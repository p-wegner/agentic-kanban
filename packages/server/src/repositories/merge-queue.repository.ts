import { workspaces, issues } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getMergeQueueWorkspaceRows(
  workspaceIds: string[],
  database: Database = db,
) {
  return database
    .select()
    .from(workspaces)
    .where(inArray(workspaces.id, workspaceIds));
}

export async function getMergeQueueIssueRows(
  issueIds: string[],
  database: Database = db,
) {
  return database
    .select()
    .from(issues)
    .where(inArray(issues.id, issueIds));
}

export async function getWorkspaceStatus(
  workspaceId: string,
  database: Database = db,
): Promise<string | undefined> {
  const [current] = await database
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return current?.status;
}

export async function getWorkspaceMergeState(
  workspaceId: string,
  database: Database = db,
): Promise<{ status: string; mergedAt: string | null } | undefined> {
  const [row] = await database
    .select({
      status: workspaces.status,
      mergedAt: workspaces.mergedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row;
}
