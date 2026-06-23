import { modelBelongsToProvider } from "@agentic-kanban/shared";
import {
  PREF_CLAUDE_PROFILE,
  PREF_CODEX_PROFILE,
  PREF_COPILOT_PROFILE,
  PREF_DEFAULT_MODEL,
  PREF_DEFAULT_MODEL_CLAUDE,
  PREF_DEFAULT_MODEL_CODEX,
  PREF_DEFAULT_MODEL_PI,
  PREF_PI_PROFILE,
  PREF_PROVIDER,
} from "../constants/preference-keys.js";
import type { ProviderName } from "./agent-provider.js";
import { narrowProviderName } from "./agent-provider.js";

export const MODEL_PREF_KEYS_BY_PROVIDER = {
  claude: PREF_DEFAULT_MODEL_CLAUDE,
  codex: PREF_DEFAULT_MODEL_CODEX,
  pi: PREF_DEFAULT_MODEL_PI,
} as const;

const PROFILE_PREF_KEYS_BY_PROVIDER = {
  claude: PREF_CLAUDE_PROFILE,
  codex: PREF_CODEX_PROFILE,
  copilot: PREF_COPILOT_PROFILE,
  pi: PREF_PI_PROFILE,
} as const satisfies Record<ProviderName, string>;

export interface EffectiveProviderProfile {
  provider: ProviderName;
  profileName: string | undefined;
}

export interface EffectiveModel {
  model: string | undefined;
  source: "requested" | "provider-default" | "legacy-default" | "none";
  notes: string[];
}

function readTrimmed(prefMap: Map<string, string>, key: string): string | undefined {
  const value = prefMap.get(key)?.trim();
  return value ? value : undefined;
}

function providerModelPrefKey(provider: ProviderName): string | undefined {
  return provider === "claude" || provider === "codex" || provider === "pi"
    ? MODEL_PREF_KEYS_BY_PROVIDER[provider]
    : undefined;
}

function modelCapableProvider(provider: ProviderName): boolean {
  return provider === "claude" || provider === "codex" || provider === "pi";
}

export function resolveEffectiveProviderProfile(prefMap: Map<string, string>): EffectiveProviderProfile {
  const provider = narrowProviderName(prefMap.get(PREF_PROVIDER));
  return {
    provider,
    profileName: readTrimmed(prefMap, PROFILE_PREF_KEYS_BY_PROVIDER[provider]),
  };
}

export function resolveEffectiveModel(input: {
  prefMap: Map<string, string>;
  provider: ProviderName;
  requestedModel?: string | null;
}): EffectiveModel {
  const notes: string[] = [];
  if (!modelCapableProvider(input.provider)) {
    return { model: undefined, source: "none", notes };
  }

  const requested = typeof input.requestedModel === "string" ? input.requestedModel.trim() : "";
  const providerKey = providerModelPrefKey(input.provider);
  const providerDefault = providerKey ? readTrimmed(input.prefMap, providerKey) : undefined;
  const legacyDefault = readTrimmed(input.prefMap, PREF_DEFAULT_MODEL);

  const candidates: Array<{ model: string | undefined; source: EffectiveModel["source"]; prefKey?: string }> = [
    { model: requested || undefined, source: "requested" },
    { model: providerDefault, source: "provider-default", prefKey: providerKey },
    { model: legacyDefault, source: "legacy-default", prefKey: PREF_DEFAULT_MODEL },
  ];

  for (const candidate of candidates) {
    if (!candidate.model) continue;
    if (modelBelongsToProvider(candidate.model, input.provider)) {
      return { model: candidate.model, source: candidate.source, notes };
    }
    const label = candidate.prefKey ?? "requested model";
    notes.push(`ignoring ${label} "${candidate.model}" - not a ${input.provider} model; using provider default`);
    return { model: undefined, source: "none", notes };
  }

  return { model: undefined, source: "none", notes };
}
