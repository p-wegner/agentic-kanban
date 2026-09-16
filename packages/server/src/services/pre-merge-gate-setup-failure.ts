import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db/index.js";
import { getSetupRunForGate } from "../repositories/workspace-setup-run.repository.js";

/**
 * #1123 — a workspace whose latest `workspace_setup_run` FAILED must never reach a merge,
 * independent of `setup_blocking`.
 *
 * `setupFailedBlocking` (#169) refuses the LAUNCH, but only for a project with
 * `setup_blocking = 1`. On `setup_blocking = 0` (background installs — today only
 * `agentic-kanban` itself) a failed install never blocked the launch: the agent starts anyway,
 * works in a worktree with no dependencies, commits, and can reach Ready-to-merge having never
 * run a single test. `born-blocked-reconciler.ts` retries a failed setup, but only for a
 * workspace BORN `blocked`, which itself requires `setup_blocking = 1` — a non-blocking failure
 * has no recovery path at all. This is the one place left that can still refuse the branch.
 *
 * Deliberately never throws (mirrors `describeOutstandingRepoInstalls`): an unreadable row
 * means we cannot tell, and refusing every merge in the project on that would be worse than the
 * failure this guards against.
 *
 * #1172 — a `failed` row can go stale: nothing restamps it once the underlying cause (e.g. a
 * corrupt pnpm store) is fixed by hand and a later install actually succeeds, because
 * `POST /:id/setup` no-ops once `workingDir` is set and the born-blocked reconciler only
 * retries workspaces BORN blocked. The corroboration check below is what tells a stale `failed`
 * verdict apart from a live one — a `node_modules/.bin` that is actually populated is what the
 * gate itself can see RIGHT NOW, and it must outrank a verdict it cannot corroborate. So a
 * present dependency tree makes this a no-op rather than merely dropping the clause that used
 * to (asymmetrically) announce the corroboration in the block message.
 */
export async function describeFailedSetupRun(
  workspaceId: string,
  database: Database,
): Promise<string | null> {
  const run = await getSetupRunForGate(workspaceId, database).catch(() => undefined);
  if (!run || run.state !== "failed") return null;

  const corroboration = run.workingDir ? checkBinDir(run.workingDir) : null;
  if (corroboration?.depsPresent) return null;

  return `pre-merge gate blocked: this workspace's dependency setup script FAILED`
    + `${run.command ? ` (${run.command})` : ""} and was never retried successfully — the`
    + ` branch was built without its dependencies and could not have run a single test.`
    + `${corroboration ? ` ${corroboration.description}` : ""}`
    + `${run.stderrTail ? ` Last error: ${run.stderrTail.slice(-500)}` : ""}`
    + ` Fix the install and relaunch before merging.`;
}

/**
 * A cheap corroborating check (#1123, widened #1172): does `node_modules/.bin` back up the
 * recorded `failed` verdict, or contradict it? Never throws — an unreadable directory just
 * means "no corroboration either way", not "the failure didn't happen".
 */
function checkBinDir(workingDir: string): { depsPresent: boolean; description: string } | null {
  try {
    const binDir = join(workingDir, "node_modules", ".bin");
    if (!existsSync(binDir)) {
      return { depsPresent: false, description: "(corroborated: node_modules/.bin is absent.)" };
    }
    if (readdirSync(binDir).length === 0) {
      return { depsPresent: false, description: "(corroborated: node_modules/.bin is empty.)" };
    }
    return { depsPresent: true, description: "(node_modules/.bin is populated — the recorded failure is stale.)" };
  } catch {
    return null;
  }
}
