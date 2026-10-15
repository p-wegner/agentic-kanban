import { execFile, spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";
import { promisify } from "node:util";
import { recordOperation } from "@agentic-kanban/shared/lib/operation-metrics";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

const execFileAsync = promisify(execFile);

export interface ExecCommandOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  /** cmd.exe-only concern — see shellCommandSpec. Leave unset for real executables. */
  windowsVerbatimArguments?: boolean;
}

export interface ShellCommandOptions extends ExecCommandOptions {
  mergeEnv?: Record<string, string>;
}

export interface SpawnShellCommandOptions {
  cwd?: string;
  detached?: boolean;
  stdio?: StdioOptions;
  env?: NodeJS.ProcessEnv;
  mergeEnv?: Record<string, string>;
}

export interface OsProcessRecord {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
}

export interface OsPortListener {
  pid: number;
  port: number;
  address: string;
  protocol: "tcp" | "udp";
}

function mergedEnv(options: Pick<ShellCommandOptions, "env" | "mergeEnv">): NodeJS.ProcessEnv {
  if (options.mergeEnv) return { ...(options.env ?? process.env), ...options.mergeEnv };
  return options.env ?? process.env;
}

export function shellCommandSpec(
  command: string,
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  // On Windows the command must reach cmd.exe VERBATIM. With the default
  // windowsVerbatimArguments:false, Node re-quotes the single command arg and escapes
  // embedded double-quotes as \" — an escape cmd.exe does not understand — so every
  // legitimately-quoted argument (e.g. a plugin command's "{{leadingRepoPath}}") reached
  // the child with LITERAL quote characters (found live: click rejected the repo path as
  // Directory '"C:\..."' does not exist). Same bug and same fix as setup-script.ts (#111),
  // whose comment already claimed — wrongly, until now — that this function matched it.
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", command], windowsVerbatimArguments: true };
  }
  return { command: "/bin/sh", args: ["-c", command], windowsVerbatimArguments: false };
}

export async function execCommand(
  command: string,
  args: string[],
  options: ExecCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  // Counted (#359). This is the OTHER spawn adapter besides git-exec, and on Windows the calls it
  // makes are the expensive ones the monitor's `resource-sweep` depends on: a full
  // `Get-CimInstance Win32_Process` enumeration (documented as timing out at 225+ processes), a
  // `netstat -ano`, and one `taskkill /T /F` per reaped tree. Attributing seconds to `exec:*`
  // rather than to a phase name is the point of the instrumentation.
  const startedMs = Date.now();
  try {
    return await execCommandInner(command, args, options);
  } finally {
    recordOperation(`exec:${execOperationLabel(command)}`, Date.now() - startedMs);
  }
}

/**
 * Low-cardinality label: the executable's base name, lowercased, with no path and no arguments.
 * `operation-metrics` never evicts, so an unbounded label set would be a slow leak.
 */
function execOperationLabel(command: string): string {
  const base = command.replace(/\\/g, "/").split("/").pop() ?? command;
  return base.toLowerCase();
}

async function execCommandInner(
  command: string,
  args: string[],
  options: ExecCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    windowsHide: true,
    env: options.env,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
  });
  return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
}

