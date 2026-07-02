import { isAutoMergeEnabled } from "@agentic-kanban/shared/lib/auto-merge-pref";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import { AUTO_REVIEW_PREF_KEY, isAutoReviewEnabled } from "@agentic-kanban/shared/lib/auto-review-pref";
import type { Database } from "../db/index.js";
import { getAllPreferences } from "../repositories/preferences.repository.js";
import { PREF_BUILDER_GUARDRAILS, DEFAULT_BUILDER_GUARDRAILS } from "../constants/preference-keys.js";
import type { ProviderName } from "./agent-provider.js";
import { narrowProviderName } from "./agent-provider.js";
import type { ResolvedProviderConfig } from "./provider-config-resolution.js";
import { resolveProviderConfig } from "./provider-config-resolution.js";
import {
  parseStrategyBullseyeConfig,
  selectProviderFromStrategy,
  resolveStrategyProviderSelection,
} from "./strategy-objective.service.js";
import { providerProfilePrefKey, readSettingsProviderSelection } from "@agentic-kanban/shared/lib/strategy-policy";
import { resolveStartPolicy, startModePrefKey, type StartPolicy } from "./start-policy.service.js";
import { HARNESS_IDS, harnessSettingKey } from "./harness-settings.js";

export function autodrivePrefKey(projectId: string): string {
  return `board_autodrive_${projectId}`;
}

export function autoMergeDisabledPrefKey(projectId: string): string {
  return `auto_merge_disabled_${projectId}`;
}

export interface RuntimeProviderConfig extends ResolvedProviderConfig {
  source: "explicit-profile" | "legacy-claude-profile" | "strategy" | "workspace" | "settings";
  strategySelection: { provider: ProviderName; profileName: string; model?: string } | null;
  settingsSelection: { provider: ProviderName; profileName: string | null };
}

export interface RuntimeDriveConfig {
  enabled: boolean;
  autoMergeDisabled: boolean;
  autoReview: boolean;
  autoMerge: boolean;
  planAutoContinue: boolean;
}

export interface RuntimeMonitorConfig {
  autoMerge: boolean;
  autoMergeInReview: boolean;
  autoMergeDisabled: boolean;
  maintenanceWindowEnabled: boolean;
  maintenanceWindowEnd: string | null;
}

export interface ProjectRuntimeConfig {
  projectId: string;
  provider: RuntimeProviderConfig;
  startPolicy: StartPolicy;
  drive: RuntimeDriveConfig;
  monitor: RuntimeMonitorConfig;
  systemInstructions: string;
}

export interface ProjectRuntimeConfigInput {
  projectId: string;
  prefMap: Map<string, string>;
  profileOverride?: { provider?: string; name?: string } | null;
  legacyProfileOverride?: string | null;
  strategySelection?: { provider: ProviderName; profileName: string; model?: string } | null;
  workspaceSelection?: { provider?: string | null; profileName?: string | null } | null;
  requestedModel?: string | null;
  commandOverride?: string;
}

function readSettingsSelection(prefMap: Map<string, string>): { provider: ProviderName; profileName: string | null } {
  // Selection core shared with the MCP start_workspace tool (#984): the global
  // `provider` pref + that provider's own `<provider>_profile` key.
  return readSettingsProviderSelection(prefMap);
}

function resolveProviderSource(input: ProjectRuntimeConfigInput): RuntimeProviderConfig["source"] {
  if (input.profileOverride?.name) return "explicit-profile";
  if (input.legacyProfileOverride) return "legacy-claude-profile";
  if (input.strategySelection) return "strategy";
  if (input.workspaceSelection?.provider) return "workspace";
  return "settings";
}

function applyWorkspaceSelection(
  prefMap: Map<string, string>,
  workspaceSelection: ProjectRuntimeConfigInput["workspaceSelection"],
): void {
  if (!workspaceSelection?.provider) return;
  const provider = narrowProviderName(workspaceSelection.provider);
  prefMap.set("provider", provider);
  const profileName = workspaceSelection.profileName?.trim();
  if (!profileName) return;
  prefMap.set(providerProfilePrefKey(provider), profileName);
}

