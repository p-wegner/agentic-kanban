import { eq } from "drizzle-orm";
import * as schema from "../../schema/index.js";
import type { WorkflowDb } from "./types.js";

/**
 * Resolve a project's status row id by its (case-insensitive) name.
 * Shared leaf helper for the transition / status-sync / workspace-init modules.
 */
export async function resolveStatusId(
  db: WorkflowDb,
  projectId: string,
  statusName: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: schema.projectStatuses.id, name: schema.projectStatuses.name })
    .from(schema.projectStatuses)
    .where(eq(schema.projectStatuses.projectId, projectId));
  const match =
    rows.find((r) => r.name === statusName) ??
    rows.find((r) => r.name.toLowerCase() === statusName.toLowerCase());
  return match?.id ?? null;
}
