/**
 * Resolving how a butler LAUNCHES — provider, profile, backend, model, resume id.
 *
 * Split out of `butler-definitions.service.ts` under #819. #728 named that file and
 * deferred the cut; the seam was re-verified here by CONSUMERS rather than by the
 * computed identifier clusters:
 *
 *  - The two headless warm-up callers — `services/agent-questions/recommendation.ts`
 *    and `services/plugin-gate-butler.service.ts` — import ONLY
 *    `resolveButlerLaunchConfig`, and `routes/butler-definitions.ts` (the CRUD route)
 *    imports ONLY the CRUD half. The sets overlap in exactly one module,
 *    `routes/butler.ts`, which legitimately does both.
 *  - The dependency runs ONE WAY: this module reads a definition via
 *    `getButlerDefinition`; the store calls nothing here. No cycle, and neither half
 *    holds module-level mutable state.
 *  - The import weight is the other half of the argument, and it is the concrete one:
 *    this file pulls in agent settings, the Strategy Bullseye reader, the shared
 *    provider resolver, the preference service and the codex license ring. The CRUD
 *    half needs a preference read/write and a slugifier. Keeping them together made a
 *    four-endpoint CRUD route transitively depend on the whole provider-resolution
 *    stack.
 *
 * Consequence worth knowing: `provider-resolution-single-source.test.ts` allow-lists
 * `selectProviderFromStrategy` callers by path, so its entry moved here with the code —
 * which makes that allow-list point at the resolver rather than at a 353-line file that
 * mostly did something else.
 */
import { CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS } from "@agentic-kanban/shared";
import type { Database } from "../../db/index.js";
import { getAllPreferences, getPreference } from "../../repositories/preferences.repository.js";
import { getRuntimeState } from "../../repositories/runtime-state.repository.js";
import { createPreferenceService } from "../preference.service.js";
import { loadAgentSettings, isMockProfile } from "../agent-settings.service.js";
import type { ProviderName } from "../agent-provider.js";
import {
  selectProviderFromStrategy,
  applyProviderSelectionToPrefMap,
} from "../strategy-objective.service.js";
import { resolveEffectiveProviderProfile } from "../effective-config.service.js";
import { loadCodexLicenseRing, resolveCodexHomeForProfile } from "../codex-license-ring.js";
import { getButlerDefinition } from "./definitions-store.js";

import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { readStrategyBullseye } from "@agentic-kanban/shared/lib/strategy-objective-file";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";

// #496: registered prefix, checked at compile time.
const butlerProfilePref = projectPref("butler_profile");
/** Per-project Claude profile override for the butler (empty = global claude_profile).
 *  Profile is auth/endpoint, shared by ALL of a project's butlers — not per-butler. */
export function butlerProfilePrefKey(projectId: string): string {
  return butlerProfilePref.key(projectId);
}

/** Legacy per-project model pref key (predates per-definition model; kept only as a
 *  fallback read for the headless callers that never had a butler definition). */
function butlerModelPrefKey(projectId: string): string {
  return `butler_model_${projectId}`;
}

// Butler session id is RUNTIME STATE (kept out of the `preferences` config table,
// #975) — persisted in `runtime_state` via the runtime-state repo. Suffix per-butler
// keys for named butlers; the "default" butler keeps the legacy unsuffixed keys so
// existing resume ids / history carry over unchanged.
function butlerSuffix(butlerId: string): string {
  return butlerId && butlerId !== "default" ? `__${butlerId}` : "";
}

function butlerSessionStateKey(projectId: string, butlerId: string): string {
  return `butler_session_${projectId}${butlerSuffix(butlerId)}`;
}

/** The butler runs via the Claude Agent SDK (claude) or a CLI-spawn codex session.
 *  Copilot/pi resolve correctly through the shared resolver but are not yet wired as
 *  butler SDK backends, so they map onto the SDK default (claude) at launch. */
function butlerSdkBackend(provider: ProviderName): "claude" | "codex" {
  return provider === "codex" ? "codex" : "claude";
}

