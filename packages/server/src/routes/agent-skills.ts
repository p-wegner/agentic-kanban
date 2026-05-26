import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createAgentSkillService } from "../services/agent-skill.service.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createRouter } from "../middleware/create-router.js";
import { wrapAiOperation } from "../middleware/ai-operation.js";

export function createAgentSkillsRoute(database: Database = db) {
  const router = createRouter();
  const agentSkillService = createAgentSkillService({ database });

  // GET /api/agent-skills — list skills
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    const globalOnly = c.req.query("global") === "true";
    return c.json(await agentSkillService.listSkills(projectId, globalOnly));
  });

  // POST /api/agent-skills/enhance — AI-enhance a skill name, description, and prompt
  router.post("/enhance", async (c) => {
    const body = await parseJsonBody<{ name: string; description?: string; prompt?: string }>(c);
    if (!body.name?.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    return c.json(await wrapAiOperation("skill-enhance", () => agentSkillService.enhanceSkill(body.name, body.description, body.prompt)));
  });

  // GET /api/agent-skills/:id — get a single skill
  router.get("/:id", async (c) => {
    return c.json(await agentSkillService.getSkill(c.req.param("id")));
  });

  // POST /api/agent-skills — create a skill
  router.post("/", async (c) => {
    const body = await parseJsonBody(c);
    const skill = await agentSkillService.createSkill(body);
    return c.json(skill, 201);
  });

  // PUT /api/agent-skills/:id — update a skill
  router.put("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    const updated = await agentSkillService.updateSkill(id, body);
    return c.json(updated);
  });

  // GET /api/agent-skills/:id/install-status
  router.get("/:id/install-status", async (c) => {
    return c.json(await agentSkillService.getInstallStatus(c.req.param("id")));
  });

  // POST /api/agent-skills/:id/install
  router.post("/:id/install", async (c) => {
    return c.json(await agentSkillService.installSkill(c.req.param("id")));
  });

  // DELETE /api/agent-skills/:id
  router.delete("/:id", async (c) => {
    await agentSkillService.deleteSkill(c.req.param("id"));
    return c.json({ success: true });
  });

  return router;
}

export const agentSkillsRoute = createAgentSkillsRoute();
