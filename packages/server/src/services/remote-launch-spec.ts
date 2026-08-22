/**
 * Build the `WorkerLaunchSpec` a TRUE-REMOTE fleet worker receives (#747).
 *
 * The board's providers build a launch config for the BOARD's machine — that is their
 * job, and for a host or container launch it is exactly right. It is wrong the moment
 * the config crosses a machine boundary:
 *
 *  - `claude-provider.ts` resolves `where claude.exe` into an absolute
 *    `C:\Users\...\claude.exe`. On a Linux worker that is ENOENT.
 *  - every provider derives `useShell` from the BOARD's `process.platform`. A Linux
 *    board therefore sends `useShell: false`, and a Windows worker cannot resolve the
 *    `claude.cmd` shim without a shell.
 *  - args carry board-host paths: `--mcp-config <board tmpdir>`, `--settings <board
 *    home>/.claude/settings_x.json`, copilot's `--attachment <board worktree>/...`, and
 *    codex's "direct entry" form (`node <board>/.../codex/bin.js`).
 *
 * The fix is NOT a board-side `if (workerOs === "linux")` — the board would be guessing
 * about a machine it cannot see. The spec instead describes INTENT (which provider,
 * which logical program, which args) and the worker resolves the executable and the
 * shell decision on its own platform (`worker/worker-command-resolver.ts`).
 *
 * Everything here is a pure function over an already-built launch config, so the
 * cross-OS behaviour is unit-testable with no worker, no Docker and no second machine.
 */
import { basename } from "node:path";
import type { WorkerLaunchIntent, WorkerLaunchSpec } from "@agentic-kanban/shared/lib/worker-protocol";
import { stripMcpConfigArgs } from "./agent-provider/container-wrap.js";

/**
 * Flags whose VALUE is a path on the BOARD's filesystem and which therefore cannot
 * travel. Each is dropped together with its value.
 *
 * - `--mcp-config` / `--additional-mcp-config`: names a file in the board's tmpdir, and
 *   the MCP server it configures talks to the loopback board API (see #749 — a fleet MCP
 *   bridge is the fix; shipping the file is not).
 * - `--settings`: the board's `~/.claude/settings_<profile>.json`. It selects a board-side
 *   agent PROFILE, i.e. a credential, which by decision 012 never leaves this machine —
 *   the worker authenticates with its own local login. Shipping the path would at best
 *   name nothing on the worker and at worst read as a request for credentials.
 */
export const HOST_PATH_VALUE_FLAGS: readonly string[] = [
  "--mcp-config",
  "--additional-mcp-config",
  "--settings",
];

/** Windows-absolute (`C:\...`, UNC) or POSIX-absolute — either way, a path of THIS machine. */
export function looksHostAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || /^\/[^/]/.test(value);
}

/**
 * The logical program name for a resolved executable path: no directory, no Windows
 * executable suffix. `C:\Users\me\.local\bin\claude.exe` -> `claude`.
 *
 * Deliberately the same reduction `containerCommandFor` performs for `docker exec`, kept
 * as its own function because the two boundaries are independent: a container is the same
 * machine with a different filesystem, a worker is a different machine entirely, and
 * collapsing them would make one ticket's change silently alter the other's behaviour.
 */
export function logicalProgramName(command: string): string {
  const base = basename(command.replace(/\\/g, "/"));
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

/** Drop every {@link HOST_PATH_VALUE_FLAGS} flag together with its value (both forms). */
export function stripHostPathArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (HOST_PATH_VALUE_FLAGS.includes(arg)) {
      i++; // skip the value too
      continue;
    }
    if (HOST_PATH_VALUE_FLAGS.some((flag) => arg.startsWith(`${flag}=`))) continue;
    out.push(arg);
  }
  return out;
}

/**
 * Rewrite copilot's `--attachment <board worktree path>` to the bare filename.
 *
 * The attached files are the ticket-context files, which now travel as CONTENT and are
 * written into the worker's checkout ROOT (#749). The agent's cwd IS that root, so a
 * relative name resolves there — whereas the board path names nothing on the worker.
 */
export function relativizeAttachmentArgs(args: string[]): string[] {
  return args.map((arg, index) =>
    args[index - 1] === "--attachment" && looksHostAbsolutePath(arg)
      ? basename(arg.replace(/\\/g, "/"))
      : arg,
  );
}

