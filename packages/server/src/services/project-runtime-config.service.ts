import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { isAutomaticMergeEnabled } from "@agentic-kanban/shared/lib/merge-policy";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import { AUTO_REVIEW_PREF_KEY, isAutoReviewEnabled } from "@agentic-kanban/shared/lib/auto-review-pref";
import type { Database } from "../db/index.js";
import { getAllPreferences } from "../repositories/preferences.repository.js";
import {
  PREF_BUILDER_GUARDRAILS,
  DEFAULT_BUILDER_GUARDRAILS,
  PREF_CLAUDE_SUBSCRIPTION_RING,
  PREF_CODEX_LICENSE_RING,
} from "../constants/preference-keys.js";
import { loadObservedGlobalRoster } from "./profile-roster.service.js";
import type { ProviderName } from "./agent-provider.js";
import { narrowProviderName } from "./agent-provider.js";
import type { ResolvedProviderConfig } from "./provider-config-resolution.js";
import { resolveProviderConfig } from "./provider-config-resolution.js";
import {
  resolveStrategyProviderSelection,
} from "./strategy-objective.service.js";
import { providerProfilePrefKey, readSettingsProviderSelection, resolveProviderDivergence as resolveProviderDivergenceShared } from "@agentic-kanban/shared/lib/strategy-policy";
import { resolveStartPolicy, startModePrefKey, type StartPolicy } from "./start-policy.service.js";
import type {
  ParsedProfileAllowlist,
  ParsedRoster,
  ProfileHeadroom,
  RosterEntry,
} from "@agentic-kanban/shared/lib/profile-allowlist";
import {
  allowedProfilesPrefKey,
  parseProfileAllowlist,
  resolvePoolExhaustedPct,
  resolveProjectRoster,
  resolveReserveAllowance,
  rosterPrefKey,
} from "@agentic-kanban/shared/lib/profile-allowlist";
import { requiredDataLabelsPrefKey } from "@agentic-kanban/shared/lib/profile-capabilities";
import { HARNESS_IDS, harnessSettingKey } from "./harness-settings.js";

import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
// #496: built from the registry, so an unregistered prefix is a COMPILE error.
const autodrivePrefDef = projectPref("board_autodrive");
const autoMergeDisabledPrefDef = projectPref("auto_merge_disabled");

export function autodrivePrefKey(projectId: string): string {
  return autodrivePrefDef.key(projectId);
}

/**
 * The per-project profile-allowlist key. Absent/empty ⇒ the project is unrestricted.
 * Re-exported from shared so the Settings editor and this resolver cannot disagree about
 * the key they write and read — the `verify_script_<id>` family drifted exactly that way.
 */
export {
  allowedProfilesPrefKey,
  reserveAllowedPrefKey,
  rosterExhaustedPctPrefKey,
  rosterPrefKey,
} from "@agentic-kanban/shared/lib/profile-allowlist";

export function autoMergeDisabledPrefKey(projectId: string): string {
  return autoMergeDisabledPrefDef.key(projectId);
}

export interface RuntimeProviderConfig extends ResolvedProviderConfig {
  source: "explicit-profile" | "legacy-claude-profile" | "strategy" | "workspace" | "settings";
  strategySelection: { provider: ProviderName; profileName: string; model?: string } | null;
  settingsSelection: { provider: ProviderName; profileName: string | null };
  /**
   * The project's profile allowlist as parsed. `restricted: false` for the vast majority
   * of projects. Exposed so callers can explain a hold, and so the Settings UI can render
   * the same parse the resolver used.
   */
  allowlist: ParsedProfileAllowlist;
  /**
   * The project's profile ROSTER (#1025) — the allowlist with roles, after the observed
   * global roles have been narrowed by `roster_<projectId>`. `restricted: false` for the
   * vast majority of projects, and identical in effect to the allowlist whenever no
   * profile declares a role. Exposed so the Monitor view can explain a hold, a refusal or
   * a reserve start with the same parse the resolver used.
   */
  roster: ParsedRoster;
  /** Whether this launch was permitted to reach for a `reserve` profile, and on what grant. */
  reserveAllowed: boolean;
  reserveAllowedReason: string | null;
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
  /**
   * The GLOBAL roster (#1025): every profile discovery knows about, with the role it
   * declares for itself (`profile-attributes.ts`). Omitted = nobody declared anything, and
   * the resolver then behaves exactly as it did before rosters existed.
   */
  globalRoster?: readonly RosterEntry[] | null;
  /** This project's slug, for a profile dedicated to one project (`KANBAN_PROFILE_DEDICATED`). */
  projectSlug?: string | null;
  /** Per-profile 5-hour-window readings, for ordering the pool by remaining headroom. */
  headroom?: Map<string, ProfileHeadroom> | null;
  /** The starting ticket's tags — `reserve:ok` is one of the three reserve grants. */
  issueTags?: readonly string[] | null;
  /** A human explicitly started this work — the third reserve grant. */
  operatorStart?: boolean;
  /** Injected clock for the allowlist's cooldown checks (`nowMs` spelling, #614). */
  nowMs?: number;
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

