import { Hono } from "hono";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { writeAgentSkillFile, isSkillInstalledLocally } from "@agentic-kanban/shared/lib/agent-skill-files";
import { invokeClaudePrompt } from "../services/claude-cli.service.js";
import {
  listAgentSkills,
  getAgentSkillById,
  findSkillByName,
  createAgentSkill,
  updateAgentSkill,
  deleteAgentSkill,
  getActiveProjectRepoPath,
} from "../repositories/agent-skill.repository.js";

export function createAgentSkillsRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/agent-skills — list skills
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    const globalOnly = c.req.query("global") === "true";
    return c.json(await listAgentSkills(projectId, globalOnly, database));
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

    const prompt = `You are helping create an agent skill definition for a kanban board AI coding system.
Given a skill name and optional description/prompt, return an improved version that is clear, actionable, and well-structured.
The description should be one concise sentence explaining what the skill does.
The prompt should be a detailed SKILL.md-style guide that an AI agent can follow.
Respond ONLY with valid JSON — no markdown, no explanation:
{"name": "...", "description": "...", "prompt": "..."}

Current name: ${body.name}
Current description: ${body.description?.trim() || "(none)"}
Current prompt: ${body.prompt?.trim() || "(none)"}`;

    let stdout: string;
    try {
      stdout = await invokeClaudePrompt(prompt, { database });
    } catch (err: any) {
      const parts: string[] = [];
      if (err.message) parts.push(err.message);
      if (err.stderr) parts.push(String(err.stderr).trim());
      const msg = parts.length > 0 ? parts.join(" | ") : "claude CLI failed";
      console.error("[skill-enhance] claude error:", msg);
      return c.json({ error: "AI enhancement failed", detail: msg }, 500);
    }

    const output = stdout.trim();
    const cleaned = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try {
      const enhanced = JSON.parse(cleaned) as { name?: string; description?: string; prompt?: string };
      return c.json({
        name: enhanced.name?.trim() || body.name,
        description: enhanced.description?.trim() ?? body.description ?? "",
        prompt: enhanced.prompt?.trim() ?? body.prompt ?? "",
      });
    } catch {
      console.error("[skill-enhance] failed to parse claude output:", output);
      return c.json({ error: "Failed to parse AI response", raw: output }, 500);
    }
  });

  // GET /api/agent-skills/:id — get a single skill
  router.get("/:id", async (c) => {
    const skill = await getAgentSkillById(c.req.param("id"), database);
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    return c.json(skill);
  });

  // POST /api/agent-skills — create a skill
  router.post("/", async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.description || !body.prompt) {
      return c.json({ error: "name, description, and prompt are required" }, 400);
    }

    if (/[\/\\]|\.\./.test(body.name)) {
      return c.json({ error: "Skill name cannot contain '/', '\\', or '..'" }, 400);
    }

    const projectId = body.projectId || null;
    const existing = await findSkillByName(body.name, projectId, database);
    if (existing) {
      return c.json({ error: `Skill '${body.name}' already exists in this scope` }, 409);
    }

    const skill = await createAgentSkill({
      name: body.name,
      description: body.description,
      prompt: body.prompt,
      model: body.model,
      projectId,
    }, database);
    return c.json(skill, 201);
  });

  // PUT /api/agent-skills/:id — update a skill
  router.put("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    const skill = await getAgentSkillById(id, database);
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    if (skill.isBuiltin) return c.json({ error: "Cannot modify built-in skills" }, 403);

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updatedAt: now };

    if (body.name !== undefined) {
      if (/[\/\\]|\.\./.test(body.name)) {
        return c.json({ error: "Skill name cannot contain '/', '\\', or '..'" }, 400);
      }
      const effectiveProjectId = body.projectId !== undefined ? (body.projectId || null) : skill.projectId;
      const dup = await findSkillByName(body.name, effectiveProjectId, database);
      if (dup && dup.id !== id) {
        return c.json({ error: `Skill '${body.name}' already exists in this scope` }, 409);
      }
      updates.name = body.name;
    }
    if (body.description !== undefined) updates.description = body.description;
    if (body.prompt !== undefined) updates.prompt = body.prompt;
    if (body.model !== undefined) updates.model = body.model || null;
    if (body.projectId !== undefined) updates.projectId = body.projectId || null;

    const updated = await updateAgentSkill(id, updates, database);
    return c.json(updated);
  });

  // GET /api/agent-skills/:id/install-status
  router.get("/:id/install-status", async (c) => {
    const skill = await getAgentSkillById(c.req.param("id"), database);
    if (!skill) return c.json({ error: "Skill not found" }, 404);

    const repoPath = await getActiveProjectRepoPath(database);
    if (!repoPath) return c.json({ installed: false, repoPath: null });

    const installed = await isSkillInstalledLocally(repoPath, skill.name);
    return c.json({ installed, repoPath });
  });

  // POST /api/agent-skills/:id/install
  router.post("/:id/install", async (c) => {
    const skill = await getAgentSkillById(c.req.param("id"), database);
    if (!skill) return c.json({ error: "Skill not found" }, 404);

    const repoPath = await getActiveProjectRepoPath(database);
    if (!repoPath) return c.json({ error: "No active project found" }, 400);

    try {
      await writeAgentSkillFile(repoPath, skill);
    } catch (err) {
      return c.json({ error: `Failed to install skill: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    return c.json({ installed: true, repoPath });
  });

  // DELETE /api/agent-skills/:id
  router.delete("/:id", async (c) => {
    const skill = await getAgentSkillById(c.req.param("id"), database);
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    if (skill.isBuiltin) return c.json({ error: "Cannot delete built-in skills" }, 403);

    await deleteAgentSkill(c.req.param("id"), database);
    return c.json({ success: true });
  });

  return router;
}

export const agentSkillsRoute = createAgentSkillsRoute();
