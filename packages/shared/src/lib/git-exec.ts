import { execFile, execFileSync, spawn, type ChildProcess, type ExecFileException, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";

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
}

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
  const { cwd, timeout = DEFAULT_GIT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, env, input } = opts;
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd, timeout, maxBuffer, windowsHide: true, env: nonInteractiveEnv(env) }, (err, stdout, stderr) => {
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
      });
    });
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
  const out = execFileSync("git", args, { cwd, timeout, maxBuffer, windowsHide: true, encoding: "utf8", stdio, env: nonInteractiveEnv(env) });
  return (out ?? "").toString();
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
