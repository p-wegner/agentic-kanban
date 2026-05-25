import type { AgentLaunchConfig, AgentProvider, BuildAgentLaunchConfigOptions } from "./types.js";
import { ClaudeProvider } from "./claude-provider.js";
import { CodexProvider } from "./codex-provider.js";
import { CopilotProvider } from "./copilot-provider.js";

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

export function buildAgentLaunchConfig(options: BuildAgentLaunchConfigOptions = {}): AgentLaunchConfig {
  const providerName = options.provider ?? undefined;
  return getProvider(providerName).buildLaunchConfig(options);
}
