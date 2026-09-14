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
 */
export async function describeFailedSetupRun(
  workspaceId: string,
  database: Database,
): Promise<string | null> {
  const run = await getSetupRunForGate(workspaceId, database).catch(() => undefined);
  if (!run || run.state !== "failed") return null;

  const corroboration = run.workingDir ? describeEmptyBinDir(run.workingDir) : null;
  return `pre-merge gate blocked: this workspace's dependency setup script FAILED`
    + `${run.command ? ` (${run.command})` : ""} and was never retried successfully — the`
    + ` branch was built without its dependencies and could not have run a single test.`
    + `${corroboration ? ` ${corroboration}` : ""}`
    + `${run.stderrTail ? ` Last error: ${run.stderrTail.slice(-500)}` : ""}`
    + ` Fix the install and relaunch before merging.`;
}

/**
 * A cheap corroborating check (#1123): an absent or empty `node_modules/.bin` confirms the
 * worktree really has no installed dependencies, rather than trusting the recorded verdict
 * alone. Never throws — an unreadable directory just means "no corroboration to add", not
 * "the failure didn't happen".
 */
function describeEmptyBinDir(workingDir: string): string | null {
  try {
    const binDir = join(workingDir, "node_modules", ".bin");
    if (!existsSync(binDir)) {
      return "(corroborated: node_modules/.bin is absent.)";
    }
    if (readdirSync(binDir).length === 0) {
      return "(corroborated: node_modules/.bin is empty.)";
    }
    return null;
  } catch {
    return null;
  }
}
