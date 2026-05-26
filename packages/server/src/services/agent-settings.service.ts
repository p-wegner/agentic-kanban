import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preferences } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import {
  PREF_AGENT_COMMAND,
  PREF_AGENT_ARGS,
  PREF_SKIP_PERMISSIONS,
  PREF_CLAUDE_PROFILE,
  PREF_CODEX_PROFILE,
  PREF_COPILOT_PROFILE,
  PREF_PROVIDER,
  PREF_MOCK_AGENT_PROFILE,
  PREF_MOCK_AGENT_DELAY_MS,
  PREF_RESUME_WITH_NEW_MODEL,
  PREF_PERMISSION_PROMPT_TOOL,
} from "../constants/preference-keys.js";
import type { ProviderName } from "./agent-provider.js";
import type { ProviderId } from "./agent-provider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(__dirname, "../scripts/mock-agent.ts");
const TSX_LOADER = resolve(__dirname, "../../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;
export const MOCK_AGENT_COMMAND = `node --import ${TSX_URL} "${MOCK_AGENT_PATH}"`;

export interface AgentSettings {
  agentCommand: string | undefined;
  agentArgs: string | undefined;
  /** @deprecated Use profile instead */
  claudeProfile: string | undefined;
  /** Provider-tagged profile selection. Derived from claude_profile + provider preferences. */
  profile: { provider: ProviderName; name: string } | undefined;
  provider: ProviderName;
  resumeWithNewModel: boolean;
  permissionPromptTool: string | undefined;
}

export async function loadAgentSettings(
  database: Database,
  commandOverride?: string,
): Promise<AgentSettings> {
  const prefRows = await database.select().from(preferences);
  const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
  return resolveAgentSettings(prefMap, commandOverride);
}

export function isMockProfile(profile: string | undefined): boolean {
  return profile === "mock" || process.env.MOCK_AGENT === "1";
}

export function toExecutorProvider(provider: ProviderName): ProviderId {
  return provider === "claude" ? "claude-code" : provider;
}

/**
 * Build the mock agent command, appending the configured behavior profile and
 * inter-event delay as CLI flags. Values are sanitized because the mock command
 * is spawned with shell:true on Windows (see agent.service.ts).
 */
function buildMockCommand(prefMap: Map<string, string>): string {
  let cmd = MOCK_AGENT_COMMAND;
  const profile = prefMap.get(PREF_MOCK_AGENT_PROFILE);
  if (profile && /^[a-z-]+$/.test(profile)) {
    cmd += ` --profile ${profile}`;
  }
  const delayMs = prefMap.get(PREF_MOCK_AGENT_DELAY_MS);
  if (delayMs && /^\d+$/.test(delayMs)) {
    cmd += ` --delay-ms ${delayMs}`;
  }
  return cmd;
}

export function resolveAgentSettings(
  prefMap: Map<string, string>,
  commandOverride?: string,
): AgentSettings {
  let agentCommand: string | undefined = commandOverride || undefined;
  const claudeProfile = prefMap.get(PREF_CLAUDE_PROFILE) || undefined;

  if (!agentCommand) {
    const useMock = isMockProfile(claudeProfile);
    if (useMock) {
      agentCommand = buildMockCommand(prefMap);
    } else {
      agentCommand = prefMap.get(PREF_AGENT_COMMAND) || undefined;
    }
  }

  const provider = parseProviderName(prefMap.get(PREF_PROVIDER));

  // `--dangerously-skip-permissions` is Claude-specific. Codex and Copilot get
  // provider-native permission handling in their providers and reject Claude flags.
  const skipPerms = prefMap.get(PREF_SKIP_PERMISSIONS) === "true" && provider === "claude";
  const baseArgs = prefMap.get(PREF_AGENT_ARGS) || "";
  const agentArgs = skipPerms
    ? (baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions")
    : (baseArgs || undefined);

  const resumeWithNewModel = prefMap.get(PREF_RESUME_WITH_NEW_MODEL) === "true";

  const permPref = prefMap.get(PREF_PERMISSION_PROMPT_TOOL);
  const permissionPromptTool = permPref === "true"
    ? "mcp__agentic-kanban__approve_tool_use"
    : (permPref && permPref !== "false" ? permPref : undefined);

  // Don't pass mock profile name to Claude Code — it's only used to select the mock agent command
  const resolvedProfile = isMockProfile(claudeProfile) ? undefined : claudeProfile;

  const effectiveProfileName =
    provider === "codex"
      ? (prefMap.get(PREF_CODEX_PROFILE) || undefined)
      : provider === "copilot"
        ? (prefMap.get(PREF_COPILOT_PROFILE) || undefined)
        : resolvedProfile;

  const profile = effectiveProfileName ? { provider, name: effectiveProfileName } : undefined;
  return { agentCommand, agentArgs, claudeProfile: resolvedProfile, profile, provider, resumeWithNewModel, permissionPromptTool };
}

function parseProviderName(provider: string | undefined): ProviderName {
  if (provider === "codex" || provider === "copilot") return provider;
  return "claude";
}