/**
 * Undo the codex "direct entry" optimisation (`node <board>/.../codex/bin.js`).
 *
 * `resolveCodexDirect` rewrites the command to the board's own `process.execPath` and
 * prepends the resolved JS entry point — a board-host path, launched by a board-host node
 * binary. Neither exists on the worker, so the remote form is the plain `codex` program
 * the worker resolves for itself.
 */
export function undoDirectEntryArgs(args: string[]): string[] {
  const out = [...args];
  while (out.length > 0 && looksHostAbsolutePath(out[0]) && /\.(js|mjs|cjs|ts)$/i.test(out[0])) {
    out.shift();
  }
  return out;
}

export interface RemoteLaunchSpecParams {
  /** The provider launch config as built for the board host. */
  config: {
    command: string;
    args: string[];
    useShell?: boolean;
    keepStdinOpen?: boolean;
    suppressStdinPrompt?: boolean;
    isMockAgent?: boolean;
  };
  env: Record<string, string>;
  cwd: string;
  stdinPrompt?: string;
  hangTimeoutMs?: number;
  /** Provider name the session selected ("claude" | "codex" | "copilot" | "pi"). */
  provider?: string;
  /**
   * True when the worker does NOT share this filesystem (git transport). Only then is the
   * config's board-shaped command/args wrong; a same-machine worker runs in the board's
   * own worktree and keeps host paths exactly as it keeps them in env.
   */
  trueRemote: boolean;
  /**
   * The caller passed an explicit `agentCommand` (or `KANBAN_AGENT_COMMAND` is set, which
   * `isMockAgent` reflects). Then the command is NOT a provider's platform guess — it is
   * the exact command the operator asked for, so it travels verbatim and no intent is
   * derived. That is also what keeps the mock-agent fleet e2e suites meaningful.
   */
  explicitCommand: boolean;
}

/** The launch intent for a remote provider launch, or null when the command is explicit. */
export function buildLaunchIntent(params: RemoteLaunchSpecParams): WorkerLaunchIntent | null {
  if (!params.trueRemote || params.explicitCommand) return null;
  const provider = params.provider ?? "claude";
  // For codex's direct-entry form the board's command is the board's own node binary,
  // which is NOT the program to resolve remotely — the provider name is.
  const derived = logicalProgramName(params.config.command);
  const program = derived === "node" ? provider : derived;
  return { provider, program };
}

/**
 * Build the spec sent to a worker. For a same-filesystem worker this is the config
 * verbatim; for a true-remote worker it is the platform-independent intent form.
 */
export function buildRemoteLaunchSpec(params: RemoteLaunchSpecParams): WorkerLaunchSpec {
  const { config, env, cwd, stdinPrompt, hangTimeoutMs, trueRemote } = params;
  const base = {
    args: config.args,
    env,
    cwd,
    stdinPrompt,
    keepStdinOpen: config.keepStdinOpen,
    suppressStdinPrompt: config.suppressStdinPrompt,
    hangTimeoutMs,
  };
  if (!trueRemote) {
    return { ...base, command: config.command, useShell: config.useShell };
  }
  const intent = buildLaunchIntent(params);
  if (!intent) {
    // Explicit command: keep it (and its shell decision) as given, but the MCP config
    // still names a board-host file that would abort the launch outright.
    return { ...base, command: config.command, useShell: config.useShell, args: stripMcpConfigArgs(config.args) };
  }
  let args = relativizeAttachmentArgs(stripHostPathArgs(config.args));
  if (intent.program !== logicalProgramName(config.command)) {
    args = undoDirectEntryArgs(args);
  }
  const leftover = args.filter((a) => looksHostAbsolutePath(a));
  if (leftover.length > 0) {
    // Not fatal — dropping an unrecognised argument could corrupt argv in a way that is
    // harder to diagnose than the path itself. But it is always a bug, so say so.
    console.warn(
      `[agent-remote] remote launch spec still carries board-host path argument(s): ${leftover.join(", ")} — ` +
        "they will not resolve on the worker",
    );
  }
  return {
    ...base,
    args,
    // The logical program, so an older worker that ignores `intent` is at least not handed
    // another machine's absolute path. `useShell` is deliberately OMITTED: it is the
    // worker's decision, and a board-derived value here is the #747 bug itself.
    command: intent.program,
    intent,
  };
}
