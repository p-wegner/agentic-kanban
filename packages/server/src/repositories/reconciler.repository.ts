import { desc, sql } from "drizzle-orm";
import { agentSkills } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * Resolve the `merge-reconciler` agent_skills prompt for a project: a
 * project-scoped row overrides the global (NULL projectId) one. Returns the
 * prompt string, or null when no row matches.
 */
export async function getMergeReconcilerSkillPrompt(
  projectId: string,
  database: Database = db,
): Promise<string | null> {
  const row = await database
    .select({ prompt: agentSkills.prompt })
    .from(agentSkills)
    .where(sql`${agentSkills.name} = 'merge-reconciler' AND (${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)`)
    .orderBy(desc(agentSkills.projectId))
    .limit(1);
  return row[0]?.prompt ?? null;
}