export function resolveProjectRuntimeConfig(input: ProjectRuntimeConfigInput): ProjectRuntimeConfig {
  const providerPrefMap = new Map(input.prefMap);
  if (!input.profileOverride?.name && !input.legacyProfileOverride && !input.strategySelection) {
    applyWorkspaceSelection(providerPrefMap, input.workspaceSelection);
  }

  const provider = resolveProviderConfig({
    prefMap: providerPrefMap,
    profileOverride: input.profileOverride,
    legacyProfileOverride: input.legacyProfileOverride,
    strategySelection: input.strategySelection,
    requestedModel: input.requestedModel ?? input.strategySelection?.model,
    commandOverride: input.commandOverride,
  });
  const startPolicy = resolveStartPolicy(input.prefMap, input.projectId);
  const autoMerge = isAutoMergeEnabled(input.prefMap);
  const autoMergeDisabled = input.prefMap.get(autoMergeDisabledPrefKey(input.projectId)) === "true";

  return {
    projectId: input.projectId,
    provider: {
      ...provider,
      source: resolveProviderSource(input),
      strategySelection: input.strategySelection ?? null,
      settingsSelection: readSettingsSelection(input.prefMap),
    },
    startPolicy,
    drive: {
      enabled: input.prefMap.get(autodrivePrefKey(input.projectId)) === "true",
      autoMergeDisabled,
      autoReview: isAutoReviewEnabled(input.prefMap.get(AUTO_REVIEW_PREF_KEY)),
      autoMerge,
      planAutoContinue: HARNESS_IDS.every((harness) => input.prefMap.get(harnessSettingKey(harness, "plan_auto_continue")) === "true"),
    },
    monitor: {
      autoMerge,
      autoMergeInReview: getBool(input.prefMap, "auto_merge_in_review"),
      autoMergeDisabled,
      maintenanceWindowEnabled: getBool(input.prefMap, "monitor_maintenance_window_enabled"),
      maintenanceWindowEnd: input.prefMap.get("monitor_maintenance_window_end") || null,
    },
    systemInstructions: input.prefMap.get(PREF_BUILDER_GUARDRAILS) ?? DEFAULT_BUILDER_GUARDRAILS,
  };
}

export async function loadProjectRuntimeConfig(
  database: Database,
  input: Omit<ProjectRuntimeConfigInput, "prefMap" | "strategySelection">,
): Promise<ProjectRuntimeConfig> {
  const rows = await getAllPreferences(database);
  const prefMap = new Map(rows.map((r) => [r.key, r.value]));
  const hasOverride = Boolean(input.profileOverride?.name) || Boolean(input.legacyProfileOverride);
  const strategySelection = !hasOverride
    ? await resolveStrategyProviderSelection(database, input.projectId)
    : null;
  return resolveProjectRuntimeConfig({ ...input, prefMap, strategySelection });
}

export function buildDriveRuntimePreferencePatch(
  projectId: string,
  enabled: boolean,
): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [
    { key: autodrivePrefKey(projectId), value: enabled ? "true" : "false" },
    { key: autoMergeDisabledPrefKey(projectId), value: enabled ? "false" : "true" },
    { key: startModePrefKey(projectId), value: enabled ? "monitor" : "manual" },
  ];
  if (!enabled) return entries;
  entries.push({ key: "auto_review", value: "true" });
  entries.push({ key: "auto_merge", value: "true" });
  for (const harness of HARNESS_IDS) {
    entries.push({ key: harnessSettingKey(harness, "plan_auto_continue"), value: "true" });
  }
  return entries;
}

export function resolveProviderDivergence(prefMap: Map<string, string>, projectId: string): {
  hasBullseye: boolean;
  bullseyeProvider: string | null;
  bullseyeProfile: string | null;
  settingsProvider: string | null;
  settingsProfile: string | null;
  diverged: boolean;
} {
  const strategyRaw = prefMap.get(`board_strategy_${projectId}`);
  if (!strategyRaw) {
    return { hasBullseye: false, bullseyeProvider: null, bullseyeProfile: null, settingsProvider: null, settingsProfile: null, diverged: false };
  }

  let bullseyeProvider: string | null = null;
  let bullseyeProfile: string | null = null;
  try {
    const selected = selectProviderFromStrategy(parseStrategyBullseyeConfig(strategyRaw));
    if (selected) {
      bullseyeProvider = selected.provider;
      bullseyeProfile = selected.profileName || null;
    }
  } catch {
    return { hasBullseye: true, bullseyeProvider: null, bullseyeProfile: null, settingsProvider: null, settingsProfile: null, diverged: false };
  }

  const settingsSelection = readSettingsSelection(prefMap);
  const settingsProvider = settingsSelection.provider;
  const settingsProfile = settingsSelection.profileName;
  const providerDiverged = bullseyeProvider !== null && bullseyeProvider !== settingsProvider;
  const profileDiverged = bullseyeProfile !== null && bullseyeProfile !== "" && bullseyeProfile !== settingsProfile;
  return {
    hasBullseye: true,
    bullseyeProvider,
    bullseyeProfile,
    settingsProvider,
    settingsProfile,
    diverged: providerDiverged || profileDiverged,
  };
}
