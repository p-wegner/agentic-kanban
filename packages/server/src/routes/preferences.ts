import { Hono } from "hono";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getPreference, setPreference, getAllPreferences, setPreferences } from "../repositories/preferences.repository.js";

const SETTINGS_KEYS = [
  "agent_command", "agent_args", "output_parser", "skip_permissions", "claude_profile",
  "codex_profile", "copilot_profile", "provider", "mock_agent_profile", "mock_agent_delay_ms",
  "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model",
  "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval",
  "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent",
  "learning_step_after_review", "learning_step_before_merge", "auto_monitor",
  "auto_monitor_interval", "nudge_auto_start", "projects_base_path", "plan_auto_continue",
  "visual_verification_mode", "after_merge_verify_agent",
];

export function createPreferencesRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/preferences/active-project
  router.get("/active-project", async (c) => {
    const projectId = await getPreference("activeProjectId", database);
    return c.json({ projectId });
  });

  // PUT /api/preferences/active-project
  router.put("/active-project", async (c) => {
    const body = await c.req.json();
    await setPreference("activeProjectId", body.projectId ?? "", database);
    return c.json({ projectId: body.projectId });
  });

  // GET /api/preferences/settings — get all agent settings
  router.get("/settings", async (c) => {
    const rows = await getAllPreferences(database);
    const settings: Record<string, string> = {};
    for (const row of rows) {
      if (SETTINGS_KEYS.includes(row.key)) {
        settings[row.key] = row.value;
      }
    }
    return c.json(settings);
  });

  // PUT /api/preferences/settings — update agent settings
  router.put("/settings", async (c) => {
    const body = await c.req.json() as Record<string, string>;
    const entries = Object.entries(body)
      .filter(([key]) => SETTINGS_KEYS.includes(key))
      .map(([key, value]) => ({ key, value: value ?? "" }));
    await setPreferences(entries, database);
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
    const profiles: string[] = ["default"];
    try {
      const files = readdirSync(codexDir);
      for (const file of files) {
        const newMatch = file.match(/^(.+)\.config\.toml$/);
        if (newMatch && newMatch[1] !== "config" && newMatch[1] !== "default") profiles.push(newMatch[1]);
        const legacyMatch = file.match(/^config_(.+)\.toml$/);
        if (legacyMatch && legacyMatch[1] !== "default") profiles.push(legacyMatch[1]);
      }
    } catch {}
    return c.json({ profiles: [...new Set(profiles)].sort() });
  });

  // GET /api/preferences/copilot-profiles
  router.get("/copilot-profiles", async (c) => {
    return c.json({ profiles: [] });
  });

  return router;
}

export const preferencesRoute = createPreferencesRoute();
