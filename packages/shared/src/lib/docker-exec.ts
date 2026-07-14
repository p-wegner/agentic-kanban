import { execFile, type ExecFileException } from "node:child_process";

/**
 * The single sanctioned adapter for spawning the `docker` CLI.
 *
 * Mirrors `git-exec.ts`: it centralises the Windows quirks (`windowsHide`), buffer
 * limits, timeouts and error normalisation, and makes docker a single replaceable
 * adapter at the boundary of the app (clean-architecture: the docker CLI is an
 * external system; this module is its port). All `docker` / `docker compose`
 * invocations should go through here.
 *
 * Node-only: this imports `node:child_process`, so it must never be value-exported
 * from the `@agentic-kanban/shared/lib` barrel (that would white-screen the client
 * bundle, see #791). It is re-exported from the barrel as `export type *` only.
 * Import the runtime via its deep path: `@agentic-kanban/shared/lib/docker-exec`.
 */

/** Generous default for compose/log output; individual callers may narrow it. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/** Default kill timeout for a docker invocation (ms). */
const DEFAULT_TIMEOUT_MS = 120000;

export interface DockerExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code. `0` on success, the numeric exit code on non-zero exit, `-1` when the process failed to spawn (see `error`). */
  code: number;
  /** The spawn/exec error message when docker failed to run, else undefined. */
  error?: string;
}

export interface DockerExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Run docker and resolve with {stdout, stderr, code, error} — NEVER rejects. On a
 * non-zero exit `code` is the numeric exit code; on a spawn failure (ENOENT/timeout)
 * `code` is -1 and `error` holds the message.
 */
export function dockerExec(args: string[], opts: DockerExecOptions = {}): Promise<DockerExecResult> {
  const { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  return new Promise((resolve) => {
    execFile(
      "docker",
      args,
      { cwd, env, timeout: timeoutMs, maxBuffer: DEFAULT_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        const out = stdout == null ? "" : stdout.toString();
        const errOut = stderr == null ? "" : stderr.toString();
        if (err) {
          const rawCode = (err as ExecFileException).code;
          const code = typeof rawCode === "number" ? rawCode : -1;
          resolve({ stdout: out, stderr: errOut, code, error: err.message });
          return;
        }
        resolve({ stdout: out, stderr: errOut, code: 0 });
      },
    );
  });
}

/** true if `docker version` exits 0 within a short timeout. */
export async function dockerAvailable(env?: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await dockerExec(["version"], { env, timeoutMs: 5000 });
  return result.code === 0;
}