function normalizeModelForBackend(model: string | null | undefined, backend: "claude" | "codex" | "mock"): string {
  const value = model?.trim() ?? "";
  if (!value) return "";
  const options = backend === "codex" ? CODEX_MODEL_OPTIONS : CLAUDE_MODEL_OPTIONS;
  return options.some((option) => option.value === value) ? value : "";
}

export interface ButlerLaunchConfig {
  provider: ProviderName;
  /** SDK-level backend the butler session actually launches under. */
  backend: "claude" | "codex" | "mock";
  // selectedProfile drives the UI dropdown — keep the real license name there.
  selectedProfile: string | undefined;
  globalProfile: string;
  claudeProfile?: string;
  // profile drives the spawn args — "default" suppresses `--profile` when CODEX_HOME is set.
  profile?: { provider: ProviderName; name: string };
  agentCommand?: string;
  agentArgs?: string;
  /** When a codex OAuth-license profile resolves to a separate CODEX_HOME dir,
   *  the launcher must set CODEX_HOME and drop `--profile` (mirrors the builder). */
  codexHome?: string;
  model?: string;
  resumeSessionId?: string;
}

/**
 * Resolve everything a butler launch needs — provider/profile/model/resume — in one
 * place. Single source of truth for the route's live-chat launch AND the two headless
 * warm-up paths (agent-questions recommender, plugin-gate concierge), which used to
 * hand-roll a claude-only subset (`butler_profile_<id>` || `claude_profile`, no
 * provider/Bullseye awareness) and silently warmed the wrong backend on a non-claude
 * default board.
 *
 * Provider resolution funnels through the SHARED resolver
 * (`resolveEffectiveProviderProfile`) — the single source of truth used by the
 * workspace builder too. Precedence, applied to a prefMap *copy* so the resolver reads
 * a consistent view:
 *
 *  1. Per-butler provider override from the butler definition (`butlerProvider`) —
 *     written onto prefMap as `provider`.
 *  2. Project's Strategy Bullseye (`board_strategy_<projectId>`) — same source the
 *     workspace builder uses, mirrored onto prefMap via
 *     `applyProviderSelectionToPrefMap` (so the butler matches the builder).
 *  3. Global settings prefs (`provider` / `*_profile`) — the prefMap's own values,
 *     used by the resolver when neither override above is present.
 *
 * The per-project butler profile override (`butler_profile_<projectId>`) always wins
 * over the profile the resolver derives (it's an explicit user override for the
 * butler's auth endpoint, independent of which provider is primary).
 */
