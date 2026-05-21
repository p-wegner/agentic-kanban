import { Hono } from "hono";
import { db } from "../db/index.js";
import { agentSkills, preferences, projects } from "@agentic-kanban/shared/schema";
import { eq, and, isNull, sql, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { execFile, execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Database } from "../db/index.js";
import { writeAgentSkillFile, isSkillInstalledLocally } from "@agentic-kanban/shared/lib/agent-skill-files";
import { buildSpawnEnv } from "../services/agent-provider.js";

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

    let agentCommand = "claude";
    let claudeProfile: string | undefined;
    const prefs = await database
      .select({ key: preferences.key, value: preferences.value })
      .from(preferences)
      .where(inArray(preferences.key, ["agent_command", "claude_profile"]));
    for (const p of prefs) {
      if (p.key === "agent_command" && p.value) agentCommand = p.value;
      if (p.key === "claude_profile" && p.value) claudeProfile = p.value;
    }

    if (process.platform === "win32" && agentCommand === "claude") {
      try {
        const resolved = execSync("where claude.exe 2>nul", { encoding: "utf8" }).trim().split("\n")[0]?.trim();
        if (resolved) agentCommand = resolved;
      } catch {}
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

    const args: string[] = ["--output-format", "text", "-p"];
    if (claudeProfile) {
      const settingsPath = join(homedir(), ".claude", `settings_${claudeProfile}.json`);
      if (existsSync(settingsPath)) {
        args.push("--settings", settingsPath);
      }
    }

    let stdout: string;
    try {
      ({ stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = execFile(agentCommand, args, {
          encoding: "utf8",
          timeout: 60000,
          shell: false,
          maxBuffer: 1024 * 1024,
          env: buildSpawnEnv(claudeProfile),
        }, (err, out, se) => {
          if (err) reject(err);
          else resolve({ stdout: out ?? "", stderr: se ?? "" });
        });
        child.stdin?.end(prompt);
      }));
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

    if (/[\/\\]|\.\./.test(body.name)) {
      return c.json({ error: "Skill name cannot contain '/', '\\', or '..'" }, 400);
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
      if (/[\/\\]|\.\./.test(body.name)) {
        return c.json({ error: "Skill name cannot contain '/', '\\', or '..'" }, 400);
      }
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

  // GET /api/agent-skills/:id/install-status — check if skill is installed locally in the active project
  router.get("/:id/install-status", async (c) => {
    const id = c.req.param("id");
    const rows = await database.select().from(agentSkills).where(eq(agentSkills.id, id)).limit(1);
    if (rows.length === 0) return c.json({ error: "Skill not found" }, 404);

    const repoPath = await getActiveProjectRepoPath(database);
    if (!repoPath) return c.json({ installed: false, repoPath: null });

    const installed = await isSkillInstalledLocally(repoPath, rows[0].name);
    return c.json({ installed, repoPath });
  });

  // POST /api/agent-skills/:id/install — write skill as SKILL.md into active project's .claude/skills/
  router.post("/:id/install", async (c) => {
    const id = c.req.param("id");
    const rows = await database.select().from(agentSkills).where(eq(agentSkills.id, id)).limit(1);
    if (rows.length === 0) return c.json({ error: "Skill not found" }, 404);

    const repoPath = await getActiveProjectRepoPath(database);
    if (!repoPath) return c.json({ error: "No active project found" }, 400);

    try {
      await writeAgentSkillFile(repoPath, rows[0]);
    } catch (err) {
      return c.json({ error: `Failed to install skill: ${err instanceof Error ? err.message : String(err)}` }, 500);
    }
    return c.json({ installed: true, repoPath });
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

async function getActiveProjectRepoPath(database: Database): Promise<string | null> {
  const prefRows = await database.select().from(preferences).where(eq(preferences.key, "activeProjectId"));
  const activeProjectId = prefRows[0]?.value;
  if (!activeProjectId) return null;
  const projectRows = await database.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, activeProjectId)).limit(1);
  return projectRows[0]?.repoPath ?? null;
}
