import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { allocateFreePorts } from "./port-allocator.js";

/**
 * Run the E2E smoke lane on ALLOCATED ports (#660).
 *
 * `pnpm test:e2e:smoke` is the cheap green lane #645 built: 22 tests, measured at 51.5 s,
 * booting its own isolated server+client. Automating it is the point of #660 — but the lane
 * pins 3901/5973 (`packages/e2e/ports.ts`) with `reuseExistingServer: false` on both servers.
 *
 * That is exactly right for a developer running it by hand — it is what stops a run adopting
 * the live dev board — and exactly wrong for the merge gate, which runs per workspace and can
 * run for several concurrently: two simultaneous runs would both try to bind 3901 and the
 * second would fail. A gate that goes red on SCHEDULING is worse than no gate, because people
 * learn to re-run it.
 *
 * The seam already exists: `E2E_SERVER_PORT`/`E2E_CLIENT_PORT` read `SERVER_PORT`/`VITE_PORT`
 * first. So allocate a free pair per run and pass them in. Nothing about the lane's isolation
 * changes — it still never reuses a server, it just stops assuming it is the only run.
 */

export interface E2ESmokeResult {
  /** True only when the lane ran to completion and every test passed. */
  passed: boolean;
  /**
   * True when the lane could not produce a verdict — not installed, spawn failure, timeout.
   * Callers MUST treat this as inconclusive rather than red (#644): an infrastructure problem
   * must never read as "your branch is broken".
   */
  inconclusive: boolean;
  message: string;
}

/** Generous: a cold isolated stack boots two servers (120 s budget each) before the ~52 s run. */
export const E2E_SMOKE_TIMEOUT_MS = 8 * 60 * 1000;

/**
 * Is there an e2e package to run at all? A worktree of an older commit, or a consumer install,
 * legitimately has none — that is inconclusive-but-fine, never a failure.
 */
export function e2eLaneExists(repoRoot: string): boolean {
  return existsSync(join(repoRoot, "packages", "e2e", "playwright.config.ts"));
}

export async function runE2ESmokeLane(
  repoRoot: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<E2ESmokeResult> {
  if (!e2eLaneExists(repoRoot)) {
    return { passed: false, inconclusive: true, message: "no packages/e2e in this checkout — smoke lane not run" };
  }

  let ports: Record<string, number>;
  try {
    ports = await allocateFreePorts(["server", "client"]);
  } catch (err) {
    return {
      passed: false,
      inconclusive: true,
      message: `could not allocate ports for the E2E smoke lane: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return await new Promise<E2ESmokeResult>((resolve) => {
    const child = execFile(
      "pnpm",
      ["--filter", "e2e", "test:smoke"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: opts.timeoutMs ?? E2E_SMOKE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: process.platform === "win32",
        env: {
          ...(opts.env ?? process.env),
          // The whole point: the lane reads these before its 3901/5973 defaults.
          SERVER_PORT: String(ports.server),
          VITE_PORT: String(ports.client),
        },
      },
      (err, stdout, stderr) => {
        const tail = `${stdout ?? ""}${stderr ?? ""}`.trim().split(/\r?\n/).slice(-12).join("\n");
        if (!err) {
          resolve({ passed: true, inconclusive: false, message: `E2E smoke lane passed on ports ${ports.server}/${ports.client}` });
          return;
        }
        // A wall-clock kill is not a test failure — same distinction the verify gate draws.
        const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
        if (killed) {
          resolve({
            passed: false,
            inconclusive: true,
            message: `E2E smoke lane timed out after ${opts.timeoutMs ?? E2E_SMOKE_TIMEOUT_MS}ms — inconclusive, not a test failure`,
          });
          return;
        }
        resolve({ passed: false, inconclusive: false, message: `E2E smoke lane failed:\n${tail}` });
      },
    );
    child.stdin?.end();
  });
}

/**
 * Decide whether the pre-merge gate should RUN the E2E smoke lane (#660).
 *
 * A `decision function` (see packages/server/CLAUDE.md): pure and synchronous, co-located
 * with the executor that acts on it. The gate's own branch reads a preference, a worktree
 * path and a diff classification and then does I/O, so without this split the whole table of
 * cheap cases below would need a database and a spawned Playwright run to exercise.
 *
 * `inconclusive` is a THIRD outcome, not a flavour of skip: "the operator asked for this
 * check and we could not perform it" must reach the gate message, while "docs-only, so the
 * check cannot have changed" is a clean, silent skip.
 */
export function decideE2ESmokeStage(input: {
  enabled: boolean;
  hasWorktree: boolean;
  docsOnly: boolean;
  laneExists: boolean;
}): { action: "run" | "skip" | "inconclusive"; reason: string } {
  if (!input.enabled) return { action: "skip", reason: "not enabled for this project" };
  if (!input.hasWorktree) return { action: "inconclusive", reason: "workspace has no worktree" };
  // Checked BEFORE the lane's existence: a docs-only diff is a clean skip whether or not the
  // lane is present, and reporting "no packages/e2e" for a diff we would not have run anyway
  // would put a warning on the gate for no reason.
  if (input.docsOnly) return { action: "skip", reason: "docs-only diff (#198)" };
  if (!input.laneExists) return { action: "inconclusive", reason: "no packages/e2e in this worktree" };
  return { action: "run", reason: "enabled, non-docs diff, lane present" };
}
