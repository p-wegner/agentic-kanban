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
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 650d5c4 (feat: implement create project flow (WIP - UI + backend route))
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_folder"];
>>>>>>> 5610567 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 080a454 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> c1e84af (feat: add projects_base_path to preferences GET/PUT allowlists)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 9db7fe5 (feat: optional learning step after agent, after review, and before merge)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 772c692 (fix: correct projects_base_path key name and learning step poll TDZ)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> dfa93e4 (fix: restore projects_base_path key name in preferences allowlist)
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
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 650d5c4 (feat: implement create project flow (WIP - UI + backend route))
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_folder"];
>>>>>>> 5610567 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 080a454 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> c1e84af (feat: add projects_base_path to preferences GET/PUT allowlists)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 9db7fe5 (feat: optional learning step after agent, after review, and before merge)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 772c692 (fix: correct projects_base_path key name and learning step poll TDZ)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> dfa93e4 (fix: restore projects_base_path key name in preferences allowlist)

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
    const profiles: string[] = [];
    try {
      const files = readdirSync(claudeDir);
      for (const file of files) {
        const match = file.match(/^settings_(.+)\.json$/);
        if (match) profiles.push(match[1]);
      }
    } catch {}
    return c.json({ profiles: profiles.sort() });
  });

  return router;
}

export const preferencesRoute = createPreferencesRoute();
