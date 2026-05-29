import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getPreference, setPreference, getAllPreferences, setPreferences } from "../repositories/preferences.repository.js";
import { allHarnessSettingKeys } from "./harness-settings.js";

export const SETTINGS_KEYS = [
  "agent_command", "agent_args", "output_parser", "skip_permissions", "claude_profile",
  "codex_profile", "copilot_profile", "provider", "default_model", "mock_agent_profile", "mock_agent_delay_ms",
  "permission_prompt_tool", "auto_review", "auto_merge", "resume_with_new_model",
  "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval",
  "dynamic_column_scaling", "persistent_agent", "learning_step_after_agent",
  "learning_step_after_review", "learning_step_before_merge", "auto_monitor",
  "auto_monitor_interval", "nudge_auto_start", "projects_base_path", "plan_auto_continue",
  "visual_verification_mode", "after_merge_verify_agent",
  "backup_interval_min", "backup_keep_last",
  "butler_event_feed", "butler_event_feed_min_interval_ms",
  "auto_rebase_on_continue",
  ...allHarnessSettingKeys(),
];

/** Per-project override keys (no fixed list — project IDs are dynamic). */
function isAllowedDynamicKey(key: string): boolean {
  return /^butler_event_feed_[0-9a-f-]+$/.test(key);
}

export function createPreferenceService({ database }: { database: Database }) {
  async function getActiveProjectId() {
    return getPreference("activeProjectId", database);
  }

  async function setActiveProjectId(projectId: string) {
    await setPreference("activeProjectId", projectId, database);
  }

  async function getSettings() {
    const rows = await getAllPreferences(database);
    const settings: Record<string, string> = {};
    for (const row of rows) {
      if (SETTINGS_KEYS.includes(row.key) || isAllowedDynamicKey(row.key)) {
        settings[row.key] = row.value;
      }
    }
    return settings;
  }

  async function updateSettings(body: Record<string, string>) {
    const entries = Object.entries(body)
      .filter(([key]) => SETTINGS_KEYS.includes(key) || isAllowedDynamicKey(key))
      .map(([key, value]) => ({ key, value: value ?? "" }));
    await setPreferences(entries, database);
  }

  function listClaudeProfiles(): string[] {
    const claudeDir = join(homedir(), ".claude");
    const profiles: string[] = ["mock"];
    try {
      const files = readdirSync(claudeDir);
      for (const file of files) {
        const match = file.match(/^settings_(.+)\.json$/);
        if (match && match[1] !== "mock") profiles.push(match[1]);
      }
    } catch {}
    return profiles.sort();
  }

  function listCodexProfiles(): string[] {
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
    return [...new Set(profiles)].sort();
  }

  return { getActiveProjectId, setActiveProjectId, getSettings, updateSettings, listClaudeProfiles, listCodexProfiles };
}

export const preferenceService = createPreferenceService({ database: db });
