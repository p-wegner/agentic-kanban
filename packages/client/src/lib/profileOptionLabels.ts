// Pure provider/profile label + selection helpers for the create-issue and
// workspace-launch surfaces. Extracted so the (previously untested) label logic
// and the claude-vs-codex selection derivation are unit-testable; the components
// import them and render identically.

import type { ProfileSelection } from "@agentic-kanban/shared";
import { defaultProfileToken } from "@agentic-kanban/shared/lib/provider-traits";

export type AgentProvider = ProfileSelection["provider"];

export const COPILOT_DEFAULT_PROFILE = "default";
export const CODEX_DEFAULT_PROFILE = "default";
export const PI_DEFAULT_PROFILE = "default";

/** Dedupe a profile list (dropping falsy), optionally prepending a fallback first. */
export function uniqueProfiles(profiles: string[], fallback?: string): string[] {
  const all = fallback ? [fallback, ...profiles] : profiles;
  return [...new Set(all.filter(Boolean))];
}

/**
 * The "Default (provider:name)" token reflecting the current settings provider/profile.
 * #493: now a table read. This surface's claude fallback is "none" and stays "none" —
 * see the note on `defaultProfileToken` about not folding a UX decision into a refactor.
 */
export function defaultProfileLabel(settings: Record<string, string>): string {
  return defaultProfileToken(settings, "none");
}

/** Human label for a (provider, name) profile; a provider's default name reads as "Default". */
export { profileOptionLabel } from "@agentic-kanban/shared/lib/provider-traits";

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
