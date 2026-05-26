import { agentSkills, preferences, projects } from "@agentic-kanban/shared/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

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
  const projectRows = await database.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, activeProjectId)).limit(1);
  return projectRows[0]?.repoPath ?? null;
}