export async function resolveButlerLaunchConfig(
  projectId: string,
  butlerId: string = "default",
  database: Database,
): Promise<ButlerLaunchConfig> {
  const def = await getButlerDefinition(database, butlerId);
  const butlerProvider = def?.provider;

  const prefRows = await getAllPreferences(database);
  const prefMap = toPrefMap(prefRows);

  const settings = await loadAgentSettings(database);
  const perProject = await getPreference(butlerProfilePrefKey(projectId), database);

  // Layer the butler-def override / Strategy Bullseye selection onto the prefMap so
  // the shared resolver reads a consistent view. Precedence: butler-def provider >
  // Bullseye selection > prefMap's own `provider`/`*_profile` (global settings).
  if (butlerProvider) {
    prefMap.set("provider", butlerProvider);
  } else {
    const strategyConfig = readStrategyBullseye(prefMap, projectId);
    if (strategyConfig) {
      try {
        // Single parser (arch-review §3.3): `parseStrategyBullseyeConfig` now
        // normalizes the blob through the SAME shared `normalizeProviderPolicies`
        // + `selectPolicyByPriority` the MCP `start_workspace` door
        // (`resolveProviderProfileFromPrefs`) uses, so the butler and MCP agree on
        // the provider for a given blob. Live-quota gating is deliberately NOT
        // applied here: this selects the provider for the ONE warm butler assistant
        // session (not a throughput of builder launches), so quota-headroom gating —
        // whose purpose is keeping fill/throttle BUILDER launches within a rate-limit
        // window — does not apply. The quota-aware door is the builder launch
        // (`resolveStrategyProviderSelection`).
        const selected = selectProviderFromStrategy(strategyConfig);
        if (selected) {
          applyProviderSelectionToPrefMap(prefMap, selected);
        }
      } catch {
        // non-fatal: fall through to global default already on prefMap
      }
    }
  }

  const { provider, profileName: resolverProfile } = resolveEffectiveProviderProfile(prefMap);

  // #604: built from this function's own `database` rather than a module singleton.
  const availableProfiles = await createPreferenceService({ database }).listProfilesForProvider(provider);
  const profileOverride = perProject && availableProfiles.includes(perProject) ? perProject : undefined;

  const globalProfile = settings.profile?.provider === provider ? settings.profile.name : "";
  // Per-project butler override > resolver-derived profile (Bullseye/global) > global profile.
  const selectedProfile = profileOverride || resolverProfile || globalProfile || undefined;

  // `settings.agentCommand`/`agentArgs` are derived under the GLOBAL provider
  // (e.g. Claude's `--dangerously-skip-permissions`). Forwarding them to a butler
  // whose per-butler provider differs from the global one injects the wrong
  // provider's command/flags — codex rejects `--dangerously-skip-permissions` and
  // exits with code 2. Only forward when the providers match; otherwise let the
  // butler's provider use its own defaults.
  const matchesGlobalProvider = provider === settings.provider;

  // Codex OAuth licenses: a ChatGPT-plan license is a separate CODEX_HOME directory
  // with its own auth.json (an auto-discovered `~/.codex-<name>` dir or a ring entry).
  // Point CODEX_HOME at it and DROP the profile name from the launch — a separate home
  // has no `[profiles.<name>]`, so `--profile` makes codex exit code 2. This mirrors the
  // builder path in session-lifecycle.ts so the butler authenticates under the right
  // account and its rollouts land in the right home (fixes 'no rollout found' resumes).
  let codexHome: string | undefined;
  let launchProfileName = selectedProfile;
  if (provider === "codex" && selectedProfile && selectedProfile !== "default") {
    try {
      const ring = await loadCodexLicenseRing(database);
      const resolved = resolveCodexHomeForProfile(selectedProfile, ring);
      if (resolved) {
        codexHome = resolved;
        launchProfileName = "default";
      }
    } catch {
      // non-fatal: fall back to passing --profile under the default home
    }
  }

  const sdkBackend = butlerSdkBackend(provider);
  // Model is a property of the (global) butler definition, not a per-project pref.
  // Headless callers with no definition context fall back to the legacy per-project
  // model pref so they still resolve something sane.
  const model = normalizeModelForBackend(
    def?.model ?? (await getPreference(butlerModelPrefKey(projectId), database)),
    sdkBackend,
  ) || undefined;

  const resumeSessionId = (await getRuntimeState(butlerSessionStateKey(projectId, butlerId), database)) || undefined;

  // When the resolved profile is "mock", use the in-process mock backend instead of
  // the real SDK/CLI (which would fail without real API credentials). NOTE:
  // loadAgentSettings strips "mock" from claudeProfile so it is never forwarded to
  // spawn args — check the raw pref directly (per-project override, then global).
  const rawProfile = perProject || (await getPreference("claude_profile", database)) || undefined;
  const effectiveBackend: "claude" | "codex" | "mock" = isMockProfile(rawProfile) ? "mock" : sdkBackend;

  return {
    provider,
    backend: effectiveBackend,
    selectedProfile,
    globalProfile,
    claudeProfile: provider === "claude" ? selectedProfile : undefined,
    profile: launchProfileName ? { provider, name: launchProfileName } : undefined,
    agentCommand: matchesGlobalProvider ? settings.agentCommand : undefined,
    agentArgs: matchesGlobalProvider ? settings.agentArgs : undefined,
    codexHome,
    model,
    resumeSessionId,
  };
}
