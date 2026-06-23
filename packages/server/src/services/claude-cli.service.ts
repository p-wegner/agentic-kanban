import { execFile } from "node:child_process";
import { db } from "../db/index.js";
import { buildAgentLaunchConfig, narrowProviderName, getProfilePrefKey } from "./agent-provider.js";
import type { Database } from "../db/index.js";
import { getClaudeCliPreferences } from "../repositories/claude-cli.repository.js";

export interface ClaudeCliOptions {
  timeout?: number;
  database?: Database;
  /** Optional model override, e.g. "haiku" */
  model?: string;
}

/**
 * Run a one-shot prompt through the configured agent provider and return its final
 * answer as plain text. Used by the internal AI utility services (issue enhancement,
 * voice capture, stack detection, …) — NOT for long-running interactive agents.
 *
 * The launch (provider selection, Windows binary resolution, profile→settings path,
 * env) is delegated to the provider registry via `buildAgentLaunchConfig({ oneShotText })`,
 * so there is ONE launch implementation per provider. This function no longer
 * reimplements that logic outside the provider abstraction.
 */
export async function invokeClaudePrompt(
  prompt: string,
  opts: ClaudeCliOptions = {}
): Promise<string> {
  const { timeout = 60000, database = db, model } = opts;

  let agentCommand: string | undefined;
  let providerPref: string | undefined;
  const profileByKey = new Map<string, string>();
  const prefs = await getClaudeCliPreferences(database);
  for (const p of prefs) {
    if (!p.value) continue;
    if (p.key === "agent_command") agentCommand = p.value;
    else if (p.key === "provider") providerPref = p.value;
    else profileByKey.set(p.key, p.value);
  }

  const providerName = narrowProviderName(providerPref);
  const profileName = profileByKey.get(getProfilePrefKey(providerName));

  const { command, args, env, useShell } = buildAgentLaunchConfig({
    provider: providerName === "claude" ? "claude-code" : providerName,
    oneShotText: true,
    agentCommand,
    model,
    ...(profileName ? { profile: { provider: providerName, name: profileName } } : {}),
  });

  return new Promise<string>((resolve, reject) => {
    const child = execFile(command, args, {
      encoding: "utf8",
      timeout,
      shell: useShell,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env,
    }, (err, stdout) => {
      if (err) reject(err instanceof Error ? err : new Error(err.message));
      else resolve(stdout ?? "");
    });
    child.stdin?.end(prompt);
  });
}
