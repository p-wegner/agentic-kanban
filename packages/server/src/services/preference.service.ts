import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getPreference, setPreference, getAllPreferences, setPreferences } from "../repositories/preferences.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { allHarnessSettingKeys } from "./harness-settings.js";
import { commitObjectiveFile, isBoardStrategyKey, parseStrategyBullseyeConfig, PROJECT_CONDUCTOR_OBJECTIVE_RELATIVE_PATH, projectIdFromBoardStrategyKey, selectProviderFromStrategy, writeStrategyObjective } from "./strategy-objective.service.js";
import { PREF_BUILDER_GUARDRAILS, PREF_MERGE_STRATEGY, PREF_PI_PROFILE, PREF_CODEX_LICENSE_RING, PREF_CODEX_LICENSE_ROTATION, PREF_CLAUDE_SUBSCRIPTION_RING, PREF_CLAUDE_SUBSCRIPTION_ROTATION } from "../constants/preference-keys.js";
import { parseCodexLicenseRing, ringProfileNames, discoverCodexHomeProfiles } from "./codex-license-ring.js";
import { parseClaudeSubscriptionRing, ringProfileNames as claudeRingProfileNames, discoverClaudeConfigDirProfiles } from "./claude-subscription-ring.js";
import { getProfilePrefKey } from "./agent-provider.js";
import { isProjectScopedDynamicKey } from "../lib/dynamic-preference-keys.js";

export const SETTINGS_KEYS = [
  "agent_command", "agent_args", "output_parser", "skip_permissions", "claude_profile",
  "codex_profile", PREF_PI_PROFILE, "copilot_profile", "provider", "default_model", "mock_agent_profile", "mock_agent_delay_ms",
  "permission_prompt_tool", "auto_review", "auto_merge", "auto_merge_in_review", "resume_with_new_model",
  "review_auto_fix", "disabled_mcp_tools", "auto_start_followup", "require_manual_approval",
  // auto_rebase_on_continue: read by workspace-session.service before relaunch.
  // skip_preflight: defaults the per-launch preflight toggle in CreateWorkspaceForm.
  // Both are surfaced as toggles in SettingsPanel but were absent here, so updateSettings
  // silently dropped writes to them — the toggles could never persist.
  "auto_rebase_on_continue", "skip_preflight",
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

/**
 * Per-project / per-name override keys (no fixed list — project IDs are dynamic).
 * The prefix table lives in lib/dynamic-preference-keys.ts; the board-strategy key
 * is ORed in here because its predicate is normalize-aware (kept out of the leaf).
 */
function isAllowedDynamicKey(key: string): boolean {
  return isProjectScopedDynamicKey(key) || isBoardStrategyKey(key);
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

  /**
   * Persist the allowed settings and report which keys were rejected.
   *
   * A key not in SETTINGS_KEYS (and not matching isAllowedDynamicKey) used to be
   * SILENTLY DROPPED — the toggle appeared to work but never persisted (this bit
   * auto_rebase_on_continue and skip_preflight). Valid keys are still applied, but
   * the dropped keys are returned so the caller can fail loudly instead of no-op'ing
   * (ticket #874). SETTINGS_KEYS is a hand-maintained whitelist that must stay in
   * sync with the client Settings interface + DEFAULT_SETTINGS, so a mistyped or
   * un-registered key is almost always a bug worth surfacing.
   */
  async function updateSettings(body: Record<string, string>): Promise<{ applied: string[]; dropped: string[] }> {
    const applied: string[] = [];
    const dropped: string[] = [];
    for (const key of Object.keys(body)) {
      if (SETTINGS_KEYS.includes(key) || isAllowedDynamicKey(key)) applied.push(key);
      else dropped.push(key);
    }
    const entries = applied.map((key) => ({ key, value: body[key] ?? "" }));
    await setPreferences(entries, database);
    await updateStrategyObjectives(entries);
    return { applied, dropped };
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
      const project = await getProjectById(projectId, database);
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

  async function listPiProfiles(): Promise<string[]> {
    const profiles: string[] = ["default"];
    try {
      const files = readdirSync(homedir());
      for (const file of files) {
        const match = file.match(/^\.pi-(.+)$/);
        if (!match || match[1] === "agent" || match[1] === "default") continue;
        try {
          if (statSync(join(homedir(), file)).isDirectory()) profiles.push(match[1]);
        } catch {}
      }
    } catch {}
    try {
      const selected = await getPreference(PREF_PI_PROFILE, database);
      if (selected?.trim()) profiles.push(selected.trim());
    } catch {}
    return [...new Set(profiles)].sort();
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
    const settingsProfile = prefMap.get(getProfilePrefKey(settingsProvider)) || null;

    const providerDiverged = bullseyeProvider !== null && bullseyeProvider !== settingsProvider;
    const profileDiverged = bullseyeProfile !== null && bullseyeProfile !== "" && bullseyeProfile !== settingsProfile;
    const diverged = providerDiverged || profileDiverged;

    if (diverged) {
      console.warn(`[preferences] provider divergence for project ${projectId}: Bullseye=${bullseyeProvider}:${bullseyeProfile} vs settings=${settingsProvider}:${settingsProfile}`);
    }

    return { hasBullseye: true, bullseyeProvider, bullseyeProfile, settingsProvider, settingsProfile, diverged };
  }

  return { getActiveProjectId, setActiveProjectId, getSettings, updateSettings, getProviderDivergence, listClaudeProfiles, listCodexProfiles, listCopilotProfiles, listPiProfiles };
}

export const preferenceService = createPreferenceService({ database: db });
