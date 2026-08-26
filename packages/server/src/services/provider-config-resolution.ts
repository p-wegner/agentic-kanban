/**
 * Pure provider/profile/model resolution for workspace creation (#703).
 *
 * Extracted from `buildAgentConfig` in `workspace-crud.service.ts`, where the
 * codex-vs-claude branching was tangled with DB reads, strategy-bullseye parsing
 * and live-quota lookups - making it impossible to unit-test in isolation.
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
 * shared `resolveAgentSettings` reads a consistent view - pass a copy if the
 * caller needs the original. The caller already builds a fresh map per call.
 */
import type { ProviderName } from "./agent-provider.js";
import { narrowProviderName, getProfilePrefKey } from "./agent-provider.js";
import { resolveAgentSettings } from "./agent-settings.service.js";
import { applyProviderSelectionToPrefMap } from "./strategy-objective.service.js";
import { resolveEffectiveModel } from "./effective-config.service.js";
import type { ParsedProfileAllowlist } from "@agentic-kanban/shared/lib/profile-allowlist";
import { clampProfileToAllowlist } from "@agentic-kanban/shared/lib/profile-allowlist";
import { dataHandlingBlockedByRequirement, profileCapabilitiesPrefKey } from "@agentic-kanban/shared/lib/profile-capabilities";

export interface ProviderConfigInput {
  prefMap: Map<string, string>;
  /** `provider` is an untrusted string (from the request body); narrowed internally. */
  profileOverride?: { provider?: string; name?: string } | null;
  legacyProfileOverride?: string | null;
  strategySelection?: { provider: ProviderName; profileName: string } | null;
  requestedModel?: string | null;
  commandOverride?: string;
  /**
   * The project's parsed profile allowlist. A HARD constraint applied AFTER the
   * precedence chain below, so it outranks every selector including an explicit
   * per-workspace override. Omit (or pass an unrestricted list) to keep the historic
   * behaviour. See `@agentic-kanban/shared/lib/profile-allowlist`.
   */
  allowlist?: ParsedProfileAllowlist | null;
  /** Injected clock for the allowlist's cooldown checks (`nowMs` spelling, #614). */
  nowMs?: number;
  /**
   * The project's `required_data_labels_<projectId>` value (#876) — a CSV of
   * data-handling tags (e.g. "no-training,eu-data-residency") the resolved profile must
   * carry. Checked AFTER the allowlist clamp, against that profile's own
   * `profile_capabilities_<provider:name>` tags. Omit to keep unrestricted behaviour.
   */
  requiredDataLabels?: string | null;
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
  resumeWithNewModel: boolean;
  /** `{provider, name}` selection echoed back for the workspace record. */
  profileSelection: { provider: ProviderName; name: string } | undefined;
  /**
   * Set when the project's profile allowlist permits NO launch right now (every allowed
   * profile cooling, or the allowlist unparseable). Callers MUST refuse to launch and
   * surface this instead — the other fields still hold the unrestricted resolution, so
   * ignoring it silently defeats the restriction.
   */
  profileHold: string | null;
  /** True when the allowlist overrode the selection the precedence chain produced. */
  profileClamped: boolean;
  /**
   * Set when the project's required-data-labels constraint (#876) is not satisfied by
   * the resolved profile — e.g. the project requires "no-training" and the profile that
   * would launch carries no such tag. Same "caller MUST refuse to launch" contract as
   * `profileHold`: the other fields still hold the resolution, so ignoring this silently
   * defeats the requirement.
   */
  dataHandlingHold: string | null;
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

  let settings = resolveAgentSettings(prefMap, input.commandOverride);

  // The allowlist is a CONSTRAINT, not another selector, so it runs after the precedence
  // chain above — and its result is fed back through `resolveAgentSettings` rather than
  // patched onto the outputs, so agentCommand/agentArgs/permissionPromptTool/model all
  // belong to the profile we actually launch. Patching only the profile name is how a
  // clamped launch would end up carrying the *other* provider's command line.
  let profileHold: string | null = null;
  let profileClamped = false;
  if (input.allowlist?.restricted) {
    const clamp = clampProfileToAllowlist({
      allowlist: input.allowlist,
      provider: settings.provider,
      profileName: settings.profile?.name,
      prefMap,
      nowMs: input.nowMs ?? Date.now(),
    });
    if (clamp.note) notes.push(clamp.note);
    profileHold = clamp.holdReason;
    profileClamped = clamp.clamped;
    if (clamp.selection && clamp.clamped) {
      applyProviderSelectionToPrefMap(prefMap, {
        provider: clamp.selection.provider,
        profileName: clamp.selection.name,
      });
      settings = resolveAgentSettings(prefMap, input.commandOverride);
    }
  }

  const {
    agentCommand,
    agentArgs,
    profile: profileSelection,
    provider,
    resumeWithNewModel,
    permissionPromptTool,
  } = settings;

  // #528: the claude branch read a separate `claudeProfile` string here. For claude it
  // held the same value `profileSelection.name` does, so the two remaining fallbacks are
  // what the branch is actually for.
  const profileName = provider === "claude"
    ? (profileSelection?.name || legacyProfileOverride || prefMap.get("claude_profile") || undefined)
    : profileSelection?.name;

  const effectiveModel = resolveEffectiveModel({
    prefMap,
    provider,
    requestedModel: input.requestedModel,
  });
  notes.push(...effectiveModel.notes);

  // Data-handling requirement (#876) — runs LAST, against whichever profile the
  // allowlist clamp settled on, for the same reason the allowlist itself runs after the
  // precedence chain: it is a constraint on the final answer, not another selector.
  let dataHandlingHold: string | null = null;
  if (input.requiredDataLabels && !profileHold) {
    const capabilitiesRaw = profileName
      ? prefMap.get(profileCapabilitiesPrefKey(provider, profileName))
      : undefined;
    const block = dataHandlingBlockedByRequirement({
      requiredRaw: input.requiredDataLabels,
      provider,
      profileName,
      profileTagsRaw: capabilitiesRaw,
    });
    if (block.blocked) {
      dataHandlingHold = block.reason;
      notes.push(`data-handling requirement: ${block.reason}`);
    }
  }

  return {
    provider,
    profileName,
    model: effectiveModel.model,
    agentCommand,
    agentArgs,
    permissionPromptTool,
    resumeWithNewModel,
    profileSelection,
    profileHold,
    profileClamped,
    dataHandlingHold,
    notes,
  };
}