export async function execShellCommand(
  command: string,
  options: ShellCommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const spec = shellCommandSpec(command);
  return execCommand(spec.command, spec.args, {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: mergedEnv(options),
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
}

export function spawnShellCommand(command: string, options: SpawnShellCommandOptions = {}): ChildProcess {
  const spec = shellCommandSpec(command);
  return spawn(spec.command, spec.args, {
    cwd: options.cwd,
    detached: options.detached,
    windowsHide: true,
    stdio: options.stdio,
    env: mergedEnv(options),
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  } satisfies SpawnOptions);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM"; // exists, just not ours to signal
  }
}

/**
 * `taskkill /T /F` exits non-zero when a descendant had already exited ("process not found",
 * localized — German "keine Instanz"), though nothing is left to kill (#1491). Rather than
 * parse that text, check the outcome: every pid the output names, and the root, must be gone.
 * A pid that survives keeps the original error.
 */
export async function taskkillTree(
  pid: number,
  options: { timeout?: number; isAlive?: (pid: number) => boolean; exec?: typeof execCommand } = {},
): Promise<void> {
  try {
    await (options.exec ?? execCommand)("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: options.timeout ?? 5000 });
  } catch (err) {
    const isAlive = options.isAlive ?? pidIsAlive;
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const text = [e.stdout, e.stderr, e.message].filter((s): s is string => typeof s === "string").join("\n");
    const named = new Set([pid, ...(text.match(/\b\d{2,}\b/g) ?? []).map(Number)]);
    if ([...named].some((p) => isAlive(p))) throw err;
  }
}

/**
 * Kill one process (and, on Windows, its tree) — the ONE platform decision (#828).
 *
 * It lives here, beside `listOsProcesses`/`taskkillTree`, so a caller does not have to
 * branch on `process.platform` itself. That branch is why the parentless-child-server
 * sweep was only ever TESTED on Windows: the win32 half called this module (mockable),
 * while the POSIX half called `process.kill` directly, so on Linux the test asked the OS
 * to SIGKILL a made-up pid, got ESRCH, and counted zero kills.
 *
 * POSIX kills the pid itself, not its group — same reach as before; making it a group
 * kill would be a behaviour change, not a portability fix. Callers that NEED the group
 * opt in with `group: true` (#833), so the default reach of every #832 call site is
 * unchanged.
 *
 * `group` is POSIX-ONLY and off by default. It exists for children spawned with
 * `detached: true` AND `shell: true`: there the pid is `/bin/sh`, and a shell only
 * `exec`s through to the agent when the command is a single simple command. Give it a
 * pipeline, an `&&`, or a trailing redirect and `sh` stays a real parent — signalling
 * the bare pid then kills the shell and leaves the agent running while the board
 * believes the session is stopped (#833, follow-up to #828). `detached: true` makes the
 * child a process-group leader (`pgid === pid`), so `process.kill(-pid, sig)` reaches
 * the shell AND everything it forked. It falls back to the bare pid when the group
 * does not exist (ESRCH — the child was not detached, so it shares OUR group and
 * `-pid` names no group), which is exactly the pre-#833 behaviour.
 *
 * Windows needs no equivalent: `taskkill /T /F` is already a whole-tree kill, so `group`
 * is inert there rather than a second code path that could disagree.
 *
 * `signal` is POSIX-ONLY and defaults to SIGKILL (#832). Windows has no signals: `taskkill
 * /T /F` is always a forced tree kill, so passing SIGTERM does not make the Windows half
 * gentler and must not be read as if it did. It exists because the two dev-server sweeps in
 * `process-cleanup.ts` deliberately send SIGTERM — a dev supervisor is asked to shut down,
 * not shot — and moving them onto this seam must not silently escalate that to SIGKILL.
 */
export async function killProcessTree(
  pid: number,
  options: { timeout?: number; signal?: NodeJS.Signals; group?: boolean } = {},
): Promise<void> {
  if (process.platform === "win32") {
    await taskkillTree(pid, options);
    return;
  }
  const signal = options.signal ?? "SIGKILL";
  if (options.group) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (err) {
      // Not a group leader (never detached) — fall through to the bare pid, which is
      // what this seam did before `group` existed. Any other failure is the caller's
      // to see, so it is re-thrown by the bare-pid call below.
      if ((err as NodeJS.ErrnoException)?.code !== "ESRCH") throw err;
    }
  }
  process.kill(pid, signal);
}

import {
  parseLsofPids,
  parseNetstatListenerPids,
  parseNetstatListeners,
  parsePowerShellProcessList,
  parsePsProcessList,
} from "./process-exec-parsers.js";

export {
  parseLsofPids,
  parseNetstatListenerPids,
  parseNetstatListeners,
  parsePowerShellProcessList,
  parsePsProcessList,
  parseWmicProcessList,
  safeParsePowerShellJson,
} from "./process-exec-parsers.js";

export async function listOsProcesses(): Promise<OsProcessRecord[]> {
  if (process.platform === "win32") {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    try {
      const { stdout } = await execCommand("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 10000 });
      return parsePowerShellProcessList(stdout);
    } catch (err) {
      // Same best-effort rule as the POSIX branch below — but this is the branch that
      // actually bites, because the board runs on Windows. Enumerating every process with
      // its full CommandLine through CIM + ConvertTo-Json is expensive: on a loaded box
      // (measured: 225+ processes) it exceeded the 10s timeout and threw, which aborted the
      // WHOLE monitor cycle at the resource-sweep phase — before auto-start ever ran. The
      // observable effect was a board that silently stopped starting tickets: freshly
      // planned work parked for tens of minutes until some cycle happened to win the race,
      // and every cycle logged only "[monitor] Cycle error: Command failed: powershell.exe".
      // Hygiene must never be able to stop the monitor from doing its actual job.
      console.warn(`[resource-sweep] process enumeration failed, skipping stale-process hygiene this cycle: ${errorMessage(err)}`);
      return [];
    }
  }

  try {
    const { stdout } = await execCommand("ps", ["-eo", "pid=,ppid=,comm=,args="], { timeout: 10000 });
    return parsePsProcessList(stdout);
  } catch (err) {
    // procps ("ps") is not installed in every runtime image (e.g. node:*-slim Docker
    // images). Resource-sweep hygiene is best-effort, not load-bearing, so degrade to
    // "no processes found" instead of throwing and spamming [resource-sweep] warnings
    // every monitor cycle.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

export async function listOsPortListeners(): Promise<OsPortListener[]> {
  const { stdout } = await execCommand("netstat", ["-ano"], { timeout: 10000 });
  return parseNetstatListeners(stdout);
}

export async function listenerPidsForPort(port: number): Promise<number[]> {
  if (process.platform === "win32") {
    const { stdout } = await execCommand("netstat", ["-ano", "-p", "TCP"], { timeout: 10000 });
    return parseNetstatListenerPids(stdout, port);
  }

  try {
    const { stdout } = await execCommand("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { timeout: 10000 });
    return parseLsofPids(stdout);
  } catch {
    return [];
  }
}
