import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import type { Database } from "../db/index.js";
import { setPreference } from "../repositories/preferences.repository.js";
import { getAllPreferences } from "../repositories/agent-profile-health.repository.js";
import { resolveAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import { buildAgentLaunchConfig, type ProviderName } from "./agent-provider.js";
import { resolvePiExecutable, splitArgs } from "./agent-provider/helpers.js";
import { parseCodexLicenseRing, codexHomeHasAuth, resolveCodexHomeForProfile } from "./codex-license-ring.js";
import { parseClaudeSubscriptionRing, claudeConfigDirHasAuth, resolveClaudeConfigDirForProfile } from "./claude-subscription-ring.js";
import { detectCliVersion, type CliVersionResult, type VersionRunner } from "./agent-cli-version.service.js";

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
  /** CLI version probe result. Null when the version check was skipped (e.g. no command resolvable, or a sync preflight). */
  version: CliVersionResult | null;
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
const PI_API_KEY_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
];

/** Display labels for the "using default <X> command from PATH" preflight warning. */
const DEFAULT_COMMAND_LABELS: Record<ProviderName, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  pi: "Pi",
};

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
  } else if (provider === "pi") {
    next.set("pi_profile", profileName === DEFAULT_PROFILE ? "" : profileName);
  } else {
    next.set("copilot_profile", profileName === DEFAULT_PROFILE ? "" : profileName);
  }
  return next;
}

function selectedProfileName(prefMap: Map<string, string>, provider: ProviderName): string {
  if (provider === "codex") return prefMap.get("codex_profile") || DEFAULT_PROFILE;
  if (provider === "pi") return prefMap.get("pi_profile") || DEFAULT_PROFILE;
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

function commandExists(command: string): boolean {
  const first = splitArgs(command)[0] ?? command.trim();
  if (!first) return false;
  const unquoted = first.replace(/^"|"$/g, "");
  if (/[\\/]/.test(unquoted)) return existsSync(unquoted);

  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT", ".PS1"])
    : [""];
  const names = extensions.includes("") ? [unquoted] : [unquoted, ...extensions.map((ext) => `${unquoted}${ext.toLowerCase()}`), ...extensions.map((ext) => `${unquoted}${ext.toUpperCase()}`)];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      if (existsSync(join(dir, name))) return true;
    }
  }
  return false;
}

function piCodingAgentDirForProfile(profileName: string): string | undefined {
  if (profileName === DEFAULT_PROFILE) return process.env.PI_CODING_AGENT_DIR;
  return join(homedir(), `.pi-${profileName}`);
}

