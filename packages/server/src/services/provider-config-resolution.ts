/**
 * Pure provider/profile/model resolution for workspace creation (#703).
 *
 * Extracted from `buildAgentConfig` in `workspace-crud.service.ts`, where the
 * codex-vs-claude branching was tangled with DB reads, strategy-bullseye parsing
 * and live-quota lookups — making it impossible to unit-test in isolation.
 *
 * This function does the *pure decision* only. All side effects (reading the
 * preferences table, fetching the strategy config, and consulting live quota
 * usage) happen in the caller, which passes their results in:
 *   - `prefMap`           the already-loaded preference map
 *   - `profileOverride`   an explicit per-workspace `{provider, name}` selection
 *   - `legacyProfileOverride`  the legacy `claudeProfile` string override
 *   - `strategySelection` the already-resolved strategy-bullseye provider+profile
 *                         (already incorporates quota), or null
 *   - `requestedModel`    the per-workspace model override
 *
 * Output: the resolved `{provider, profileName, model, ...}` plus the raw
 * agent-settings fields the caller threads into the workspace record.
 *
 * NOTE: this mutates `prefMap` (mirroring overrides/strategy onto it) so the
 * shared `resolveAgentSettings` reads a consistent view — pass a copy if the
 * caller needs the original. The caller already builds a fresh map per call.
 */
import { modelBelongsToProvider } from "@agentic-kanban/shared";
import type { ProviderName } from "./agent-provider.js";
import { narrowProviderName, getProfilePrefKey } from "./agent-provider.js";
import { resolveAgentSettings } from "./agent-settings.service.js";
import { applyProviderSelectionToPrefMap } from "./strategy-objective.service.js";

export interface ProviderConfigInput {
  prefMap: Map<string, string>;
  /** `provider` is an untrusted string (from the request body); narrowed internally. */
  profileOverride?: { provider?: string; name?: string } | null;
  legacyProfileOverride?: string | null;
  strategySelection?: { provider: ProviderName; profileName: string } | null;
  requestedModel?: string | null;
}

export interface ResolvedProviderConfig {
  provider: ProviderName;
  /** The profile name to record/launch with (provider-specific). */
  profileName: string | undefined;
  /** The model to launch with, or undefined to use the provider default. */
  model: string | undefined;
  agentCommand: string | undefined;
  agentArgs: string | undefined;
  permissionPromptTool: string | undefined;
  /** `{provider, name}` selection echoed back for the workspace record. */
  profileSelection: { provider: ProviderName; name: string } | undefined;
  /** Diagnostics for the caller to log (kept side-effect-free here). */
  notes: string[];
}

export function resolveProviderConfig(input: ProviderConfigInput): ResolvedProviderConfig {
  const { prefMap } = input;
  const profileOverride = input.profileOverride ?? null;
  const legacyProfileOverride = input.legacyProfileOverride ?? null;
  const notes: string[] = [];

  // Precedence: explicit per-workspace profile > legacy claudeProfile > strategy
  // bullseye selection. Each writes the provider + provider-specific *_profile key
  // onto prefMap so the shared resolveAgentSettings reads a consistent view.
  if (profileOverride?.name) {
    const overrideProvider = narrowProviderName(profileOverride.provider);
    prefMap.set(getProfilePrefKey(overrideProvider), profileOverride.name);
    prefMap.set("provider", overrideProvider);
  } else if (legacyProfileOverride) {
    prefMap.set("claude_profile", legacyProfileOverride);
    prefMap.set("provider", "claude");
  } else if (input.strategySelection) {
    applyProviderSelectionToPrefMap(prefMap, input.strategySelection);
    notes.push(
      `strategy provider selection: ${input.strategySelection.provider}:${input.strategySelection.profileName}`,
    );
  }

  const {
    agentCommand,
    agentArgs,
    claudeProfile: resolvedProfile,
    profile: profileSelection,
    provider,
    permissionPromptTool,
  } = resolveAgentSettings(prefMap);

  const profileName = provider === "claude"
    ? (resolvedProfile || legacyProfileOverride || prefMap.get("claude_profile") || undefined)
    : profileSelection?.name;

  const requestedModel = typeof input.requestedModel === "string" ? input.requestedModel.trim() : "";
  // Claude, Codex, and Pi honor the `default_model` preference (overridable per
  // workspace via requestedModel). Codex/Pi pass it through as `--model`. Copilot has
  // no model flag, so it stays undefined.
  //
  // `default_model` is a single, provider-agnostic preference, so a leftover model id
  // from the other provider (e.g. a Codex `gpt-5.5` surviving a switch to Claude) would
  // otherwise be passed as `--model gpt-5.5` to claude.exe — which exits in ~5s with an
  // invalid-model error and silently fails every launch (#696). Drop a model id that
  // doesn't belong to the active provider's family rather than launch a doomed agent.
  let model = (provider === "claude" || provider === "codex" || provider === "pi")
    ? ((requestedModel || prefMap.get("default_model")) || undefined)
    : undefined;
  if (model && !modelBelongsToProvider(model, provider)) {
    notes.push(`ignoring default_model "${model}" — not a ${provider} model; using provider default`);
    model = undefined;
  }

  return {
    provider,
    profileName,
    model,
    agentCommand,
    agentArgs,
    permissionPromptTool,
    profileSelection,
    notes,
  };
}
