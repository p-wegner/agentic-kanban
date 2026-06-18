import type { AgentLaunchConfig, AgentProvider, BuildAgentLaunchConfigOptions, ProviderName } from "./types.js";
import { PROVIDER_NAMES } from "./types.js";
import { ClaudeProvider } from "./claude-provider.js";
import { CodexProvider } from "./codex-provider.js";
import { CopilotProvider } from "./copilot-provider.js";
import { PiProvider } from "./pi-provider.js";

const providers = new Map<string, AgentProvider>();
let defaultProviderName = "claude";

function registerProvider(provider: AgentProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name?: string): AgentProvider {
  const key = name === "claude-code" ? "claude" : (name ?? defaultProviderName);
  const provider = providers.get(key);
  if (!provider) throw new Error(`Unknown agent provider: ${key}`);
  return provider;
}

export function setDefaultProvider(name: string): void {
  if (!providers.has(name)) throw new Error(`Unknown agent provider: ${name}`);
  defaultProviderName = name;
}

registerProvider(new ClaudeProvider());
registerProvider(new CodexProvider());
registerProvider(new CopilotProvider());
registerProvider(new PiProvider());

export function buildAgentLaunchConfig(options: BuildAgentLaunchConfigOptions = {}): AgentLaunchConfig {
  const providerName = options.provider ?? undefined;
  return getProvider(providerName).buildLaunchConfig(options);
}

/**
 * Narrow an untrusted string (a stored pref, a request field, the legacy
 * "claude-code" id) to a canonical ProviderName, defaulting to "claude". The ONE
 * place this mapping lives — replaces the `=== "codex" || === "copilot" ...`
 * ladders scattered across services/routes.
 */
export function narrowProviderName(value: string | null | undefined): ProviderName {
  const key = value === "claude-code" ? "claude" : value;
  return (PROVIDER_NAMES as readonly string[]).includes(key ?? "") ? (key as ProviderName) : "claude";
}

/**
 * The preference key holding the selected profile for a provider (e.g. provider
 * "codex" → "codex_profile"). Owned by each provider adapter; resolved here so the
 * provider→pref-key ladder is never hand-rolled again.
 */
export function getProfilePrefKey(provider: string | null | undefined): string {
  return getProvider(narrowProviderName(provider)).profilePrefKey;
}
