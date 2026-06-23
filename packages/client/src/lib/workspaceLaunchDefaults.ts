import { defaultModelForProvider, type AgentProvider, type Settings } from "./settings-shared.js";

export interface WorkspaceLaunchDefaults {
  provider: AgentProvider;
  profileName: string;
  model: string;
}

export function resolveWorkspaceLaunchDefaults(settings: Settings | Record<string, string>): WorkspaceLaunchDefaults {
  const provider = (settings.provider as AgentProvider) || "claude";
  const profileName = provider === "codex"
    ? (settings.codex_profile || "default")
    : provider === "pi"
    ? (settings.pi_profile || "default")
    : provider === "copilot"
    ? (settings.copilot_profile || "default")
    : (settings.claude_profile || "default");

  return {
    provider,
    profileName,
    model: defaultModelForProvider(settings, provider),
  };
}
