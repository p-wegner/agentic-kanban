import { agentSkills, preferences } from "@agentic-kanban/shared/schema";
import { eq, and, isNull, sql, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

export async function listAgentSkills(
  projectId: string | undefined,
  globalOnly: boolean,
  database: Database = db,
) {
  if (globalOnly) {
    return database.select().from(agentSkills)
      .where(isNull(agentSkills.projectId))
      .orderBy(agentSkills.name);
  }
  if (projectId) {
    return database.select().from(agentSkills)
      .where(sql`${agentSkills.projectId} IS NULL OR ${agentSkills.projectId} = ${projectId}`)
      .orderBy(agentSkills.name);
  }
  return database.select().from(agentSkills).orderBy(agentSkills.name);
}

export async function getAgentSkillById(
  id: string,
  database: Database = db,
) {
  const rows = await database.select().from(agentSkills).where(eq(agentSkills.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findSkillByName(
  name: string,
  projectId: string | null,
  database: Database = db,
) {
  const scopeCondition = projectId
    ? and(eq(agentSkills.name, name), eq(agentSkills.projectId, projectId))
    : and(eq(agentSkills.name, name), isNull(agentSkills.projectId));
  const rows = await database.select().from(agentSkills).where(scopeCondition).limit(1);
  return rows[0] ?? null;
}

export async function createAgentSkill(
  input: {
    name: string;
    description: string;
    prompt: string;
    model?: string | null;
    projectId?: string | null;
  },
  database: Database = db,
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const skill = {
    id,
    name: input.name,
    description: input.description,
    prompt: input.prompt,
    model: input.model ?? null,
    projectId: input.projectId ?? null,
    isBuiltin: false,
    createdAt: now,
    updatedAt: now,
  };
  await database.insert(agentSkills).values(skill);
  return skill;
}

export async function updateAgentSkill(
  id: string,
  updates: Record<string, unknown>,
  database: Database = db,
) {
  await database.update(agentSkills).set(updates).where(eq(agentSkills.id, id));
  const rows = await database.select().from(agentSkills).where(eq(agentSkills.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function deleteAgentSkill(
  id: string,
  database: Database = db,
) {
  await database.delete(agentSkills).where(eq(agentSkills.id, id));
}

export async function getActiveProjectRepoPath(
  database: Database = db,
): Promise<string | null> {
  const prefRows = await database.select().from(preferences).where(eq(preferences.key, "activeProjectId"));
  const activeProjectId = prefRows[0]?.value;
  if (!activeProjectId) return null;
  const project = await getProjectById(activeProjectId, database);
  return project?.repoPath ?? null;
}

// ───────────────────────── Butler system-prompt skill ─────────────────────────
// The butler's editable system prompt is stored as a special `agentSkills` row
// named "butler": a project-scoped row (projectId set) overrides the global
// (projectId NULL) one. These helpers own that table access so the butler route
// holds no inline persistence.

/**
 * Resolve the butler prompt for a project: a project-scoped override wins over
 * the global (NULL projectId) row. Returns the prompt, or null if neither exists.
 * (ORDER BY projectId DESC: in SQLite NULL sorts last, so the override is first.)
 */
export async function getButlerPrompt(
  projectId: string,
  database: Database = db,
): Promise<string | null> {
  const rows = await database
    .select({ prompt: agentSkills.prompt })
    .from(agentSkills)
    .where(sql`${agentSkills.name} = 'butler' AND (${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)`)
    .orderBy(desc(agentSkills.projectId))
    .limit(1);
  return rows[0]?.prompt ?? null;
}

/** The project-scoped butler override row (id + prompt), or null when only the global exists. */
export async function getButlerOverride(
  projectId: string,
  database: Database = db,
): Promise<{ id: string; prompt: string } | null> {
  const rows = await database
    .select({ id: agentSkills.id, prompt: agentSkills.prompt })
    .from(agentSkills)
    .where(sql`${agentSkills.name} = 'butler' AND ${agentSkills.projectId} = ${projectId}`)
    .limit(1);
  return rows[0] ?? null;
}

/** The global (unscoped) butler prompt, or null. */
export async function getGlobalButlerPrompt(
  database: Database = db,
): Promise<string | null> {
  const rows = await database
    .select({ prompt: agentSkills.prompt })
    .from(agentSkills)
    .where(sql`${agentSkills.name} = 'butler' AND ${agentSkills.projectId} IS NULL`)
    .limit(1);
  return rows[0]?.prompt ?? null;
}

/** Create or update the project-scoped butler override. */
export async function upsertButlerOverride(
  projectId: string,
  prompt: string,
  database: Database = db,
): Promise<void> {
  const existing = await getButlerOverride(projectId, database);
  const now = new Date().toISOString();
  if (existing) {
    await database.update(agentSkills).set({ prompt, updatedAt: now }).where(eq(agentSkills.id, existing.id));
  } else {
    await database.insert(agentSkills).values({
      id: randomUUID(),
      name: "butler",
      projectId,
      description: "Project butler behavior override",
      prompt,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** Remove the project-scoped butler override (revert to the global default). No-op when absent. */
export async function deleteButlerOverride(
  projectId: string,
  database: Database = db,
): Promise<void> {
  await database.delete(agentSkills).where(
    sql`${agentSkills.name} = 'butler' AND ${agentSkills.projectId} = ${projectId}`,
  );
}

/** Find a skill by name in ANY scope (global or any project), first match. */
export async function getAgentSkillByName(name: string, database: Database = db) {
  const rows = await database.select().from(agentSkills).where(eq(agentSkills.name, name)).limit(1);
  return rows[0] ?? null;
}
