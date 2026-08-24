import type { Database } from "../db/index.js";
import { createAgentSkillService, AgentSkillError } from "../services/agent-skill.service.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { enhanceSkillBody, createSkillBody } from "./agent-skill-body-schemas.js";
import { createRouter } from "../middleware/create-router.js";
import { wrapAiOperation } from "../lib/ai-operation.js";

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ZodType } from "zod";
import { queryFlag } from "../middleware/query-params.js";
export function createAgentSkillsRoute(database: Database) {
  const router = createRouter();
  const agentSkillService = createAgentSkillService({ database });

  /**
   * `parseJsonBody(c, schema)` with this route file's ERROR IDENTITY preserved (#806, batch 5)
   * — `routes/plugins.ts`'s batch-2 wrapper, third instance.
   *
   * The guard this replaces threw `AgentSkillError("name, description, and prompt are
   * required", "BAD_REQUEST")`, rendered by `domainErrorHandler` as
   * `{ error, code: "BAD_REQUEST" }` at 400 (#823); `parseJsonBody`'s `HTTPException` renders
   * `{ error }` alone, so the re-wrap is what keeps `code` on the wire. Same-file on purpose:
   * `scripts/generate-openapi.ts` follows exactly one hop via `findFunctionNamed(sf, …)`.
   */
  async function parseAgentSkillBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
    try {
      return await parseJsonBody(c, schema);
    } catch (err) {
      if (err instanceof HTTPException && err.status === 400) {
        throw new AgentSkillError(err.message, "BAD_REQUEST");
      }
      throw err;
    }
  }

  // GET /api/agent-skills — list skills
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    const globalOnly = queryFlag(c, "global");
    const initOnly = queryFlag(c, "init");
    return c.json(await agentSkillService.listSkills(projectId, globalOnly, initOnly));
  });

  // POST /api/agent-skills/enhance — AI-enhance a skill name, description, and prompt
  router.post("/enhance", async (c) => {
    const body = await parseJsonBody(c, enhanceSkillBody);
    return c.json(await wrapAiOperation("skill-enhance", () => agentSkillService.enhanceSkill(body.name, body.description, body.prompt)));
  });

  // GET /api/agent-skills/install-status — batch install-status for all skills in one
  // pass (registered before /:id so the static path wins over the :id param route).
  router.get("/install-status", async (c) => {
    return c.json(await agentSkillService.getAllInstallStatuses());
  });

  // GET /api/agent-skills/:id — get a single skill
  router.get("/:id", async (c) => {
    return c.json(await agentSkillService.getSkill(c.req.param("id")));
  });

  // POST /api/agent-skills — create a skill
  router.post("/", async (c) => {
    const body = await parseAgentSkillBody(c, createSkillBody);
    const skill = await agentSkillService.createSkill(body);
    return c.json(skill, 201);
  });

  // PUT /api/agent-skills/:id — update a skill
  router.put("/:id", async (c) => {
    // #806 batch 5 REJECTED this read (family 5, ORDER — batch 3's "no guard at all" was the
    // wrong reason): `updateSkill` throws `"Skill not found"` (404) and `"Cannot modify
    // built-in skills"` (403) before it reads any field, so a schema at the boundary would
    // answer 400 where a caller gets 404/403 today. Same for `POST /:id/install` below.
    // (The note lives INSIDE the handler on purpose: `scripts/generate-openapi.ts` takes the
    // last comment line ABOVE a route as its summary.)
    const id = c.req.param("id");
    const body = await parseJsonBody<{ name?: string; description?: string; prompt?: string; model?: string; projectId?: string | null; isInit?: boolean }>(c);
    const updated = await agentSkillService.updateSkill(id, body);
    return c.json(updated);
  });

  // GET /api/agent-skills/:id/install-status
  router.get("/:id/install-status", async (c) => {
    return c.json(await agentSkillService.getInstallStatus(c.req.param("id")));
  });

  // POST /api/agent-skills/:id/install
  router.post("/:id/install", async (c) => {
    // #389 — optional explicit target; the active project remains the fallback, so every existing
    // caller is unaffected. The response names the repoPath the file actually went to.
    const body = await parseJsonBody<{ projectId?: string }>(c).catch(() => ({} as { projectId?: string }));
    return c.json(await agentSkillService.installSkill(c.req.param("id"), body?.projectId));
  });

  // DELETE /api/agent-skills/:id
  router.delete("/:id", async (c) => {
    await agentSkillService.deleteSkill(c.req.param("id"));
    return c.json({ success: true });
  });

  return router;
}
