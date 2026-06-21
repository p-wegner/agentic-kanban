// Pure provider/profile label + selection helpers for the create-issue and
// workspace-launch surfaces. Extracted so the (previously untested) label logic
// and the claude-vs-codex selection derivation are unit-testable; the components
// import them and render identically.

import type { ProfileSelection } from "@agentic-kanban/shared";

export type AgentProvider = ProfileSelection["provider"];

export const COPILOT_DEFAULT_PROFILE = "default";
export const CODEX_DEFAULT_PROFILE = "default";
export const PI_DEFAULT_PROFILE = "default";

/** Dedupe a profile list (dropping falsy), optionally prepending a fallback first. */
export function uniqueProfiles(profiles: string[], fallback?: string): string[] {
  const all = fallback ? [fallback, ...profiles] : profiles;
  return [...new Set(all.filter(Boolean))];
}

/** The "Default (provider:name)" token reflecting the current settings provider/profile. */
export function defaultProfileLabel(settings: Record<string, string>): string {
  if (settings.provider === "codex") return `codex:${settings.codex_profile || CODEX_DEFAULT_PROFILE}`;
  if (settings.provider === "copilot") return `copilot:${settings.copilot_profile || COPILOT_DEFAULT_PROFILE}`;
  if (settings.provider === "pi") return `pi:${settings.pi_profile || PI_DEFAULT_PROFILE}`;
  return `claude:${settings.claude_profile || "none"}`;
}

/** Human label for a (provider, name) profile; the literal "default" reads as "Default". */
export function profileOptionLabel(provider: AgentProvider, name: string): string {
  const isDefault = (provider === "copilot" && name === COPILOT_DEFAULT_PROFILE) ||
    (provider === "codex" && name === CODEX_DEFAULT_PROFILE) ||
    (provider === "pi" && name === PI_DEFAULT_PROFILE);
  const displayName = isDefault ? "Default" : name;
  const providerLabel = provider === "codex" ? "Codex" : provider === "copilot" ? "Copilot" : provider === "pi" ? "Pi" : "Claude";
  return `${providerLabel}: ${displayName}`;
}

/**
 * Whether the Claude / Codex model dropdown applies, from the selected profile token:
 * an empty token falls back to the settings provider; otherwise the token prefix decides.
 */
export function providerFromSelection(
  selectedProfile: string,
  settingsProvider: string | undefined,
): { isClaudeSelected: boolean; isCodexSelected: boolean } {
  const isClaudeSelected = selectedProfile === ""
    ? (settingsProvider !== "codex" && settingsProvider !== "copilot" && settingsProvider !== "pi")
    : selectedProfile.startsWith("claude:");
  const isCodexSelected = selectedProfile === ""
    ? settingsProvider === "codex"
    : selectedProfile.startsWith("codex:");
  return { isClaudeSelected, isCodexSelected };
}
