// Repository for a workspace's per-workspace Docker service-stack state
// (`workspaces.service_state`, a JSON `ServiceStackState`). Kept as its own focused
// module so the create/deferred-launch flow persists the stack state through the
// repository layer (services must not spawn drizzle directly) without growing the
// grandfathered workspace repositories past their god-module baselines.

import { eq } from "drizzle-orm";
import { workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** Persist (or clear, with null) a workspace's serialized service-stack state. */
export async function updateWorkspaceServiceState(
  workspaceId: string,
  serviceStateJson: string | null,
  database: Database = db,
) {
  return database
    .update(workspaces)
    .set({ serviceState: serviceStateJson, updatedAt: new Date().toISOString() })
    .where(eq(workspaces.id, workspaceId));
}
