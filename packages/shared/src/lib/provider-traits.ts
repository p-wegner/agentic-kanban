/**
 * One row per agent provider (#493).
 *
 * The server has a registry (`agent-provider/registry.ts`) and shared has
 * `providerProfilePrefKey` / `narrowPolicyProvider`, but the CLIENT re-derived the
 * claude/codex/copilot/pi ladder by hand in nine places — and the copies had drifted in a
 * way users could see:
 *
 * - `CreateWorkspaceForm`'s private `profileOptionLabel` omitted `pi` from BOTH its
 *   default-name check and its label ladder, so a `pi` profile rendered as
 *   **"Claude: <name>"** in the workspace-launch dropdown. Not a style nit — the form
 *   told you it would launch the wrong agent.
 * - The claude fallback token disagreed three ways across copies: `""`, `"default"`,
 *   `"none"`.
 *
 * A fifth provider is foreseeable (an OpenCode adapter; a `convert-hooks-to-opencode`
 * skill already exists), and today that means ~15 edits across nine files. With the table
 * it is one row — which is the actual argument for this change, more than the line count.
 *
 * PURE and client-safe by construction: no imports, no node builtins, so it can be
 * re-exported through the client-reachable barrel (see the shared CLAUDE.md note on
 * `barrel-client-safety`).
 */

export type AgentProviderName = "claude" | "codex" | "copilot" | "pi";

export const AGENT_PROVIDER_NAMES: readonly AgentProviderName[] = ["claude", "codex", "copilot", "pi"];

export interface ProviderTraits {
  /** Human label used in dropdowns and "Will use:" lines. */
  label: string;
  /**
   * The profile name meaning "whatever this provider is configured with".
   *
   * Claude's is `""`, not `"default"`: its profile preference is genuinely absent rather
   * than set to a sentinel, and the launch path treats empty as "use the CLI login".
   * That asymmetry is exactly what the hand-rolled ladders kept getting wrong.
   */
  defaultProfile: string;
  /** Preference key holding the selected profile for this provider. */
  profilePrefKey: string;
}

export const PROVIDER_TRAITS: Record<AgentProviderName, ProviderTraits> = {
  claude: { label: "Claude", defaultProfile: "", profilePrefKey: "claude_profile" },
  codex: { label: "Codex", defaultProfile: "default", profilePrefKey: "codex_profile" },
  copilot: { label: "Copilot", defaultProfile: "default", profilePrefKey: "copilot_profile" },
  pi: { label: "Pi", defaultProfile: "default", profilePrefKey: "pi_profile" },
};

/** Narrow an arbitrary string to a known provider, falling back to claude. */
export function narrowProvider(value: string | null | undefined): AgentProviderName {
  return (AGENT_PROVIDER_NAMES as readonly string[]).includes(value ?? "")
    ? (value as AgentProviderName)
    : "claude";
}

/** Display label for a provider — the ladder that omitted `pi` in one copy. */
export function providerLabel(provider: string | null | undefined): string {
  return PROVIDER_TRAITS[narrowProvider(provider)].label;
}

/**
 * Human label for a (provider, profile) pair; a provider's own default name reads as
 * "Default". Claude's default is `""`, so a claude profile is only "Default" when the
 * name is empty — which is why this cannot be a single `name === "default"` test.
 */
export function profileOptionLabel(provider: string | null | undefined, name: string): string {
  const p = narrowProvider(provider);
  const traits = PROVIDER_TRAITS[p];
  const displayName = name === traits.defaultProfile ? "Default" : name;
  return `${traits.label}: ${displayName}`;
}

/**
 * The `provider:profile` token describing the current settings selection.
 *
 * `claudeFallback` exists because the three copies disagreed on what to show when
 * `claude_profile` is unset (`""` / `"default"` / `"none"`) and each surface's text is
 * pinned by its own tests. Unifying the LADDER without silently changing displayed text
 * is the point; picking one word is a separate UX call, deliberately not made here.
 */
export function defaultProfileToken(
  prefs: Record<string, string>,
  claudeFallback = "none",
): string {
  const provider = narrowProvider(prefs.provider);
  const traits = PROVIDER_TRAITS[provider];
  if (provider === "claude") return `claude:${prefs.claude_profile || claudeFallback}`;
  return `${provider}:${prefs[traits.profilePrefKey] || traits.defaultProfile}`;
}
