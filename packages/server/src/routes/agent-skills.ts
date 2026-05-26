import { Hono } from "hono";
import type { Database } from "../db/index.js";
import { createAgentSkillService, AgentSkillError } from "../services/agent-skill.service.js";

export function createAgentSkillsRoute(database: Database) {
  const router = new Hono();
  const agentSkillService = createAgentSkillService({ database });

  // GET /api/agent-skills — list skills
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    const globalOnly = c.req.query("global") === "true";
    return c.json(await agentSkillService.listSkills(projectId, globalOnly));
  });

  // POST /api/agent-skills/enhance — AI-enhance a skill name, description, and prompt
  router.post("/enhance", async (c) => {
    let body: { name: string; description?: string; prompt?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.name?.trim()) {
      return c.json({ error: "name is required" }, 400);
    }

    try {
      const enhanced = await agentSkillService.enhanceSkill(body.name, body.description, body.prompt);
      return c.json(enhanced);
    } catch (err: any) {
      const parts: string[] = [];
      if (err.message) parts.push(err.message);
      if (err.stderr) parts.push(String(err.stderr).trim());
      const msg = parts.length > 0 ? parts.join(" | ") : "claude CLI failed";
      console.error("[skill-enhance] claude error:", msg);
      if (err instanceof AgentSkillError) {
        return c.json({ error: "AI enhancement failed", detail: msg }, 500);
      }
      // Parse failure from service
      if (err instanceof SyntaxError) {
        return c.json({ error: "Failed to parse AI response" }, 500);
      }
      return c.json({ error: "AI enhancement failed", detail: msg }, 500);
    }
  });

  // GET /api/agent-skills/:id — get a single skill
  router.get("/:id", async (c) => {
    try {
      return c.json(await agentSkillService.getSkill(c.req.param("id")));
    } catch (err) {
      if (err instanceof AgentSkillError && err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  // POST /api/agent-skills — create a skill
  router.post("/", async (c) => {
    const body = await c.req.json();
    try {
      const skill = await agentSkillService.createSkill(body);
      return c.json(skill, 201);
    } catch (err) {
      if (err instanceof AgentSkillError) {
        if (err.code === "BAD_REQUEST") return c.json({ error: err.message }, 400);
        if (err.code === "CONFLICT") return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  });

  // PUT /api/agent-skills/:id — update a skill
  router.put("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    try {
      const updated = await agentSkillService.updateSkill(id, body);
      return c.json(updated);
    } catch (err) {
      if (err instanceof AgentSkillError) {
        if (err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
        if (err.code === "FORBIDDEN") return c.json({ error: err.message }, 403);
        if (err.code === "BAD_REQUEST") return c.json({ error: err.message }, 400);
        if (err.code === "CONFLICT") return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  });

  // GET /api/agent-skills/:id/install-status
  router.get("/:id/install-status", async (c) => {
    try {
      return c.json(await agentSkillService.getInstallStatus(c.req.param("id")));
    } catch (err) {
      if (err instanceof AgentSkillError && err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  // POST /api/agent-skills/:id/install
  router.post("/:id/install", async (c) => {
    try {
      return c.json(await agentSkillService.installSkill(c.req.param("id")));
    } catch (err) {
      if (err instanceof AgentSkillError) {
        if (err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
        if (err.code === "BAD_REQUEST") return c.json({ error: err.message }, 400);
        return c.json({ error: `Failed to install skill: ${err.message}` }, 500);
      }
      throw err;
    }
  });

  // DELETE /api/agent-skills/:id
  router.delete("/:id", async (c) => {
    try {
      await agentSkillService.deleteSkill(c.req.param("id"));
      return c.json({ success: true });
    } catch (err) {
      if (err instanceof AgentSkillError) {
        if (err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
        if (err.code === "FORBIDDEN") return c.json({ error: err.message }, 403);
      }
      throw err;
    }
  });

  return router;
}
