import { execFile, type ExecFileException } from "node:child_process";
import { execSucceeded, type ExecResult } from "./exec-result.js";

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

/**
 * #591 — the shared shape, not a docker-specific one. The alias is kept so existing imports and
 * the doc comments that name it still resolve; what changed is that a spawn failure now reports
 * `code: null` like git does, instead of the `-1` docker used to invent.
 */
export type DockerExecResult = ExecResult;

export interface DockerExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Run docker and resolve with {stdout, stderr, code, error} — NEVER rejects. On a
 * non-zero exit `code` is the numeric exit code; on a spawn failure (ENOENT/timeout)
 * `code` is null and `error` holds the cause.
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
          const code = typeof rawCode === "number" ? rawCode : null;
          resolve({ stdout: out, stderr: errOut, code, error: err });
          return;
        }
        resolve({ stdout: out, stderr: errOut, code: 0, error: null });
      },
    );
  });
}

/** true if `docker version` exits 0 within a short timeout. */
export async function dockerAvailable(env?: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await dockerExec(["version"], { env, timeoutMs: 5000 });
  return execSucceeded(result);
}
