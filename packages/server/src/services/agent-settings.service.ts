import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { db } from "../db/index.js";
import { preferences } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import {
  PREF_AGENT_COMMAND,
  PREF_AGENT_ARGS,
  PREF_SKIP_PERMISSIONS,
  PREF_CLAUDE_PROFILE,
  PREF_RESUME_WITH_NEW_MODEL,
  PREF_PERMISSION_PROMPT_TOOL,
} from "../constants/preference-keys.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(__dirname, "../scripts/mock-agent.ts");
const TSX_LOADER = resolve(__dirname, "../../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;
export const MOCK_AGENT_COMMAND = `node --import ${TSX_URL} "${MOCK_AGENT_PATH}"`;

export interface AgentSettings {
  agentCommand: string | undefined;
  agentArgs: string | undefined;
  claudeProfile: string | undefined;
  resumeWithNewModel: boolean;
  permissionPromptTool: string | undefined;
}

export async function loadAgentSettings(
  database: Database = db,
  commandOverride?: string,
): Promise<AgentSettings> {
  const prefRows = await database.select().from(preferences);
  const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
  return resolveAgentSettings(prefMap, commandOverride);
}

export function isMockProfile(profile: string | undefined): boolean {
  return profile === "mock" || process.env.MOCK_AGENT === "1";
}

export function resolveAgentSettings(
  prefMap: Map<string, string>,
  commandOverride?: string,
): AgentSettings {
  let agentCommand: string | undefined = commandOverride || undefined;
  const claudeProfile = prefMap.get(PREF_CLAUDE_PROFILE) || undefined;

  if (!agentCommand) {
    const useMock = isMockProfile(claudeProfile);
    agentCommand = useMock ? MOCK_AGENT_COMMAND : (prefMap.get(PREF_AGENT_COMMAND) || undefined);
  }

  const skipPerms = prefMap.get(PREF_SKIP_PERMISSIONS) === "true";
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
  return { agentCommand, agentArgs, claudeProfile: resolvedProfile, resumeWithNewModel, permissionPromptTool };
}
