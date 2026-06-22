import { execFile, execFileSync, type ExecFileException, type StdioOptions } from "node:child_process";

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
  const { cwd, timeout, maxBuffer = DEFAULT_MAX_BUFFER, env, input } = opts;
  return new Promise((resolve) => {
    const child = execFile("git", args, { cwd, timeout, maxBuffer, windowsHide: true, env }, (err, stdout, stderr) => {
      const error = (err as ExecFileException | null) ?? null;
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        code: exitCodeOf(error, err != null),
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
  const { cwd, timeout, maxBuffer = DEFAULT_MAX_BUFFER, stdio } = opts;
  const out = execFileSync("git", args, { cwd, timeout, maxBuffer, windowsHide: true, encoding: "utf8", stdio });
  return (out ?? "").toString();
}
