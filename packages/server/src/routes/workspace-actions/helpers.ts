import type { AgentSettings } from "../../services/agent-settings.service.js";
import { workspaces } from "@agentic-kanban/shared/schema";
import type { ProviderName } from "../../services/agent-provider.js";

export function applyWorkspaceAgentSelection(settings: AgentSettings, workspace: typeof workspaces.$inferSelect): AgentSettings {
  const provider = workspace.provider;
  if (provider !== "claude" && provider !== "codex" && provider !== "copilot") return settings;

  const profileName = workspace.claudeProfile || undefined;
  const agentArgs = provider === "claude"
    ? settings.agentArgs
    : settings.agentArgs
      ?.split(/\s+/)
      .filter((arg) => arg && arg !== "--dangerously-skip-permissions")
      .join(" ") || undefined;
  return {
    ...settings,
    agentArgs,
    provider,
    claudeProfile: provider === "claude" ? profileName : undefined,
    profile: profileName ? { provider: provider as ProviderName, name: profileName } : undefined,
  };
}

export function requireBaseBranch(baseBranch: string | null | undefined): string {
  if (!baseBranch) {
    throw new Error("No default branch configured for this project. Set a default branch in project settings or choose a base branch.");
  }
  return baseBranch;
}
