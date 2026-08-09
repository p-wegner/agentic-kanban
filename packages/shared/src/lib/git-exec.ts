import { execFile, execFileSync, spawn, type ChildProcess, type ExecFileException, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { recordOperation } from "./operation-metrics.js";

/**
 * The single sanctioned adapter for spawning the `git` CLI.
 *
 * Every git invocation in the codebase MUST go through one of these primitives —
 * spawning `git` directly via `child_process` anywhere else is forbidden and gated
 * by `packages/shared/__tests__/git-exec-single-spawn.test.ts`. Centralising the
 * spawn keeps the Windows quirks (`windowsHide`), buffer limits, timeouts and error
 * normalisation in one place, and makes git a single replaceable adapter at the
 * boundary of the app (clean-architecture: the git CLI is an external system; this
 * module is its port).
 *
 * Node-only: this imports `node:child_process`, so it must never be value-exported
 * from the `@agentic-kanban/shared/lib` barrel (that would white-screen the client
 * bundle, see #791). Import it via its deep path: `@agentic-kanban/shared/lib/git-exec`.
 */

/** Generous default for diff/log output; individual callers may narrow it. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Wall-clock ceiling applied to every buffered git invocation that does not set its
 * own `timeout`. Without it a single git call could block FOREVER — and one did: a
 * monitor-path git call that never returned kept `processWorkspaceCandidates` pending,
 * so the monitor cycle's `finally` never ran, `cycleRunning` stayed `true`, and every
 * later cycle short-circuited on the re-entrancy guard for every project until the
 * server was restarted (the #208 tail). Ten minutes is far longer than any legitimate
 * buffered call here (the largest is a shallow/`--single-branch` clone) while still
 * guaranteeing that a wedged git eventually dies. `gitStream` is deliberately exempt:
 * it carries packfiles for the worker-fleet smart-HTTP transport, which has no
 * meaningful upper bound and is already bounded by the HTTP request lifecycle.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Never let git block on a human. `GIT_TERMINAL_PROMPT=0` makes any credential /
 * host-key / passphrase prompt FAIL FAST instead of waiting on a tty that no server
 * process has, which is the most common way a git call hangs indefinitely on a
 * private remote. Merged over (not replacing) the caller's `env` so explicit
 * overrides like `GIT_INDEX_FILE` still apply, and over `process.env` when the
 * caller passes none, because `child_process`'s `env` option REPLACES the
 * environment rather than extending it.
 */
function nonInteractiveEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" };
}

export interface GitExecOptions {
  /** Working directory. Omit only for repo-path-as-argument commands like `clone`. */
  cwd?: string;
  /** Kill the process after this many ms (passed through to child_process). */
  timeout?: number;
  /** Max bytes of stdout/stderr to buffer. Defaults to 10 MiB. */
  maxBuffer?: number;
  /** Environment overrides (e.g. `GIT_INDEX_FILE`). Replaces the inherited env when set. */
  env?: NodeJS.ProcessEnv;
  /** Written to the process's stdin and closed (e.g. `hash-object --stdin`). Async variants only. */
  input?: string;
  /**
   * INSTRUMENTATION ONLY — override the metric label for this call and exclude it from
   * duplicate-spawn accounting. Changes nothing about how git is spawned or what it is asked to do.
   *
   * Exists for the monitor's environmental CONTROL spawn (#368): `git --version` does no repository
   * work, so it must be readable on its own line rather than blended into a real subcommand's
   * figures, and N identical control spawns inside one cycle would otherwise read as N-1 spawns a
   * per-cycle memo could have removed — corrupting the `duplicateSpawns` number that refuted #359's
   * recommended fix. The DURATION still flows through the same `recordOperation` call as every real
   * git operation, which is the whole point of a control: a control timed by a different mechanism
   * than the thing it controls for proves nothing.
   */
  probeLabel?: string;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  /**
   * Process exit code. `0` on success, the numeric exit code on a non-zero exit,
   * and `null` when the process was killed by a signal or failed to spawn (e.g.
   * `ENOENT`/timeout — see `error` for the cause).
   */
  code: number | null;
  /** The raw child_process error when git failed to run or exited non-zero, else `null`. */
  error: Error | null;
  /**
   * INSTRUMENTATION ONLY — the two durations this call contributed to `operation-metrics`, handed
   * back so a caller that needs the INDIVIDUAL sample (rather than a window aggregate) reads the
   * same numbers the registry got instead of re-timing the call its own way.
   *
   * Optional so the many hand-built `GitExecResult` fixtures in tests stay valid; `gitExec` always
   * populates it. `totalMs` is call-to-callback, `childMs` is the child's own lifetime from its
   * `exit` event (null when the process never spawned, e.g. ENOENT) — see the split's caveat in
   * `gitExec`.
   */
  timing?: { totalMs: number; childMs: number | null };
}

