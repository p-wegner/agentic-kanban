import { readdirSync, statSync } from "node:fs";
import { parseBoolSetting } from "@agentic-kanban/shared/lib/settings-registry";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getPreference, setPreference, getAllPreferences, setPreferences } from "../repositories/preferences.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { allHarnessSettingKeys } from "./harness-settings.js";
import { SETTINGS_REGISTRY_KEYS } from "@agentic-kanban/shared/lib/settings-registry";
import { commitObjectiveFile, isBoardStrategyKey, PROJECT_CONDUCTOR_OBJECTIVE_RELATIVE_PATH, projectIdFromBoardStrategyKey, writeStrategyObjective } from "./strategy-objective.service.js";
import {
  PREF_CLAUDE_SUBSCRIPTION_RING,
  PREF_CODEX_LICENSE_RING,
  PREF_PI_PROFILE,
} from "../constants/preference-keys.js";
import { parseCodexLicenseRing, ringProfileNames, discoverCodexHomeProfiles } from "./codex-license-ring.js";
import { parseClaudeSubscriptionRing, ringProfileNames as claudeRingProfileNames, discoverClaudeConfigDirProfiles } from "./claude-subscription-ring.js";
import { isProjectScopedDynamicKey } from "../lib/dynamic-preference-keys.js";
import { resolveProviderDivergence } from "./project-runtime-config.service.js";
import type { ProviderName } from "./agent-provider.js";

/**
 * The write/read whitelist for global settings — DERIVED from the single source of
 * truth (`SETTINGS_REGISTRY` in `@agentic-kanban/shared/lib/settings-registry`) plus
 * the dynamic per-harness keys (`allHarnessSettingKeys()`, which lives next to the
 * harness defaults). Adding a setting is now a ONE-place edit in the registry — the
 * key, its default, and the `Settings` TS type all derive from that entry, so a
 * missing/typo'd key is a compile error rather than a runtime 422 (#903).
 *
 * The parity test `settings-registry-keys.test.ts` asserts this list equals the
 * registry keys (+ harness keys) so the two never drift.
 */
export const SETTINGS_KEYS: string[] = [
  ...SETTINGS_REGISTRY_KEYS,
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

/**
 * Returned (non-null) by `updateSettings` when the write-time divergence guard (#903)
 * rejects a provider/profile write that would drift from the active project's Bullseye.
 * No preferences are persisted when this is present.
 */
export interface ProviderDivergenceRejection {
  projectId: string;
  bullseyeProvider: string | null;
  bullseyeProfile: string | null;
  settingsProvider: string | null;
  settingsProfile: string | null;
}

/**
 * Provider/profile keys that participate in Bullseye divergence. A write that does
 * not touch any of these can never CREATE divergence, so the guard skips it (an
 * unrelated toggle save must never be blocked by a pre-existing, untouched drift).
 * Exported so other write paths (the CLI's `preferences set`, #973) can route
 * exactly these keys through the guarded `updateSettings` instead of the raw
 * repository `setPreference`.
 */
export const PROVIDER_DIVERGENCE_KEYS: ReadonlySet<string> = new Set([
  "provider",
  "claude_profile",
  "codex_profile",
  "copilot_profile",
  "pi_profile",
]);

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
   * (ticket #874). SETTINGS_KEYS is now DERIVED from the typed settings registry
   * (#903), so a mistyped or un-registered key is a compile error at the call site
   * and a 422 on the wire.
   *
   * WRITE-TIME DIVERGENCE GUARD (#903): a write that touches the provider/profile
   * settings prefs (`provider`, `*_profile`) and would put them OUT OF SYNC with the
   * active project's Strategy Bullseye is REJECTED before anything is persisted —
   * `divergence` is returned non-null and no rows are written. This turns the old
   * passive Settings banner (`resolveProviderDivergence`) into an enforced invariant,
   * retiring the set-provider-default skill's reason to exist: the prefs can no longer
   * drift from the Bullseye in the first place.
   */
  async function updateSettings(body: Record<string, string>): Promise<{
    applied: string[];
    dropped: string[];
    divergence: ProviderDivergenceRejection | null;
  }> {
    const applied: string[] = [];
    const dropped: string[] = [];
    for (const key of Object.keys(body)) {
      if (SETTINGS_KEYS.includes(key) || isAllowedDynamicKey(key)) applied.push(key);
      else dropped.push(key);
    }
    const entries = applied.map((key) => ({ key, value: body[key] ?? "" }));

    const divergence = await checkProviderDivergenceGuard(entries);
    if (divergence) return { applied: [], dropped, divergence };

    await setPreferences(entries, database);
    await updateStrategyObjectives(entries);
    return { applied, dropped, divergence: null };
  }

  async function checkProviderDivergenceGuard(
    entries: Array<{ key: string; value: string }>,
  ): Promise<ProviderDivergenceRejection | null> {
    if (!entries.some((e) => PROVIDER_DIVERGENCE_KEYS.has(e.key))) return null;

    const projectId = await getActiveProjectId();
    if (!projectId) return null;

    // Project the write onto the current prefs and ask whether the RESULT diverges.
    const rows = await getAllPreferences(database);
    const projected = new Map(rows.map((r) => [r.key, r.value]));
    for (const e of entries) projected.set(e.key, e.value);

    const result = resolveProviderDivergence(projected, projectId);
    if (!result.hasBullseye || !result.diverged) return null;

    return {
      projectId,
      bullseyeProvider: result.bullseyeProvider,
      bullseyeProfile: result.bullseyeProfile,
      settingsProvider: result.settingsProvider,
      settingsProfile: result.settingsProfile,
    };
  }

  async function updateStrategyObjectives(entries: Array<{ key: string; value: string }>) {
    const strategyEntries = entries.filter((entry) => isBoardStrategyKey(entry.key));
    if (strategyEntries.length === 0) return;
    // Default ON: a Bullseye save regenerates the git-tracked objective.md, and an
    // uncommitted main checkout blocks the auto-merge queue. Opt out via the setting.
    const autoCommit = parseBoolSetting("auto_commit_strategy_objective", await getPreference("auto_commit_strategy_objective", database));
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

  /** The available profiles for any provider — dispatches to the per-provider lister
   *  via a provider-keyed record (no `=== "codex"` ladders). Used by the butler and
   *  any other caller that has a resolved `ProviderName` rather than a fixed provider. */
  async function listProfilesForProvider(provider: ProviderName): Promise<string[]> {
    const listers: Record<ProviderName, () => Promise<string[]> | string[]> = {
      claude: listClaudeProfiles,
      codex: listCodexProfiles,
      copilot: listCopilotProfiles,
      pi: listPiProfiles,
    };
    return listers[provider]();
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

    const result = resolveProviderDivergence(prefMap, projectId);

    if (result.diverged) {
      console.warn(`[preferences] provider divergence for project ${projectId}: Bullseye=${result.bullseyeProvider}:${result.bullseyeProfile} vs settings=${result.settingsProvider}:${result.settingsProfile}`);
    }

    return result;
  }

  return { getActiveProjectId, setActiveProjectId, getSettings, updateSettings, getProviderDivergence, listClaudeProfiles, listCodexProfiles, listCopilotProfiles, listPiProfiles, listProfilesForProvider };
}

export const preferenceService = createPreferenceService({ database: db });
