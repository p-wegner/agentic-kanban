import { Hono } from "hono";
import { db } from "../db/index.js";
import { agentSkills } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";

export function createAgentSkillsRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/agent-skills — list all skills
  router.get("/", async (c) => {
    const rows = await database.select().from(agentSkills).orderBy(agentSkills.name);
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

    // Check for duplicate name
    const existing = await database.select().from(agentSkills).where(eq(agentSkills.name, body.name)).limit(1);
    if (existing.length > 0) {
      return c.json({ error: `Skill '${body.name}' already exists` }, 409);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const skill = {
      id,
      name: body.name,
      description: body.description,
      prompt: body.prompt,
      model: body.model ?? null,
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
      // Check for duplicate name (excluding self)
      const dup = await database.select().from(agentSkills).where(eq(agentSkills.name, body.name)).limit(1);
      if (dup.length > 0 && dup[0].id !== id) {
        return c.json({ error: `Skill '${body.name}' already exists` }, 409);
      }
      updates.name = body.name;
    }
    if (body.description !== undefined) updates.description = body.description;
    if (body.prompt !== undefined) updates.prompt = body.prompt;
    if (body.model !== undefined) updates.model = body.model || null;

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
