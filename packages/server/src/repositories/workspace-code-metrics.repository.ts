import { eq } from "drizzle-orm";
import { workspaceCodeMetrics, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { firstRow } from "../lib/first-row.js";

export async function getWorkspaceWorkingDir(
  workspaceId: string,
  database: Database = db,
): Promise<string | null> {
  return (await firstRow(
    database
      .select({ workingDir: workspaces.workingDir })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
  ))?.workingDir ?? null;
}

/**
 * Store the computed artifact (#798: in `workspace_code_metrics`, not two columns on
 * `workspaces`). Upsert, because there is exactly one current artifact per workspace and a
 * recompute replaces it.
 */
export async function updateWorkspaceCodeMetrics(
  workspaceId: string,
  codeMetricsJson: string,
  codeMetricsComputedAt: string,
  database: Database = db,
): Promise<void> {
  await database.insert(workspaceCodeMetrics).values({
    workspaceId,
    metricsJson: codeMetricsJson,
    computedAt: codeMetricsComputedAt,
  }).onConflictDoUpdate({
    target: workspaceCodeMetrics.workspaceId,
    set: { metricsJson: codeMetricsJson, computedAt: codeMetricsComputedAt },
  });
}
