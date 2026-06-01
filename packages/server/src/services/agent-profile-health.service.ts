import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { preferences } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { setPreference } from "../repositories/preferences.repository.js";
import { resolveAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import { buildAgentLaunchConfig, type ProviderName } from "./agent-provider.js";

export type ProfileHealthStatus = "ok" | "warning" | "error" | "unknown";

export interface AgentProfileFailureSummary {
  at: string;
  provider: ProviderName;
  profileName: string;
  summary: string;
  exitCode?: number | null;
  sessionId?: string;
  workspaceId?: string;
}

export interface AgentProfilePreflightResult {
  ok: boolean;
  status: ProfileHealthStatus;
  errors: string[];
  warnings: string[];
  command: string;
  profileName: string;
  provider: ProviderName;
  flags: string[];
}

export interface AgentProfileHealthRow {
  id: string;
  provider: ProviderName;
  profileName: string;
  command: string;
  selected: boolean;
  status: ProfileHealthStatus;
  preflight: AgentProfilePreflightResult;
  latestFailure: AgentProfileFailureSummary | null;
}

const DEFAULT_PROFILE = "default";
const FAILURE_PREFIX = "agent_profile_launch_failure.";
const SECRET_FLAG_PATTERN = /(?:key|token|secret|password|credential)/i;

function profileKey(provider: ProviderName, profileName?: string | null): string {
  const name = profileName?.trim() || DEFAULT_PROFILE;
  return `${provider}:${name}`;
}

function failurePreferenceKey(provider: ProviderName, profileName?: string | null): string {
  return `${FAILURE_PREFIX}${profileKey(provider, profileName)}`;
}

function applyProfileSelection(prefMap: Map<string, string>, provider: ProviderName, profileName: string): Map<string, string> {
  const next = new Map(prefMap);
  next.set("provider", provider);
  if (provider === "claude") {
    next.set("claude_profile", profileName === DEFAULT_PROFILE ? "" : profileName);
  } else if (provider === "codex") {
    next.set("codex_profile", profileName === DEFAULT_PROFILE ? "" : profileName);
  } else {
    next.set("copilot_profile", profileName === DEFAULT_PROFILE ? "" : profileName);
  }
  return next;
}

function selectedProfileName(prefMap: Map<string, string>, provider: ProviderName): string {
  if (provider === "codex") return prefMap.get("codex_profile") || DEFAULT_PROFILE;
  if (provider === "copilot") return prefMap.get("copilot_profile") || DEFAULT_PROFILE;
  return prefMap.get("claude_profile") || DEFAULT_PROFILE;
}

function profileConfigPath(provider: ProviderName, profileName: string): string | null {
  if (provider === "claude" && profileName !== DEFAULT_PROFILE && profileName !== "mock") {
    return join(homedir(), ".claude", `settings_${profileName}.json`);
  }
  if (provider === "codex" && profileName !== DEFAULT_PROFILE) {
    const newPath = join(homedir(), ".codex", `${profileName}.config.toml`);
    if (existsSync(newPath)) return newPath;
    return join(homedir(), ".codex", `config_${profileName}.toml`);
  }
  return null;
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[redacted]")
    .replace(/([A-Za-z0-9_]*token[A-Za-z0-9_]*=)[^\s]+/gi, "$1[redacted]")
    .replace(/([A-Za-z0-9_]*key[A-Za-z0-9_]*=)[^\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

function sanitizeCommand(command: string | undefined): string {
  if (!command) return "";
  const trimmed = command.trim();
  if (!trimmed) return "";
  if (trimmed.includes("mock-agent")) return "mock-agent";
  if (/[\\/]/.test(trimmed)) return basename(trimmed.replace(/^"|"$/g, ""));
  return trimmed.split(/\s+/)[0];
}

function sanitizeFlags(args: string[]): string[] {
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue;
    if (arg.includes("=")) {
      const [flag, value] = arg.split(/=(.*)/s);
      flags.push(SECRET_FLAG_PATTERN.test(flag) ? `${flag}=[redacted]` : `${flag}=${safeFlagValue(flag, value)}`);
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith("-")) {
      flags.push(SECRET_FLAG_PATTERN.test(arg) ? `${arg} [redacted]` : `${arg} ${safeFlagValue(arg, next)}`);
      i++;
    } else {
      flags.push(arg);
    }
  }
  return [...new Set(flags)];
}

function safeFlagValue(flag: string, value: string): string {
  if (SECRET_FLAG_PATTERN.test(flag)) return "[redacted]";
  if (value.includes("\\") || value.includes("/") || value.startsWith("@")) return value;
  if (flag === "--profile" || flag === "--model" || flag === "--settings" || flag === "--agent") return value;
  if (/^[A-Za-z0-9_.:-]+$/.test(value) && value.length <= 80) return value;
  return "[value]";
}

export function preflightAgentProfile(
  prefMap: Map<string, string>,
  provider: ProviderName,
  profileName: string,
): AgentProfilePreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const effectivePrefs = applyProfileSelection(prefMap, provider, profileName);
  const settings = resolveAgentSettings(effectivePrefs);
  const configPath = profileConfigPath(provider, profileName);

  if (configPath && !existsSync(configPath)) {
    errors.push(`Profile config not found: ${configPath}`);
  }
  if (!settings.agentCommand && provider === "claude") {
    warnings.push("Using default Claude command from PATH.");
  }
  if (!settings.agentCommand && provider === "codex") {
    warnings.push("Using default Codex command from PATH.");
  }
  if (!settings.agentCommand && provider === "copilot") {
    warnings.push("Using default Copilot command from PATH.");
  }

  let flags: string[] = [];
  let command = sanitizeCommand(settings.agentCommand) || provider;
  try {
    const launchConfig = buildAgentLaunchConfig({
      agentCommand: settings.agentCommand,
      agentArgs: settings.agentArgs,
      claudeProfile: settings.claudeProfile,
      profile: profileName === DEFAULT_PROFILE ? undefined : { provider, name: profileName },
      provider: toExecutorProvider(provider),
      permissionPromptTool: settings.permissionPromptTool,
      prompt: "preflight",
    });
    command = sanitizeCommand(launchConfig.command) || command;
    flags = sanitizeFlags(launchConfig.args);
  } catch (err) {
    errors.push(sanitizeErrorMessage(err instanceof Error ? err.message : String(err)));
  }

  return {
    ok: errors.length === 0,
    status: errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ok",
    errors,
    warnings,
    command,
    profileName,
    provider,
    flags,
  };
}

export async function listAgentProfileHealth(
  database: Database,
  profileLists: {
    claudeProfiles: string[];
    codexProfiles: string[];
    copilotProfiles: string[];
  },
): Promise<AgentProfileHealthRow[]> {
  const prefRows = await database.select().from(preferences);
  const prefMap = new Map(prefRows.map((row) => [row.key, row.value]));
  const failureRows = new Map(
    prefRows
      .filter((row) => row.key.startsWith(FAILURE_PREFIX))
      .map((row) => [row.key, row.value]),
  );
  const selectedProvider = (prefMap.get("provider") === "codex" || prefMap.get("provider") === "copilot")
    ? prefMap.get("provider") as ProviderName
    : "claude";

  const candidates: Array<{ provider: ProviderName; profileName: string }> = [
    { provider: "claude", profileName: DEFAULT_PROFILE },
    ...profileLists.claudeProfiles.map((name) => ({ provider: "claude" as const, profileName: name })),
    { provider: "codex", profileName: DEFAULT_PROFILE },
    ...profileLists.codexProfiles.filter((name) => name !== DEFAULT_PROFILE).map((name) => ({ provider: "codex" as const, profileName: name })),
    { provider: "copilot", profileName: DEFAULT_PROFILE },
    ...profileLists.copilotProfiles.filter((name) => name !== DEFAULT_PROFILE).map((name) => ({ provider: "copilot" as const, profileName: name })),
  ];

  const seen = new Set<string>();
  return candidates
    .filter((candidate) => {
      const id = profileKey(candidate.provider, candidate.profileName);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((candidate) => {
      const preflight = preflightAgentProfile(prefMap, candidate.provider, candidate.profileName);
      const failureRaw = failureRows.get(failurePreferenceKey(candidate.provider, candidate.profileName));
      let latestFailure: AgentProfileFailureSummary | null = null;
      if (failureRaw) {
        try {
          latestFailure = JSON.parse(failureRaw) as AgentProfileFailureSummary;
        } catch {
          latestFailure = null;
        }
      }
      return {
        id: profileKey(candidate.provider, candidate.profileName),
        provider: candidate.provider,
        profileName: candidate.profileName,
        command: preflight.command,
        selected: candidate.provider === selectedProvider && candidate.profileName === selectedProfileName(prefMap, selectedProvider),
        status: latestFailure ? "error" : preflight.status,
        preflight,
        latestFailure,
      };
    });
}

export async function recordAgentProfileLaunchFailure(
  database: Database,
  input: {
    provider: ProviderName;
    profileName?: string | null;
    summary: string;
    exitCode?: number | null;
    sessionId?: string;
    workspaceId?: string;
    at?: string;
  },
): Promise<void> {
  const profileName = input.profileName?.trim() || DEFAULT_PROFILE;
  const payload: AgentProfileFailureSummary = {
    at: input.at ?? new Date().toISOString(),
    provider: input.provider,
    profileName,
    summary: sanitizeErrorMessage(input.summary),
    exitCode: input.exitCode,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
  };
  await setPreference(failurePreferenceKey(input.provider, profileName), JSON.stringify(payload), database);
}
