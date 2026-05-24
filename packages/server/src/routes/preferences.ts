import { Hono } from "hono";
import { db } from "../db/index.js";
import { preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function createPreferencesRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/preferences/active-project
  router.get("/active-project", async (c) => {
    const rows = await database
      .select()
      .from(preferences)
      .where(eq(preferences.key, "activeProjectId"))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ projectId: null });
    }

    return c.json({ projectId: rows[0].value });
  });

  // PUT /api/preferences/active-project
  router.put("/active-project", async (c) => {
    const body = await c.req.json();
    const now = new Date().toISOString();

    await database
      .insert(preferences)
      .values({
        key: "activeProjectId",
        value: body.projectId ?? "",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: preferences.key,
        set: { value: body.projectId ?? "", updatedAt: now },
      });

    return c.json({ projectId: body.projectId });
  });

  // GET /api/preferences/settings — get all agent settings
  router.get("/settings", async (c) => {
    const keys = ["agent_command", "agent_args", "output_parser", "skip_permissions", "claude_profile", "codex_profile", "provider", "mock_agent_profile", "mock_agent_delay_ms", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "projects_base_path", "plan_auto_continue"];
    const rows = await database
      .select()
      .from(preferences);

    const settings: Record<string, string> = {};
    for (const row of rows) {
      if (keys.includes(row.key)) {
        settings[row.key] = row.value;
      }
    }

    return c.json(settings);
  });

  // PUT /api/preferences/settings — update agent settings
  router.put("/settings", async (c) => {
    const body = await c.req.json() as Record<string, string>;
    const now = new Date().toISOString();
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "skip_permissions", "claude_profile", "codex_profile", "provider", "mock_agent_profile", "mock_agent_delay_ms", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "projects_base_path", "plan_auto_continue"];

    for (const [key, value] of Object.entries(body)) {
      if (!allowedKeys.includes(key)) continue;
      await database
        .insert(preferences)
        .values({ key, value: value ?? "", updatedAt: now })
        .onConflictDoUpdate({
          target: preferences.key,
          set: { value: value ?? "", updatedAt: now },
        });
    }

    return c.json({ ok: true });
  });

  // GET /api/preferences/claude-profiles — list available claude profiles
  router.get("/claude-profiles", async (c) => {
    const claudeDir = join(homedir(), ".claude");
    const profiles: string[] = ["mock"];
    try {
      const files = readdirSync(claudeDir);
      for (const file of files) {
        const match = file.match(/^settings_(.+)\.json$/);
        if (match && match[1] !== "mock") profiles.push(match[1]);
      }
    } catch {}
    return c.json({ profiles: profiles.sort() });
  });

  // GET /api/preferences/codex-profiles — list available codex profiles
  router.get("/codex-profiles", async (c) => {
    const codexDir = join(homedir(), ".codex");
    const profiles: string[] = [];
    try {
      const files = readdirSync(codexDir);
      for (const file of files) {
        // New convention: <name>.config.toml
        const newMatch = file.match(/^(.+)\.config\.toml$/);
        if (newMatch && newMatch[1] !== "config") profiles.push(newMatch[1]);
        // Legacy convention: config_<name>.toml (but not base config.toml)
        const legacyMatch = file.match(/^config_(.+)\.toml$/);
        if (legacyMatch) profiles.push(legacyMatch[1]);
      }
    } catch {}
    return c.json({ profiles: [...new Set(profiles)].sort() });
  });

  return router;
}

export const preferencesRoute = createPreferencesRoute();
