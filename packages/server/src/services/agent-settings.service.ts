import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { readBoardEnv } from "../lib/env-registry.js";
import { resolve, dirname } from "node:path";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preferences } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import {
  PREF_AGENT_COMMAND,
  PREF_AGENT_ARGS,
  PREF_SKIP_PERMISSIONS,
  PREF_CLAUDE_PROFILE,
  PREF_PROVIDER,
  PREF_MOCK_AGENT_PROFILE,
  PREF_MOCK_AGENT_DELAY_MS,
  PREF_RESUME_WITH_NEW_MODEL,
  PREF_PERMISSION_PROMPT_TOOL,
} from "../constants/preference-keys.js";
import type { ProviderName } from "./agent-provider.js";
import type { ProviderId } from "./agent-provider.js";
import { narrowProviderName, getProfilePrefKey } from "./agent-provider.js";

import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(__dirname, "../scripts/mock-agent.ts");
const TSX_LOADER = resolve(__dirname, "../../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;
export const MOCK_AGENT_COMMAND = `node --import ${TSX_URL} "${MOCK_AGENT_PATH}"`;

export interface AgentSettings {
  agentCommand: string | undefined;
  agentArgs: string | undefined;
  /** Provider-tagged profile selection. Derived from claude_profile + provider preferences. */
  profile: { provider: ProviderName; name: string } | undefined;
  provider: ProviderName;
  resumeWithNewModel: boolean;
  permissionPromptTool: string | undefined;
  /** Resolved model (e.g. from default_model_<provider>). Undefined = let the CLI use its own default. */
  model?: string | undefined;
}

export async function loadAgentSettings(
  database: Database,
  commandOverride?: string,
): Promise<AgentSettings> {
  const prefRows = await getAllPreferencesCached(database);
  const prefMap = toPrefMap(prefRows);
  return resolveAgentSettings(prefMap, commandOverride);
}

export function isMockProfile(profile: string | undefined): boolean {
  return profile === "mock" || readBoardEnv("KANBAN_MOCK_AGENT") === "1";
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
  const skipPerms = getBool(prefMap, PREF_SKIP_PERMISSIONS) && provider === "claude";
  const baseArgs = prefMap.get(PREF_AGENT_ARGS) || "";
  const agentArgs = skipPerms
    ? (baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions")
    : (baseArgs || undefined);

  const resumeWithNewModel = getBool(prefMap, PREF_RESUME_WITH_NEW_MODEL);

  const permPref = prefMap.get(PREF_PERMISSION_PROMPT_TOOL);
  const permissionPromptTool = permPref === "true"
    ? "mcp__agentic-kanban__approve_tool_use"
    : (permPref && permPref !== "false" ? permPref : undefined);

  // Don't pass mock profile name to Claude Code — it's only used to select the mock agent command
  const resolvedProfile = isMockProfile(claudeProfile) ? undefined : claudeProfile;

  // Claude reads the mock-filtered profile; every other provider reads its own
  // profilePrefKey (owned by the provider adapter, resolved via the registry).
  const effectiveProfileName =
    provider === "claude"
      ? resolvedProfile
      : (prefMap.get(getProfilePrefKey(provider)) || undefined);

  const profile = effectiveProfileName ? { provider, name: effectiveProfileName } : undefined;
  return { agentCommand, agentArgs, profile, provider, resumeWithNewModel, permissionPromptTool };
}

/**
 * Return a copy of `prefMap` with the provider + matching profile key overridden from the
 * workspace's recorded selection, so a review/learning/verify session runs on the SAME
 * provider+profile the workspace was built with instead of falling back to the global
 * default. Without it a per-workspace Codex OAuth license is lost the moment the board's
 * default rotates. Leaves the global default in place when the workspace recorded none.
 *
 * Moved here from review.service in #541: it shapes a pref map for `resolveAgentSettings`,
 * so `startup/` reaching into the review service for it was backwards.
 */
export function applyWorkspaceProfileToPrefs(
  prefMap: Map<string, string>,
  workspace: { provider: string | null; claudeProfile: string | null },
): Map<string, string> {
  const provider = workspace.provider;
  if (provider !== "claude" && provider !== "codex" && provider !== "copilot" && provider !== "pi") return prefMap;
  const next = new Map(prefMap);
  next.set("provider", provider);
  const name = workspace.claudeProfile || undefined;
  if (name) next.set(getProfilePrefKey(provider), name);
  return next;
}

/**
 * The one ladder for a NON-builder session (learning, verify, auto-review, manual review)
 * launched against an existing workspace: pin the workspace's own provider/profile, then
 * resolve everything else through the single source of truth.
 *
 * #541 replaced five hand-rolled copies of this with one call. They had drifted: two
 * skipped the mock command's `--profile`/`--delay-ms` flags by using the bare
 * MOCK_AGENT_COMMAND, and the learning ladders read `agent_args` raw, so a board with
 * skip_permissions on gave its builders `--dangerously-skip-permissions` and its learning
 * sessions none.
 */
export function resolveWorkspaceLaunchSettings(
  prefMap: Map<string, string>,
  workspace: { provider: string | null; claudeProfile: string | null },
  commandOverride?: string,
): AgentSettings {
  return resolveAgentSettings(applyWorkspaceProfileToPrefs(prefMap, workspace), commandOverride);
}

function parseProviderName(provider: string | undefined): ProviderName {
  return narrowProviderName(provider);
}