function hasPiApiKey(): boolean {
  return PI_API_KEY_ENV_KEYS.some((key) => !!process.env[key]);
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

  // Validate the profile's auth/config: an OAuth license/subscription directory
  // (checked for auth.json/.credentials.json) or a profile config file's existence.
  function validateAuthOrConfig() {
    // Codex OAuth license (a CODEX_HOME directory, not a config toml): validate the
    // login by checking for auth.json, and skip the config-file existence check.
    const codexHome = provider === "codex"
      ? resolveCodexHomeForProfile(profileName, parseCodexLicenseRing(prefMap.get("codex_license_ring")))
      : undefined;
    // Claude OAuth subscription (a CLAUDE_CONFIG_DIR directory, not a settings_<name>.json):
    // validate the login by checking for .credentials.json, and skip the settings-file check.
    const claudeConfigDir = provider === "claude"
      ? resolveClaudeConfigDirForProfile(profileName, parseClaudeSubscriptionRing(prefMap.get("claude_subscription_ring")))
      : undefined;
    if (codexHome) {
      if (!codexHomeHasAuth(codexHome)) {
        errors.push(`Codex license '${profileName}' not logged in: no auth.json in ${codexHome} (run: $env:CODEX_HOME='${codexHome}'; codex login)`);
      }
    } else if (claudeConfigDir) {
      if (!claudeConfigDirHasAuth(claudeConfigDir)) {
        errors.push(`Claude subscription '${profileName}' not logged in: no .credentials.json in ${claudeConfigDir} (run: $env:CLAUDE_CONFIG_DIR='${claudeConfigDir}'; claude /login)`);
      }
    } else {
      const configPath = profileConfigPath(provider, profileName);
      if (configPath && !existsSync(configPath)) {
        errors.push(`Profile config not found: ${configPath}`);
      }
    }
  }
  validateAuthOrConfig();

  if (!settings.agentCommand) {
    warnings.push(`Using default ${DEFAULT_COMMAND_LABELS[provider]} command from PATH.`);
  }

  let flags: string[] = [];
  let command = sanitizeCommand(settings.agentCommand) || provider;
  // Pi auth: needs a provider API key OR an existing PI_CODING_AGENT_DIR.
  function validatePiAuth(codingAgentDir: string | undefined) {
    if (!hasPiApiKey() && !codingAgentDir) {
      errors.push(`Pi auth is not configured: set one of ${PI_API_KEY_ENV_KEYS.join(", ")} or select a Pi profile with an existing PI_CODING_AGENT_DIR.`);
    } else if (!hasPiApiKey() && codingAgentDir && existsSync(codingAgentDir)) {
      warnings.push("No Pi provider API key is set in the server environment; assuming auth is configured in PI_CODING_AGENT_DIR.");
    }
  }
  // Pi profiles need extra validation: the Pi binary on PATH, an existing
  // PI_CODING_AGENT_DIR for non-default profiles, and some form of auth.
  function validatePiProfile() {
    if (provider !== "pi") return;
    const launchCommand = settings.agentCommand || "pi";
    const resolvedCommand = !settings.agentCommand ? resolvePiExecutable(launchCommand) : undefined;
    command = sanitizeCommand(resolvedCommand || launchCommand) || "pi";
    if (!resolvedCommand && !commandExists(launchCommand)) {
      errors.push(`Pi command not found on PATH: ${sanitizeCommand(launchCommand) || "pi"}. Install @mariozechner/pi-coding-agent or set Agent Command to the Pi binary path.`);
    }

    const codingAgentDir = piCodingAgentDirForProfile(profileName);
    if (profileName !== DEFAULT_PROFILE) {
      if (!codingAgentDir || !existsSync(codingAgentDir)) {
        errors.push(`Pi profile '${profileName}' requires PI_CODING_AGENT_DIR ${codingAgentDir ?? "(not resolved)"} to exist.`);
      } else {
        flags.push(`PI_CODING_AGENT_DIR ${codingAgentDir}`);
      }
    } else if (codingAgentDir) {
      if (!existsSync(codingAgentDir)) {
        errors.push(`PI_CODING_AGENT_DIR does not exist: ${codingAgentDir}`);
      } else {
        flags.push(`PI_CODING_AGENT_DIR ${codingAgentDir}`);
      }
    }

    validatePiAuth(codingAgentDir);
  }
  validatePiProfile();

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
    flags = [...new Set([...flags, ...sanitizeFlags(launchConfig.args)])];
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
    version: null,
  };
}

/**
 * Fold a CLI version-probe verdict into a (synchronous) preflight result. A
 * below-minimum version becomes a hard error; a newer-than-known / unparseable /
 * unavailable probe a non-blocking warning (the binary-exists check already owns
 * "not installed"). A null verdict (probe skipped) returns the preflight unchanged
 * apart from recording `version: null`. Pure — no I/O.
 */
export function foldVersionIntoPreflight(
  preflight: AgentProfilePreflightResult,
  version: CliVersionResult | null,
): AgentProfilePreflightResult {
  if (!version) return { ...preflight, version: null };

  const errors = [...preflight.errors];
  const warnings = [...preflight.warnings];
  if (version.status === "below-min" && version.message) {
    errors.push(version.message);
  } else if (version.message && (version.status === "above-known" || version.status === "unparseable" || version.status === "unavailable")) {
    warnings.push(version.message);
  }

  return {
    ...preflight,
    errors,
    warnings,
    version,
    ok: errors.length === 0,
    status: errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ok",
  };
}

/**
 * Augment a (synchronous) preflight result with a CLI version probe. Runs
 * `<cli> --version` and folds the supported-range verdict in via
 * foldVersionIntoPreflight. Never throws — a probe failure must not block an
 * otherwise-healthy launch.
 *
 * Split from preflightAgentProfile because spawning `--version` is async; callers
 * that only need the static checks keep the synchronous function.
 */