/**
 * Metric label of the monitor's environmental CONTROL spawn (#368).
 *
 * Exported because two readers must agree on it: the probe that emits it and the cycle report that
 * must EXCLUDE it from aggregates describing the cycle's real work.
 */
export const GIT_CONTROL_OPERATION_LABEL = "git:control";

function exitCodeOf(err: ExecFileException | null, hadError: boolean): number | null {
  if (!err) return hadError ? null : 0;
  return typeof err.code === "number" ? err.code : null;
}

/**
 * Run git and resolve with {stdout, stderr, code, error} — NEVER rejects on a
 * non-zero exit. Use this when the exit code itself is meaningful (e.g.
 * `diff --quiet`, allowed-exit-code probes) or when failures should be swallowed.
 */
export function gitExec(args: string[], opts: GitExecOptions = {}): Promise<GitExecResult> {
  const { cwd, timeout = DEFAULT_GIT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, env, input, probeLabel } = opts;
  const startedMs = Date.now();
  // #359 — the child's OWN lifetime, captured on its `exit` event, separately from the
  // call-to-callback figure below.
  //
  // Why this exists: `recordOperation` used to receive only `Date.now() - startedMs` measured
  // INSIDE the execFile callback, which Node delivers after stdio close AND after whatever else is
  // queued on the event loop. So a 90ms git process behind a congested loop was recorded as a
  // multi-second "git call", and with ~130 spawns per monitor cycle the metric inflated
  // arbitrarily. That is what produced `rev-parse` averages of 9,231ms and 9,153ms on two
  // independent cycles — 1% apart, implausibly stable for disk work — alongside `blockingMs: 0`,
  // while an out-of-process harness measures `git --version` at 88-138ms on this machine. Several
  // confident conclusions (a per-spawn tax, a git-specific penalty, an antivirus story) were drawn
  // from that number and are invalidated by this split.
  //
  // `exit` still arrives through the event loop, so this is a tighter bound rather than a perfect
  // one; read it beside the event-loop delay the monitor reports for the same window.
  let childExitMs: number | undefined;
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd, timeout, maxBuffer, windowsHide: true, env: nonInteractiveEnv(env) }, (err, stdout, stderr) => {
      const totalMs = Date.now() - startedMs;
      const childMs = childExitMs === undefined ? undefined : childExitMs - startedMs;
      recordOperation(
        probeLabel ?? gitOperationLabel(args),
        totalMs,
        false,
        // A control probe carries no call identity on purpose — see `probeLabel`.
        probeLabel === undefined ? spawnDedupeKey(args, cwd) : undefined,
        childMs,
      );
      let error: Error | null = err;
      // `spawn git ENOENT` conflates two very different failures (#271): a missing WORKING
      // DIRECTORY (deleted repo — deterministic, act on the project) and the git BINARY not
      // spawning (PATH broken or process/handle exhaustion — environmental, retryable).
      // Disambiguate here, at the single spawn site, so every caller reports the real cause.
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        error = cwd && !existsSync(cwd)
          ? new Error(`working directory does not exist: ${cwd} (repo deleted or moved?)`)
          : new Error("git could not be spawned (ENOENT) with the working directory present — PATH problem or process/handle exhaustion, NOT a missing repo");
      }
      resolve({
        stdout: stdout == null ? "" : stdout.toString(),
        stderr: stderr == null ? "" : stderr.toString(),
        code: exitCodeOf(err, err != null),
        error,
        timing: { totalMs, childMs: childMs ?? null },
      });
    });
    // Registered before any await point so a fast-exiting child cannot beat the listener.
    child.once("exit", () => { childExitMs = Date.now(); });
    if (input != null) child.stdin?.end(input);
  });
}

/**
 * Run git and resolve with raw stdout, rejecting with a normalised
 * `git <args> failed: <stderr|message>` Error on any non-zero exit. The standard
 * choice for commands whose output you want and whose failure should propagate.
 */
