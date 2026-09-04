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
  type StrategyProviderSelection,
} from "./strategy-objective.service.js";
import { fetchLiveQuotaUsage } from "./quota-usage.service.js";
import {
  buildProfileSelectionReason,
  type ProfileSelectionReason,
} from "@agentic-kanban/shared/lib/profile-selection-reason";
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
  headroomFromQuotaUsage,
  isProfileCooling,
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
  strategySelection: StrategyProviderSelection | null;
  /**
   * #1026 — WHY this profile, recorded for the session row: which profile, its 5-hour
   * headroom, what decided, and every candidate that lost with its own reading. Null when
   * no profile resolved at all ("not recorded" stays distinct from "the default happened").
   */
  profileSelectionReason: ProfileSelectionReason | null;
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
  strategySelection?: StrategyProviderSelection | null;
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

/**
 * Assemble the #1026 selection record from what the resolvers already decided.
 *
 * The candidate list is whichever set actually did the choosing: a restricted project's
 * ranked `poolOrder`, otherwise the Bullseye policies the strategy selector weighed. Both
 * carry their 5-hour reading, so "why not the other account" survives the minutes in which
 * that number was true. A project with neither — one profile, no roster — still gets a
 * record naming the profile, because "there was only one candidate" is itself the answer.
 */
function buildSelectionReason(args: {
  provider: ResolvedProviderConfig;
  roster: ParsedRoster;
  source: RuntimeProviderConfig["source"];
  input: ProjectRuntimeConfigInput;
  exhaustedPct: number;
}): ProfileSelectionReason | null {
  const { provider, roster, source, input, exhaustedPct } = args;
  if (!provider.profileName) return null;
  const selected = `${provider.provider}:${provider.profileName}`;
  const nowMs = input.nowMs ?? Date.now();

  const readingOf = (id: string, name: string): number | null => {
    const rec = input.headroom?.get(id) ?? input.headroom?.get(name);
    if (!rec || rec.stale) return null;
    return typeof rec.usedPct === "number" && Number.isFinite(rec.usedPct) ? rec.usedPct : null;
  };

  let candidates: Array<{ id: string; usedPct: number | null; cooling?: boolean; exhausted?: boolean }>;
  if (roster.restricted && provider.poolOrder.length > 0) {
    candidates = provider.poolOrder.map((id) => {
      const entry = roster.entries.find((e) => `${e.provider}:${e.name}` === id);
      const used = readingOf(id, entry?.name ?? id);
      return {
        id,
        usedPct: used,
        cooling: entry ? isProfileCooling(entry, input.prefMap, nowMs) : false,
        exhausted: used !== null && used >= exhaustedPct,
      };
    });
  } else {
    candidates = (input.strategySelection?.candidates ?? []).map((c) => ({
      id: c.id,
      usedPct: c.usedPct,
      exhausted: c.exhausted,
    }));
  }

  return buildProfileSelectionReason({
    selected,
    source,
    candidates,
    clamped: provider.profileClamped,
    reserveUsed: provider.reserveUsed,
    // The Bullseye is the only selector that RANKS; every other source names one profile,
    // so a kept choice is recorded as explicit even when readings exist beside it.
    explicit: source !== "strategy",
    note: provider.reserveNote,
  });
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

  const source = resolveProviderSource(input);
  return {
    projectId: input.projectId,
    provider: {
      ...provider,
      source,
      profileSelectionReason: buildSelectionReason({
        provider,
        roster,
        source,
        input,
        exhaustedPct: resolvePoolExhaustedPct(input.prefMap, input.projectId),
      }),
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
  // #1026: the launch reads quota ONCE and hands the same map to both selectors — the
  // Bullseye's ranking and the roster's exhaustion check. Reading it twice would let them
  // disagree about the same instant, the way #938's two Tier-0 reads would have.
  const exhaustedPct = resolvePoolExhaustedPct(prefMap, input.projectId);
  const headroom = input.headroom ?? (await loadProfileHeadroom());
  const strategySelection = !hasOverride
    ? await resolveStrategyProviderSelection(database, input.projectId, { headroom, exhaustedPct })
    : null;
  // #1025: the observed global roster comes from the same discovery the rings run, off the
  // prefs already loaded above — so no extra DB round-trip, and a caller that has its own
  // (a test, or a worker attestation later) can still pass one in.
  const globalRoster = input.globalRoster ?? loadObservedGlobalRoster({
    claudeRingRaw: prefMap.get(PREF_CLAUDE_SUBSCRIPTION_RING),
    codexRingRaw: prefMap.get(PREF_CODEX_LICENSE_RING),
  });
  return resolveProjectRuntimeConfig({ ...input, prefMap, strategySelection, globalRoster, headroom });
}

/**
 * Live 5-hour readings for every profile, or null when there is no usable quota source.
 *
 * Best-effort BY CONTRACT: an unreachable quota service must degrade to declared order —
 * the behaviour every board had before #1026 — never fail a launch. The OAuth provider
 * caches internally and refreshes at most one profile per call, so asking per launch is a
 * map lookup rather than a round trip.
 */
async function loadProfileHeadroom(): Promise<Map<string, ProfileHeadroom> | null> {
  try {
    return headroomFromQuotaUsage(await fetchLiveQuotaUsage());
  } catch {
    return null;
  }
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
