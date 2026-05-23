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

  // GET /api/preferences/settings â€” get all agent settings
  router.get("/settings", async (c) => {
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 4ffa36b (fix: restore projects_base_path key name in preferences allowlist)
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 9db7fe5 (feat: optional learning step after agent, after review, and before merge)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 772c692 (fix: correct projects_base_path key name and learning step poll TDZ)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> dfa93e4 (fix: restore projects_base_path key name in preferences allowlist)
<<<<<<< HEAD
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 2287b08 (feat: add projects_base_path to preferences GET/PUT allowlists)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "nudge_wip_limit", "projects_base_path"];
>>>>>>> 8c58af0 (fix: add nudge_auto_start and nudge_wip_limit to preferences allowlist)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 8e957e2 (feat: add projects_base_path to preferences GET/PUT allowlists)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 3dbb250 (feat: add projects_base_path to preferences GET/PUT allowlists)
=======
=======
>>>>>>> 93ce2f2 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
>>>>>>> 91ff1d0 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
>>>>>>> 0dbfd69 (feat: add projects_base_path to preferences GET/PUT allowlists)
=======
>>>>>>> 52ec041 (feat: optional learning step after agent, after review, and before merge)
=======
>>>>>>> dedc21e (fix: correct projects_base_path key name and learning step poll TDZ)
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 650d5c4 (feat: implement create project flow (WIP - UI + backend route))
<<<<<<< HEAD
>>>>>>> ec12683 (feat: implement create project flow (WIP - UI + backend route))
=======
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_folder"];
>>>>>>> 5610567 (WIP: uncommitted changes in SettingsPanel and register-project test)
<<<<<<< HEAD
>>>>>>> 93ce2f2 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 080a454 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
<<<<<<< HEAD
>>>>>>> 91ff1d0 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> c1e84af (feat: add projects_base_path to preferences GET/PUT allowlists)
<<<<<<< HEAD
>>>>>>> 0dbfd69 (feat: add projects_base_path to preferences GET/PUT allowlists)
=======
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 9db7fe5 (feat: optional learning step after agent, after review, and before merge)
<<<<<<< HEAD
>>>>>>> 52ec041 (feat: optional learning step after agent, after review, and before merge)
=======
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 772c692 (fix: correct projects_base_path key name and learning step poll TDZ)
>>>>>>> dedc21e (fix: correct projects_base_path key name and learning step poll TDZ)
=======
>>>>>>> 4ffa36b (fix: restore projects_base_path key name in preferences allowlist)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 2d71bd2 (fix: resolve merge conflict markers by restoring stale files from master)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "projects_base_path"];
>>>>>>> 3dd19d7 (fix: add nudge_auto_start to preferences whitelist and DEFAULT_SETTINGS)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "mock_agent_profile", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "projects_base_path"];
>>>>>>> d4d13ec (test: E2E coverage for agent task progress bar on issue cards)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "mock_agent", "mock_agent_profile", "mock_agent_delay_ms", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "projects_base_path"];
>>>>>>> ab969b7 (fix(e2e): add global teardown to clean up leaked test artifact issues)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "projects_base_path"];
>>>>>>> fa5c472 (feat: convert mock-agent setting to built-in mock Claude profile)
=======
    const keys = ["agent_command", "agent_args", "output_parser", "skip_permissions", "claude_profile", "mock_agent_profile", "mock_agent_delay_ms", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "projects_base_path"];
>>>>>>> 339c03b (feat: wire mock_agent_profile and mock_agent_delay_ms preferences to mock agent)
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

  // PUT /api/preferences/settings â€” update agent settings
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
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 4ffa36b (fix: restore projects_base_path key name in preferences allowlist)
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 9db7fe5 (feat: optional learning step after agent, after review, and before merge)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 772c692 (fix: correct projects_base_path key name and learning step poll TDZ)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> dfa93e4 (fix: restore projects_base_path key name in preferences allowlist)
<<<<<<< HEAD
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 2287b08 (feat: add projects_base_path to preferences GET/PUT allowlists)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "nudge_wip_limit", "projects_base_path"];
>>>>>>> 8c58af0 (fix: add nudge_auto_start and nudge_wip_limit to preferences allowlist)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 8e957e2 (feat: add projects_base_path to preferences GET/PUT allowlists)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 3dbb250 (feat: add projects_base_path to preferences GET/PUT allowlists)
=======
=======
>>>>>>> 93ce2f2 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
>>>>>>> 91ff1d0 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
>>>>>>> 0dbfd69 (feat: add projects_base_path to preferences GET/PUT allowlists)
=======
>>>>>>> 52ec041 (feat: optional learning step after agent, after review, and before merge)
=======
>>>>>>> dedc21e (fix: correct projects_base_path key name and learning step poll TDZ)
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 650d5c4 (feat: implement create project flow (WIP - UI + backend route))
<<<<<<< HEAD
>>>>>>> ec12683 (feat: implement create project flow (WIP - UI + backend route))
=======
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_folder"];
>>>>>>> 5610567 (WIP: uncommitted changes in SettingsPanel and register-project test)
<<<<<<< HEAD
>>>>>>> 93ce2f2 (WIP: uncommitted changes in SettingsPanel and register-project test)
=======
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 080a454 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
<<<<<<< HEAD
>>>>>>> 91ff1d0 (fix: unify projects_base_dir preference key across preferences route, projects route, and SettingsPanel)
=======
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> c1e84af (feat: add projects_base_path to preferences GET/PUT allowlists)
<<<<<<< HEAD
>>>>>>> 0dbfd69 (feat: add projects_base_path to preferences GET/PUT allowlists)
=======
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_dir"];
>>>>>>> 9db7fe5 (feat: optional learning step after agent, after review, and before merge)
<<<<<<< HEAD
>>>>>>> 52ec041 (feat: optional learning step after agent, after review, and before merge)
=======
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 772c692 (fix: correct projects_base_path key name and learning step poll TDZ)
>>>>>>> dedc21e (fix: correct projects_base_path key name and learning step poll TDZ)
=======
>>>>>>> 4ffa36b (fix: restore projects_base_path key name in preferences allowlist)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "projects_base_path"];
>>>>>>> 2d71bd2 (fix: resolve merge conflict markers by restoring stale files from master)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "projects_base_path"];
>>>>>>> 3dd19d7 (fix: add nudge_auto_start to preferences whitelist and DEFAULT_SETTINGS)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "mock_agent_profile", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "projects_base_path"];
>>>>>>> d4d13ec (test: E2E coverage for agent task progress bar on issue cards)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "mock_agent", "mock_agent_profile", "mock_agent_delay_ms", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "projects_base_path"];
>>>>>>> ab969b7 (fix(e2e): add global teardown to clean up leaked test artifact issues)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "skip_permissions", "claude_profile", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "projects_base_path"];
>>>>>>> fa5c472 (feat: convert mock-agent setting to built-in mock Claude profile)
=======
    const allowedKeys = ["agent_command", "agent_args", "output_parser", "skip_permissions", "claude_profile", "mock_agent_profile", "mock_agent_delay_ms", "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model", "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval", "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent", "learning_step_after_review", "learning_step_before_merge", "auto_monitor", "auto_monitor_interval", "nudge_auto_start", "projects_base_path"];
>>>>>>> 339c03b (feat: wire mock_agent_profile and mock_agent_delay_ms preferences to mock agent)

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

  // GET /api/preferences/claude-profiles â€” list available claude profiles
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

  return router;
}

export const preferencesRoute = createPreferencesRoute();

