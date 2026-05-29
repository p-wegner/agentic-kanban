import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { wrapAiOperation } from "../middleware/ai-operation.js";
import { createCodemodService } from "../services/codemod.service.js";
import {
  createAgentSkill,
  findSkillByName,
  listAgentSkills,
  getAgentSkillById,
} from "../repositories/agent-skill.repository.js";
import type { Database } from "../db/index.js";
import { agentSkills } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";

export function createCodemodsRoute(database: Database) {
  const router = createRouter();
  const codemodService = createCodemodService(database);

  /**
   * POST /api/codemods/preview
   * Body: { description: string, projectId: string, overrideLimit?: boolean, script?: string }
   * Returns: { script, description, files: [{filePath, relativePath, diff}], totalTsFiles, limitReached }
   */
  router.post("/preview", async (c) => {
    const body = await parseJsonBody<{
      description: string;
      projectId: string;
      overrideLimit?: boolean;
      script?: string;
    }>(c);

    if (!body.description?.trim()) {
      return c.json({ error: "description is required" }, 400);
    }
    if (!body.projectId?.trim()) {
      return c.json({ error: "projectId is required" }, 400);
    }

    const result = await wrapAiOperation("codemod-preview", () =>
      codemodService.preview(body.description, body.projectId, {
        overrideLimit: body.overrideLimit,
        script: body.script,
      }),
    );

    return c.json({
      script: result.script,
      description: result.description,
      files: result.files.map((f) => ({
        filePath: f.filePath,
        relativePath: f.relativePath,
        diff: f.diff,
        original: f.original,
        modified: f.modified,
      })),
      totalTsFiles: result.totalTsFiles,
      limitReached: result.limitReached,
    });
  });

  /**
   * POST /api/codemods/apply
   * Body: { projectId: string, changes: [{filePath, modified}], selectedFiles?: string[] }
   * Returns: { applied: string[], skipped: string[] }
   *
   * `projectId` is required: the service uses the project's repo path as a
   * security boundary and refuses to write to any path outside it.
   */
  router.post("/apply", async (c) => {
    const body = await parseJsonBody<{
      projectId: string;
      changes: Array<{ filePath: string; modified: string }>;
      selectedFiles?: string[];
    }>(c);

    if (!body.projectId?.trim()) {
      return c.json({ error: "projectId is required" }, 400);
    }
    if (!Array.isArray(body.changes) || body.changes.length === 0) {
      return c.json({ error: "changes array is required and must not be empty" }, 400);
    }

    const result = await codemodService.apply(
      body.projectId,
      body.changes,
      body.selectedFiles ?? [],
    );

    return c.json(result);
  });

  /**
   * GET /api/codemods?projectId=<id>
   * Returns saved codemods (agent_skills with type='codemod') for a project.
   */
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    const skills = await listAgentSkills(projectId, false, database);
    const codemods = skills.filter((s) => (s as { type?: string }).type === "codemod");
    return c.json(codemods);
  });

  /**
   * POST /api/codemods
   * Body: { name, description, script, projectId? }
   * Save a codemod to agent_skills with type='codemod'.
   */
  router.post("/", async (c) => {
    const body = await parseJsonBody<{
      name: string;
      description: string;
      script: string;
      projectId?: string | null;
    }>(c);

    if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
    if (!body.description?.trim()) return c.json({ error: "description is required" }, 400);
    if (!body.script?.trim()) return c.json({ error: "script is required" }, 400);

    const projectId = body.projectId ?? null;
    const existing = await findSkillByName(body.name, projectId, database);
    if (existing) {
      if ((existing as { type?: string }).type === "codemod") {
        return c.json({ error: `Codemod '${body.name}' already exists in this scope` }, 409);
      }
    }

    const codemod = await createAgentSkill(
      {
        name: body.name,
        description: body.description,
        prompt: body.script,
        projectId,
      },
      database,
    );

    // Update type to 'codemod'
    await database.update(agentSkills).set({ type: "codemod" }).where(eq(agentSkills.id, codemod.id));

    return c.json({ ...codemod, type: "codemod" }, 201);
  });

  /**
   * GET /api/codemods/:id
   * Returns a single saved codemod.
   */
  router.get("/:id", async (c) => {
    const skill = await getAgentSkillById(c.req.param("id"), database);
    if (!skill) return c.json({ error: "Codemod not found" }, 404);
    return c.json(skill);
  });

  return router;
}
