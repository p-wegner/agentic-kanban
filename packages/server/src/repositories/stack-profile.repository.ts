import { projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** Read a project's configured setup script, or null if the project/column is unset. */
export async function getProjectSetupScript(
  projectId: string,
  database: Database = db,
): Promise<string | null> {
  const [project] = await database
    .select({ setupScript: projects.setupScript })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return project?.setupScript ?? null;
}

/** Set a project's setup script and bump its updatedAt timestamp. */
export async function setProjectSetupScript(
  projectId: string,
  setupScript: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(projects)
    .set({ setupScript, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, projectId));
}
