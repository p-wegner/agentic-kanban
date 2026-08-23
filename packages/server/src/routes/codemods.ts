import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { codemodPreviewBody, codemodApplyBody, codemodCreateBody } from "./codemod-body-schemas.js";
import { wrapAiOperation } from "../lib/ai-operation.js";
import { createCodemodService } from "../services/codemod.service.js";
import {
  createAgentSkill,
  findSkillByName,
  listAgentSkills,
  getAgentSkillById,
  updateAgentSkill,
} from "../repositories/agent-skill.repository.js";
import type { Database } from "../db/index.js";

export function createCodemodsRoute(database: Database) {
  const router = createRouter();
  const codemodService = createCodemodService(database);

  /**
   * POST /api/codemods/preview
   * Body: { description: string, projectId: string, overrideLimit?: boolean, script?: string }
   * Returns: { script, description, files: [{filePath, relativePath, diff}], totalTsFiles, limitReached }
   */
  router.post("/preview", async (c) => {
    const body = await parseJsonBody(c, codemodPreviewBody);

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
    const body = await parseJsonBody(c, codemodApplyBody);

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
    const body = await parseJsonBody(c, codemodCreateBody);

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
    await updateAgentSkill(codemod.id, { type: "codemod" }, database);

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