export async function augmentPreflightWithVersion(
  preflight: AgentProfilePreflightResult,
  runner?: VersionRunner,
): Promise<AgentProfilePreflightResult> {
  // Skip the probe for the mock agent and when no real command resolved — those
  // are not third-party CLIs whose flag contract can drift.
  if (preflight.command === "mock-agent" || !preflight.command) {
    return { ...preflight, version: null };
  }

  let version: CliVersionResult;
  try {
    version = await detectCliVersion(preflight.provider, preflight.command, runner);
  } catch (err) {
    // Defensive: detectCliVersion is designed never to throw, but a probe failure
    // must never escalate into a preflight failure.
    version = {
      detected: false,
      raw: null,
      version: null,
      status: "unavailable",
      message: `Version probe error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return foldVersionIntoPreflight(preflight, version);
}

export async function listAgentProfileHealth(
  database: Database,
  profileLists: {
    claudeProfiles: string[];
    codexProfiles: string[];
    copilotProfiles: string[];
    piProfiles: string[];
  },
): Promise<AgentProfileHealthRow[]> {
  const prefRows = await getAllPreferences(database);
  const prefMap = new Map(prefRows.map((row) => [row.key, row.value]));
  const failureRows = new Map(
    prefRows
      .filter((row) => row.key.startsWith(FAILURE_PREFIX))
      .map((row) => [row.key, row.value]),
  );
  const selectedProvider = (prefMap.get("provider") === "codex" || prefMap.get("provider") === "copilot" || prefMap.get("provider") === "pi")
    ? prefMap.get("provider") as ProviderName
    : "claude";

  const candidates: Array<{ provider: ProviderName; profileName: string }> = [
    { provider: "claude", profileName: DEFAULT_PROFILE },
    ...profileLists.claudeProfiles.map((name) => ({ provider: "claude" as const, profileName: name })),
    { provider: "codex", profileName: DEFAULT_PROFILE },
    ...profileLists.codexProfiles.filter((name) => name !== DEFAULT_PROFILE).map((name) => ({ provider: "codex" as const, profileName: name })),
    { provider: "copilot", profileName: DEFAULT_PROFILE },
    ...profileLists.copilotProfiles.filter((name) => name !== DEFAULT_PROFILE).map((name) => ({ provider: "copilot" as const, profileName: name })),
    { provider: "pi", profileName: DEFAULT_PROFILE },
    ...profileLists.piProfiles.filter((name) => name !== DEFAULT_PROFILE).map((name) => ({ provider: "pi" as const, profileName: name })),
  ];

  const seen = new Set<string>();
  const uniqueCandidates = candidates.filter((candidate) => {
    const id = profileKey(candidate.provider, candidate.profileName);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // Run the static preflight for every candidate up front.
  const preflights = uniqueCandidates.map((candidate) => ({
    candidate,
    preflight: preflightAgentProfile(prefMap, candidate.provider, candidate.profileName),
  }));

  // Probe `<cli> --version` ONCE per distinct (provider, command) pair — many
  // profiles of the same provider share one binary, so we must not spawn the same
  // `--version` N times. Results are cached and folded into every profile that
  // resolved to that command.
  const versionByCmdKey = new Map<string, CliVersionResult | null>();
  const distinct = new Map<string, { provider: ProviderName; command: string }>();
  for (const { preflight } of preflights) {
    if (!preflight.command || preflight.command === "mock-agent") continue;
    const key = `${preflight.provider}:${preflight.command}`;
    if (!distinct.has(key)) distinct.set(key, { provider: preflight.provider, command: preflight.command });
  }
  await Promise.all(
    [...distinct].map(async ([key, { provider, command }]) => {
      try {
        versionByCmdKey.set(key, await detectCliVersion(provider, command));
      } catch {
        versionByCmdKey.set(key, null);
      }
    }),
  );

  return preflights.map(({ candidate, preflight: basePreflight }) => {
    const cmdKey = `${basePreflight.provider}:${basePreflight.command}`;
    const version = versionByCmdKey.get(cmdKey) ?? null;
    const preflight = foldVersionIntoPreflight(basePreflight, version);
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
