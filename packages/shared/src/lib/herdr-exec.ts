import { execFile, type ExecFileException } from "node:child_process";
import { execSucceeded, type ExecResult } from "./exec-result.js";

/**
 * The single sanctioned adapter for spawning the `herdr` CLI (mirrors
 * `docker-exec.ts` / `devcontainer-exec.ts` — herdr is an external system and
 * this module is its port).
 *
 * herdr (github.com/herdrdev/herdr, or our fork github.com/p-wegner/herdr) is a
 * terminal multiplexer whose background server hosts long-lived panes that
 * survive a terminal window closing. It is NOT an LLM agent harness like
 * Claude/Codex/Pi — it does not itself run a coding agent, it hosts one. So it
 * is deliberately NOT a `PROVIDER_NAMES` entry; see
 * `packages/server/src/services/herdr-availability.service.ts` for how the
 * board uses it (an optional launch-placement concern, closer to the
 * devcontainer/worker-fleet placement kinds than to a fourth provider).
 *
 * Node-only: imports `node:child_process`, so it must never be value-exported
 * from the `@agentic-kanban/shared/lib` barrel (#791 — that would white-screen
 * the client bundle). Import the runtime via its deep path
 * `@agentic-kanban/shared/lib/herdr-exec`.
 */

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

export type HerdrExecResult = ExecResult;

export interface HerdrExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Run herdr and resolve with {stdout, stderr, code, error} — NEVER rejects. On a
 * non-zero exit `code` is the numeric exit code; on a spawn failure (ENOENT/timeout,
 * e.g. herdr not installed) `code` is null and `error` holds the cause.
 */
export function herdrExec(args: string[], options: HerdrExecOptions = {}): Promise<HerdrExecResult> {
  const { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    execFile(
      "herdr",
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

/**
 * True when a `herdr` binary is reachable on PATH and reports a version — the
 * cheapest possible discovery probe. Never throws.
 */
export async function herdrAvailable(options: HerdrExecOptions = {}): Promise<boolean> {
  const result = await herdrExec(["--version"], options);
  return execSucceeded(result);
}

/** Parsed `herdr --version` output, e.g. `0.9.1-fork.5` from `herdr 0.9.1-fork.5`. */
export function parseHerdrVersion(stdout: string): string | undefined {
  const match = stdout.trim().match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  return match?.[1];
}

/**
 * Probe the `herdr` CLI once and report both availability and version. Used by
 * the board's discovery service; kept here (rather than server-side) so a unit
 * test can exercise it against a fake `execFile` without spinning up services.
 */
export async function probeHerdr(options: HerdrExecOptions = {}): Promise<{ available: boolean; version?: string }> {
  const result = await herdrExec(["--version"], options);
  if (!execSucceeded(result)) return { available: false };
  return { available: true, version: parseHerdrVersion(result.stdout) };
}
