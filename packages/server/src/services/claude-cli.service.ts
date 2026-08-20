import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import { db } from "../db/index.js";
import { buildAgentLaunchConfig, narrowProviderName, getProfilePrefKey } from "./agent-provider.js";
import type { Database } from "../db/index.js";
import { getClaudeCliPreferences } from "../repositories/claude-cli.repository.js";
import { toExecutorProvider } from "./agent-settings.service.js";

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
    provider: toExecutorProvider(providerName),
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
    }, (err, stdout, stderr) => {
      if (err) reject(describeCliFailure(err, stderr, timeout));
      else resolve(stdout ?? "");
    });
    child.stdin?.end(prompt);
  });
}

/**
 * Turn an `execFile` failure into an error that says WHAT went wrong (#665).
 *
 * The previous form rejected with `err.message` alone, which for a spawned CLI is always the
 * same sentence: `Command failed: claude.exe --output-format text -p`. A timeout, a missing
 * login, an exhausted quota and a bad flag all produced that identical line, so diagnosing a
 * failed AI operation meant reading this file to form a hypothesis — which is exactly what
 * happened when `group-scan` broke.
 *
 * `execFile` already carries the distinguishing facts: `killed` + `signal` for a timeout
 * kill, `code` for an ordinary non-zero exit, and the child's own stderr. Naming the timeout
 * explicitly matters most, because it is the one failure whose fix is a config change rather
 * than an auth problem.
 */
export function describeCliFailure(
  err: ExecFileException,
  stderr: string | undefined,
  timeoutMs: number,
): Error {
  const parts: string[] = [];
  if (err.killed && err.signal) {
    parts.push(`timed out after ${timeoutMs}ms (killed with ${err.signal})`);
  } else if (typeof err.code === "number") {
    parts.push(`exited ${err.code}`);
  } else if (err.code) {
    parts.push(String(err.code));
  }
  const tail = (stderr ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-5).join("\n");
  if (tail) parts.push(`stderr:\n${tail}`);
  const detail = parts.length > 0 ? ` — ${parts.join("; ")}` : "";
  return new Error(`${err.message}${detail}`);
}

/** Test seam for the error-surface contract (#665). */
export { describeCliFailure as __describeCliFailureForTests };
