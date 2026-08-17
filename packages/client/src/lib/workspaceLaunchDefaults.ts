import { defaultModelForProvider, type AgentProvider, type Settings } from "./settings-shared.js";
import { PROVIDER_TRAITS } from "@agentic-kanban/shared/lib/provider-traits";

export interface WorkspaceLaunchDefaults {
  provider: AgentProvider;
  profileName: string;
  model: string;
}

export function resolveWorkspaceLaunchDefaults(settings: Settings | Record<string, string>): WorkspaceLaunchDefaults {
  const provider = (settings.provider as AgentProvider) || "claude";
  // #493: table lookup for the pref key. This surface's claude fallback is the literal
  // "default" — a FOURTH spelling next to "", "none" and claude-empty elsewhere — so it
  // is written out rather than taken from the table, whose claude default is "".
  const profileName = provider === "claude"
    ? (settings.claude_profile || "default")
    : ((settings as Record<string, string>)[PROVIDER_TRAITS[provider].profilePrefKey] || PROVIDER_TRAITS[provider].defaultProfile);

  return {
    provider,
    profileName,
    model: defaultModelForProvider(settings, provider),
  };
}
