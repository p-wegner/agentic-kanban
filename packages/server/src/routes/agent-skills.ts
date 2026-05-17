import { Hono } from "hono";
import { db } from "../db/index.js";
import { agentSkills } from "@agentic-kanban/shared/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";

export function createAgentSkillsRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/agent-skills — list skills
  // ?projectId=<id> — returns global skills + project-specific skills
  // ?global=true — returns only global skills (no project_id)
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    const globalOnly = c.req.query("global") === "true";

    let rows;
    if (globalOnly) {
      rows = await database.select().from(agentSkills)
        .where(isNull(agentSkills.projectId))
        .orderBy(agentSkills.name);
    } else if (projectId) {
      rows = await database.select().from(agentSkills)
        .where(sql`${agentSkills.projectId} IS NULL OR ${agentSkills.projectId} = ${projectId}`)
        .orderBy(agentSkills.name);
    } else {
      rows = await database.select().from(agentSkills).orderBy(agentSkills.name);
    }
    return c.json(rows);
  });

  // GET /api/agent-skills/:id — get a single skill
  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    const rows = await database.select().from(agentSkills).where(eq(agentSkills.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Skill not found" }, 404);
    }
    return c.json(rows[0]);
  });

  // POST /api/agent-skills — create a skill
  router.post("/", async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.description || !body.prompt) {
      return c.json({ error: "name, description, and prompt are required" }, 400);
    }

    const projectId = body.projectId || null;

    // Check for duplicate name within the same scope (global or same project)
    const scopeCondition = projectId
      ? and(eq(agentSkills.name, body.name), eq(agentSkills.projectId, projectId))
      : and(eq(agentSkills.name, body.name), isNull(agentSkills.projectId));
    const existing = await database.select().from(agentSkills).where(scopeCondition).limit(1);
    if (existing.length > 0) {
      return c.json({ error: `Skill '${body.name}' already exists in this scope` }, 409);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const skill = {
      id,
      name: body.name,
      description: body.description,
      prompt: body.prompt,
      model: body.model ?? null,
      projectId,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    };

    await database.insert(agentSkills).values(skill);
    return c.json(skill, 201);
  });

  // PUT /api/agent-skills/:id — update a skill
  router.put("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    const rows = await database.select().from(agentSkills).where(eq(agentSkills.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Skill not found" }, 404);
    }

    const skill = rows[0];
    if (skill.isBuiltin) {
      return c.json({ error: "Cannot modify built-in skills" }, 403);
    }

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updatedAt: now };

    if (body.name !== undefined) {
      const effectiveProjectId = body.projectId !== undefined ? (body.projectId || null) : skill.projectId;
      const scopeCondition = effectiveProjectId
        ? and(eq(agentSkills.name, body.name), eq(agentSkills.projectId, effectiveProjectId))
        : and(eq(agentSkills.name, body.name), isNull(agentSkills.projectId));
      const dup = await database.select().from(agentSkills).where(scopeCondition).limit(1);
      if (dup.length > 0 && dup[0].id !== id) {
        return c.json({ error: `Skill '${body.name}' already exists in this scope` }, 409);
      }
      updates.name = body.name;
    }
    if (body.description !== undefined) updates.description = body.description;
    if (body.prompt !== undefined) updates.prompt = body.prompt;
    if (body.model !== undefined) updates.model = body.model || null;
    if (body.projectId !== undefined) updates.projectId = body.projectId || null;

    await database.update(agentSkills).set(updates).where(eq(agentSkills.id, id));
    const updated = await database.select().from(agentSkills).where(eq(agentSkills.id, id)).limit(1);
    return c.json(updated[0]);
  });

  // DELETE /api/agent-skills/:id — delete a skill
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");

    const rows = await database.select().from(agentSkills).where(eq(agentSkills.id, id)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: "Skill not found" }, 404);
    }

    if (rows[0].isBuiltin) {
      return c.json({ error: "Cannot delete built-in skills" }, 403);
    }

    await database.delete(agentSkills).where(eq(agentSkills.id, id));
    return c.json({ success: true });
  });

  return router;
}

export const agentSkillsRoute = createAgentSkillsRoute();