  // Read from the ORIGINAL prefMap: the allowlist is the project's own restriction and
  // must not be reachable by anything the selectors mirror onto `providerPrefMap`.
  const allowlistRaw = input.prefMap.get(allowedProfilesPrefKey(input.projectId));
  const allowlist = parseProfileAllowlist(allowlistRaw);
  // #1025: the roster is the same restriction with roles. It is built here, in the ONE
  // enforcement seam, and the raw keys are read nowhere else (`roster-raw-read-ratchet`).
  const roster = resolveProjectRoster({
    globalRoster: input.globalRoster,
    rosterRaw: input.prefMap.get(rosterPrefKey(input.projectId)),
    allowlistRaw,
    projectSlug: input.projectSlug,
  });
  const reserve = resolveReserveAllowance({
    prefMap: input.prefMap,
    projectId: input.projectId,
    issueTags: input.issueTags,
    operatorStart: input.operatorStart,
  });

  const provider = resolveProviderConfig({
    prefMap: providerPrefMap,
    profileOverride: input.profileOverride,
    legacyProfileOverride: input.legacyProfileOverride,
    strategySelection: input.strategySelection,
    requestedModel: input.requestedModel ?? input.strategySelection?.model,
    commandOverride: input.commandOverride,
    allowlist,
    roster,
    headroom: input.headroom,
    exhaustedPct: resolvePoolExhaustedPct(input.prefMap, input.projectId),
    reserveAllowed: reserve.allowed,
    nowMs: input.nowMs,
    requiredDataLabels: input.prefMap.get(requiredDataLabelsPrefKey(input.projectId)),
  });
  const startPolicy = resolveStartPolicy(input.prefMap, input.projectId);
  // #546: this read `auto_merge` ALONE while every other owner predicate also required a
  // strategy, so with `merge_strategy: "direct"` the runtime config reported auto-merge ON
  // for work no automation would ever merge — and drive-preflight, its only consumer,
  // passed the "prefs coherent" check on that.
  const autoMerge = isAutomaticMergeEnabled(input.prefMap);
  const autoMergeDisabled = input.prefMap.get(autoMergeDisabledPrefKey(input.projectId)) === "true";

  return {
    projectId: input.projectId,
    provider: {
      ...provider,
      source: resolveProviderSource(input),
      strategySelection: input.strategySelection ?? null,
      settingsSelection: readSettingsSelection(input.prefMap),
      allowlist,
      roster,
      reserveAllowed: reserve.allowed,
      reserveAllowedReason: reserve.reason,
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
  const prefMap = toPrefMap(rows);
  const hasOverride = Boolean(input.profileOverride?.name) || Boolean(input.legacyProfileOverride);
  const strategySelection = !hasOverride
    ? await resolveStrategyProviderSelection(database, input.projectId)
    : null;
  // #1025: the observed global roster comes from the same discovery the rings run, off the
  // prefs already loaded above — so no extra DB round-trip, and a caller that has its own
  // (a test, or a worker attestation later) can still pass one in.
  const globalRoster = input.globalRoster ?? loadObservedGlobalRoster({
    claudeRingRaw: prefMap.get(PREF_CLAUDE_SUBSCRIPTION_RING),
    codexRingRaw: prefMap.get(PREF_CODEX_LICENSE_RING),
  });
  return resolveProjectRuntimeConfig({ ...input, prefMap, strategySelection, globalRoster });
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

/**
 * Detect drift between the global provider/profile settings prefs and the project's
 * Strategy Bullseye. Thin re-export of the pure shared implementation
 * (`@agentic-kanban/shared/lib/strategy-policy`), which is now the SINGLE guard owner
 * shared by the settings/CLI/MCP write paths (arch-review §3.3).
 */
export function resolveProviderDivergence(prefMap: Map<string, string>, projectId: string): {
  hasBullseye: boolean;
  bullseyeProvider: string | null;
  bullseyeProfile: string | null;
  settingsProvider: string | null;
  settingsProfile: string | null;
  diverged: boolean;
} {
  return resolveProviderDivergenceShared(prefMap, projectId);
}