export async function gitExecOrThrow(args: string[], opts: GitExecOptions): Promise<string> {
  const result = await gitExec(args, opts);
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error.message}`);
  }
  return result.stdout;
}

export interface GitExecSyncOptions extends GitExecOptions {
  /** child_process stdio config; defaults to capturing stdout only. */
  stdio?: StdioOptions;
}

/**
 * Synchronous git. Returns stdout as a string (empty when stdout is not piped via
 * `stdio`). Throws the standard `execFileSync` error on a non-zero exit — preserve
 * the try/catch-as-boolean idiom (`diff --quiet`) by catching it.
 */
export function gitExecSync(args: string[], opts: GitExecSyncOptions): string {
  const { cwd, timeout = DEFAULT_GIT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, env, stdio } = opts;
  const startedMs = Date.now();
  try {
    const out = execFileSync("git", args, { cwd, timeout, maxBuffer, windowsHide: true, encoding: "utf8", stdio, env: nonInteractiveEnv(env) });
    return (out ?? "").toString();
  } finally {
    // `blocking: true` — this spawn holds the event loop for its whole duration, with a
    // ten-minute default ceiling. The `finally` matters: the try/catch-as-boolean idiom
    // (`diff --quiet`) throws on the interesting path, and an unrecorded throw would make the
    // most expensive calls the invisible ones (#359).
    // A synchronous spawn has no callback queue to wait in, so its wall clock IS the child's
    // lifetime — reported as both so `totalMs - childMs` reads 0 for sync calls and isolates the
    // async queue wait (#359).
    const elapsed = Date.now() - startedMs;
    recordOperation(gitOperationLabel(args), elapsed, true, spawnDedupeKey(args, cwd), elapsed);
  }
}

/**
 * Identity of one git invocation — the working directory plus the full argv.
 *
 * Only an open measurement window reads this, to count how many spawns inside that window repeated
 * a spawn it had already seen: the exact ceiling on what a window-scoped memo could remove. It
 * exists because #359's recommended fix (memoize per-cycle `rev-parse`) rested on an unmeasured
 * claim about that ceiling, and measuring it required patching this file. The answer, over five
 * consecutive live monitor cycles on 57 active workspaces: 5-9 of 33-58 `rev-parse` spawns per
 * cycle were exact repeats (12-16%), and 5-19 of 65-120 git spawns per cycle overall (7-25%,
 * median 12%) — against a cycle total that varied 46-85s between neighbouring cycles. So the memo
 * was NOT implemented: it could not have produced a measurable win, and it would have put a
 * cycle-lifetime cache next to the merge-gate SHAs that `#243` compares before and after a gate
 * run to prove nothing moved. Anyone tempted to retry it should re-read this counter first.
 */
function spawnDedupeKey(args: string[], cwd: string | undefined): string {
  return `${cwd ?? ""} ${args.join(" ")}`;
}

/**
 * Low-cardinality label for one git invocation: `git:status`, `git:rev-list`.
 *
 * The subcommand only — never a path, a ref or an id. `operation-metrics` is a live map with no
 * eviction, so an unbounded label set would be a slow leak, and "which git subcommand costs the
 * seconds" is the question #359 needs answered anyway. A leading `-c core.foo=bar` is skipped so
 * config-prefixed calls land on the same label as their bare equivalents.
 */
function gitOperationLabel(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || arg === "--git-dir" || arg === "-C" || arg === "--work-tree") { i++; continue; }
    if (arg.startsWith("-")) continue;
    return `git:${arg}`;
  }
  return "git:unknown";
}

/**
 * Streaming git for protocol plumbing (`upload-pack`/`receive-pack`
 * `--stateless-rpc`, used by the worker-fleet git smart-HTTP service). Returns
 * the raw ChildProcess with piped stdio so the caller can pipe an HTTP request
 * body into stdin and stream stdout back out — the buffered variants above
 * cannot carry multi-hundred-MB packfiles. Still the ONE sanctioned spawn site:
 * callers get a process handle, not the right to spawn git themselves.
 */
export function gitStream(args: string[], opts: Pick<GitExecOptions, "cwd" | "env"> = {}): ChildProcess {
  return spawn("git", args, {
    cwd: opts.cwd,
    env: nonInteractiveEnv(opts.env),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
