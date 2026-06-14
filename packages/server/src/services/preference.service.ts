import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getPreference, setPreference, getAllPreferences, setPreferences } from "../repositories/preferences.repository.js";
import { allHarnessSettingKeys } from "./harness-settings.js";
import { commitObjectiveFile, isBoardStrategyKey, parseStrategyBullseyeConfig, PROJECT_CONDUCTOR_OBJECTIVE_RELATIVE_PATH, projectIdFromBoardStrategyKey, selectProviderFromStrategy, writeStrategyObjective } from "./strategy-objective.service.js";
import { projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { PREF_BUILDER_GUARDRAILS, PREF_MERGE_STRATEGY, PREF_PI_PROFILE, PREF_CODEX_LICENSE_RING, PREF_CODEX_LICENSE_ROTATION, PREF_CLAUDE_SUBSCRIPTION_RING, PREF_CLAUDE_SUBSCRIPTION_ROTATION } from "../constants/preference-keys.js";
import { parseCodexLicenseRing, ringProfileNames, discoverCodexHomeProfiles } from "./codex-license-ring.js";
import { parseClaudeSubscriptionRing, ringProfileNames as claudeRingProfileNames, discoverClaudeConfigDirProfiles } from "./claude-subscription-ring.js";

export const SETTINGS_KEYS = [
  "agent_command", "agent_args", "output_parser", "skip_permissions", "claude_profile",
  "codex_profile", PREF_PI_PROFILE, "copilot_profile", "provider", "default_model", "mock_agent_profile", "mock_agent_delay_ms",
  "permission_prompt_tool", "auto_review", "auto_merge", "auto_merge_in_review", "resume_with_new_model",
  "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval",
  "dependency_auto_chain",
  "dynamic_column_scaling", "card_density", "persistent_agent", "learning_step_after_agent",
  "learning_step_after_review", "learning_step_before_merge", "auto_monitor",
  "auto_monitor_interval", "nudge_auto_start", "nudge_wip_limit", "projects_base_path", "plan_auto_continue",
  "visual_verification_mode", "after_merge_verify_agent",
  PREF_BUILDER_GUARDRAILS,
  "backup_interval_min", "backup_keep_last",
  "butler_event_feed", "butler_event_feed_min_interval_ms",
  "butler_auto_answer", "butler_auto_answer_min_confidence",
  "monitor_butler_enabled", "monitor_butler_interval_min",
  "monitor_maintenance_window_enabled", "monitor_maintenance_window_end",
  "backlog_empty_strategy", "backlog_empty_skill", "backlog_empty_cooldown_min",
  "backlog_empty_last_run",
  "backlog_stale_days",
  "inprogress_stale_days",
  "stale_column_threshold_days",
  "auto_commit_strategy_objective",
  PREF_MERGE_STRATEGY,
  "issue_templates",
  "export_skills_on_registration",
  PREF_CODEX_LICENSE_RING,
  PREF_CODEX_LICENSE_ROTATION,
  PREF_CLAUDE_SUBSCRIPTION_RING,
  PREF_CLAUDE_SUBSCRIPTION_ROTATION,
  ...allHarnessSettingKeys(),
];

/** Per-project override keys (no fixed list — project IDs are dynamic). */
function isAllowedDynamicKey(key: string): boolean {
  return /^butler_event_feed_[0-9a-f-]+$/.test(key) ||
    /^tdd_mode_[0-9a-f-]+$/.test(key) ||
    /^backlog_filter_presets_[0-9a-f-]+$/.test(key) ||
    /^board_saved_views_[0-9a-f-]+$/.test(key) ||
    /^board_hidden_columns_[0-9a-f-]+$/.test(key) ||
    /^board_show_priority_legend_[0-9a-f-]+$/.test(key) ||
    /^board_recent_merges_collapsed_[0-9a-f-]+$/.test(key) ||
    /^launch_templates_[0-9a-f-]+$/.test(key) ||
    /^agent_presets_[0-9a-f-]+$/.test(key) ||
    /^monitor_policy_presets_[0-9a-f-]+$/.test(key) ||
    /^wip_limit_[0-9a-f-]+$/.test(key) ||
    /^outbound_webhook_url_[0-9a-f-]+$/.test(key) ||
    /^board_autodrive_[0-9a-f-]+$/.test(key) ||
    /^start_mode_[0-9a-f-]+$/.test(key) ||
    /^board_conductor_[0-9a-f-]+$/.test(key) ||
    /^verify_script_[0-9a-f-]+$/.test(key) ||
    /^cold_clone_check_[0-9a-f-]+$/.test(key) ||
    /^project_stack_profile_[0-9a-f-]+$/.test(key) ||
    /^auto_merge_disabled_[0-9a-f-]+$/.test(key) ||
    /^codex_cooldown_.+$/.test(key) ||
    /^claude_cooldown_.+$/.test(key) ||
    isBoardStrategyKey(key);
}

function isConductorEnabledPreference(value: string | null | undefined): boolean {
  if (!value) return false;
  if (value === "true") return true;
  try {
    const parsed = JSON.parse(value) as { enabled?: unknown };
    return parsed?.enabled === true;
  } catch {
    return false;
  }
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
    await updateStrategyObjectives(entries);
  }

  async function updateStrategyObjectives(entries: Array<{ key: string; value: string }>) {
    const strategyEntries = entries.filter((entry) => isBoardStrategyKey(entry.key));
    if (strategyEntries.length === 0) return;
    // Default ON: a Bullseye save regenerates the git-tracked objective.md, and an
    // uncommitted main checkout blocks the auto-merge queue. Opt out via the setting.
    const autoCommit = (await getPreference("auto_commit_strategy_objective", database)) !== "false";
    for (const entry of strategyEntries) {
      const projectId = projectIdFromBoardStrategyKey(entry.key);
      if (!projectId) continue;
      const projectRows = await database
        .select({ id: projects.id, name: projects.name, repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const project = projectRows[0];
      const repoPath = project?.repoPath;
      if (!repoPath) continue;
      const conductorEnabled = isConductorEnabledPreference(await getPreference(`board_conductor_${projectId}`, database));
      const changed = conductorEnabled
        ? writeStrategyObjective(repoPath, entry.value, {
            objectiveRelativePath: PROJECT_CONDUCTOR_OBJECTIVE_RELATIVE_PATH,
            createIfMissing: true,
            project,
          })
        : writeStrategyObjective(repoPath, entry.value);
      if (changed && autoCommit && !conductorEnabled) commitObjectiveFile(repoPath);
    }
  }

  async function listClaudeProfiles(): Promise<string[]> {
    const claudeDir = join(homedir(), ".claude");
    const profiles: string[] = ["mock"];
    try {
      const files = readdirSync(claudeDir);
      for (const file of files) {
        const match = file.match(/^settings_(.+)\.json$/);
        if (match && match[1] !== "mock") profiles.push(match[1]);
      }
    } catch {}
    // OAuth (Max/Pro-plan) subscriptions live as separate `~/.claude-<name>` config
    // dirs (.credentials.json), not settings files in ~/.claude. Auto-discover them so
    // they are selectable exactly like settings profiles; also merge any rotation-ring
    // names (covers custom-path / API-key ring entries that aren't a `~/.claude-<name>` dir).
    try {
      profiles.push(...discoverClaudeConfigDirProfiles());
      const ring = parseClaudeSubscriptionRing(await getPreference(PREF_CLAUDE_SUBSCRIPTION_RING, database));
      profiles.push(...claudeRingProfileNames(ring));
    } catch {}
    return [...new Set(profiles)].sort();
  }

  async function listCodexProfiles(): Promise<string[]> {
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
    // OAuth licenses live as separate `~/.codex-<name>` dirs (config.toml + auth.json),
    // not config files in ~/.codex. Auto-discover them so they are selectable exactly
    // like toml profiles; also merge any rotation-ring names (covers custom-path /
    // API-key ring entries that aren't a `~/.codex-<name>` dir).
    try {
      profiles.push(...discoverCodexHomeProfiles());
      const ring = parseCodexLicenseRing(await getPreference(PREF_CODEX_LICENSE_RING, database));
      profiles.push(...ringProfileNames(ring));
    } catch {}
    return [...new Set(profiles)].sort();
  }

  function listCopilotProfiles(): string[] {
    return ["default"];
  }

  /**
   * Detect drift between the global provider/profile settings prefs and the
   * project's Strategy Bullseye (the single authoritative source).
   *
   * When the Bullseye is set it fans out to workspace creation and (now) the butler.
   * The global prefs are a legacy write path — if they differ from what the Bullseye
   * would select, the Settings UI will silently show a stale value that doesn't match
   * actual workspace/butler behaviour.
   *
   * Returns null when no Bullseye is configured for the project (no divergence possible).
   */
  async function getProviderDivergence(projectId: string): Promise<{
    hasBullseye: boolean;
    bullseyeProvider: string | null;
    bullseyeProfile: string | null;
    settingsProvider: string | null;
    settingsProfile: string | null;
    diverged: boolean;
  }> {
    const rows = await getAllPreferences(database);
    const prefMap = new Map(rows.map(r => [r.key, r.value]));

    const strategyRaw = prefMap.get(`board_strategy_${projectId}`);
    if (!strategyRaw) {
      return { hasBullseye: false, bullseyeProvider: null, bullseyeProfile: null, settingsProvider: null, settingsProfile: null, diverged: false };
    }

    let bullseyeProvider: string | null = null;
    let bullseyeProfile: string | null = null;
    try {
      const config = parseStrategyBullseyeConfig(strategyRaw);
      const selected = selectProviderFromStrategy(config);
      if (selected) {
        bullseyeProvider = selected.provider;
        bullseyeProfile = selected.profileName || null;
      }
    } catch {
      return { hasBullseye: true, bullseyeProvider: null, bullseyeProfile: null, settingsProvider: null, settingsProfile: null, diverged: false };
    }

    const settingsProvider = prefMap.get("provider") || "claude";
    const settingsProfile = settingsProvider === "codex"
      ? (prefMap.get("codex_profile") || null)
      : settingsProvider === "pi"
        ? (prefMap.get(PREF_PI_PROFILE) || null)
      : settingsProvider === "copilot"
        ? (prefMap.get("copilot_profile") || null)
        : (prefMap.get("claude_profile") || null);

    const providerDiverged = bullseyeProvider !== null && bullseyeProvider !== settingsProvider;
    const profileDiverged = bullseyeProfile !== null && bullseyeProfile !== "" && bullseyeProfile !== settingsProfile;
    const diverged = providerDiverged || profileDiverged;

    if (diverged) {
      console.warn(`[preferences] provider divergence for project ${projectId}: Bullseye=${bullseyeProvider}:${bullseyeProfile} vs settings=${settingsProvider}:${settingsProfile}`);
    }

    return { hasBullseye: true, bullseyeProvider, bullseyeProfile, settingsProvider, settingsProfile, diverged };
  }

  return { getActiveProjectId, setActiveProjectId, getSettings, updateSettings, getProviderDivergence, listClaudeProfiles, listCodexProfiles, listCopilotProfiles };
}

export const preferenceService = createPreferenceService({ database: db });
