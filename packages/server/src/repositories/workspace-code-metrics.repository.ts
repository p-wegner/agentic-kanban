import { eq } from "drizzle-orm";
import { workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getWorkspaceWorkingDir(
  workspaceId: string,
  database: Database = db,
): Promise<string | null> {
  const rows = await database
    .select({ workingDir: workspaces.workingDir })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0]?.workingDir ?? null;
}

export async function updateWorkspaceCodeMetrics(
  workspaceId: string,
  codeMetricsJson: string,
  codeMetricsComputedAt: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({
    codeMetricsJson,
    codeMetricsComputedAt,
  }).where(eq(workspaces.id, workspaceId));
}
