import { workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * Persist whether this workspace's isolation was downgraded to host execution
 * (#160) — "container requested, host delivered" must survive the launch, not
 * just print a console.warn. `reason` is null when a later launch containerizes
 * successfully, clearing a stale downgrade flag.
 */
export async function updateWorkspaceIsolationDowngrade(
  workspaceId: string,
  isolationDowngraded: boolean,
  isolationDowngradeReason: string | null,
  database: Database = db,
): Promise<void> {
  await database
    .update(workspaces)
    .set({ isolationDowngraded, isolationDowngradeReason })
    .where(eq(workspaces.id, workspaceId));
}
