/**
 * Spawn adapter for the test-impact skill's `impact.mjs` (#952).
 *
 * Split out of `test-impact-map.service.ts` so the pass's DECISIONS (stale? lock? commit?) are
 * testable without a child process, and so the CLI's exit-code contract is written down in one
 * place instead of being re-derived at each call site.
 */
import { execFile } from "node:child_process";

import { execFailedToRun, execSucceeded, type ExecResult } from "@agentic-kanban/shared/lib/exec-result";

/**
 * The shared exec-adapter result (#591), not a bespoke shape: `code: null` already means "never
 * spawned or signal-killed", which is the distinction this adapter needs and the one a private
 * interface would re-spell slightly differently.
 */
export type ImpactRunResult = ExecResult;

/** Injection seam: a function that runs `node <tool> <args...>` in `cwd`. */
export type ImpactMapRunner = (tool: string, args: string[], cwd: string) => Promise<ImpactRunResult>;

/**
 * Wall-clock budget for one CLI call. `build` is ~7.4s on this repo; the ceiling exists so a
 * pathological repo cannot hold the queue repo lock for the rest of the cycle.
 */
export const IMPACT_CLI_TIMEOUT_MS = 180_000;

const defaultRunner: ImpactMapRunner = (tool, args, cwd) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [tool, ...args],
      { cwd, timeout: IMPACT_CLI_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        // `execFile` reports a non-zero exit as an error carrying a numeric `code` — which is
        // this CLI's whole contract, not a failure. An error WITHOUT one never ran (ENOENT,
        // timeout), which is `code: null` per the ExecResult convention.
        const raw = (error as { code?: unknown } | null)?.code;
        const code = typeof raw === "number" ? raw : error ? null : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", error: error ?? null });
      },
    );
  });

/**
 * `impact.mjs check` — is the committed map still fresh vs HEAD?
 *
 * The exit codes are DATA, the way `git diff --quiet` exits 1 to mean "the trees differ" rather
 * than to report a failure. Enumerated so the read is a lookup, not a bare comparison:
 *   0 = fresh, 1 = stale, 2 = no map at all.
 *
 * Anything else (a crash, a spawn failure, `code: null`) reports FRESH — deliberately the
 * conservative direction: an unrecognised code means we do not know, and a broken CLI must not
 * be able to drive the pass into rebuilding and committing on every cycle.
 */
const STALE_EXIT_CODES: ReadonlySet<number> = new Set([1, 2]);

export async function runImpactMapCheck(
  tool: string,
  repoPath: string,
  runner: ImpactMapRunner = defaultRunner,
): Promise<{ fresh: boolean; detail: string }> {
  const res = await runner(tool, ["check"], repoPath);
  const detail = (res.stdout || res.stderr).trim().slice(0, 300);
  if (execSucceeded(res) || execFailedToRun(res)) return { fresh: true, detail };
  return { fresh: !STALE_EXIT_CODES.has(res.code as number), detail };
}

/**
 * `impact.mjs build [--durations <report>]` — regenerate the map in place.
 *
 * The durations report is re-fed on EVERY rebuild (#955): `build` reads durations only from
 * `--durations` and never carries them over from the previous map, so omitting it would erase
 * the measured times and silently return `select --budget` to its files x 3s estimate.
 */
export async function runImpactMapBuild(
  tool: string,
  repoPath: string,
  durationsReport: string | null,
  runner: ImpactMapRunner = defaultRunner,
): Promise<{ ok: boolean; detail: string }> {
  const args = ["build"];
  if (durationsReport) args.push("--durations", durationsReport);
  const res = await runner(tool, args, repoPath);
  const detail = (res.stdout || res.stderr).trim().slice(0, 400);
  return { ok: execSucceeded(res), detail };
}
