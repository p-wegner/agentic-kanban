/**
 * Monitor step that keeps the test-impact map fresh (#952, #955).
 *
 * Runs BETWEEN tickets, in the monitor cycle, against each allowed project's MAIN CHECKOUT —
 * not per ticket and never in a worktree, because single-writer is what makes a generated file
 * shared across branches safe (see `services/test-impact-map.service.ts` for the storage
 * decision).
 *
 * Ordering: BEFORE `runAutoStart`, so a builder launched this cycle gets the map this pass just
 * rebuilt copied into its worktree (`services/test-impact-map/worktree-map.ts`). A pass placed
 * after the fan-out would first benefit the cycle after next — which on a busy board is exactly
 * when the map matters most.
 *
 * Not on the merge path deliberately. There is no single "a train landed" point (`runMergeTrain`
 * bisects a red batch and lands recursively), and the merge executor is the worst possible seam:
 * it holds the repo lock inside the window where the train's base-HEAD ancestry invariant must
 * hold. A per-cycle phase cannot delay a merge, and 7.4s is nothing against a cycle.
 *
 * ## #998's merge deferral is GONE, because #1018 removed what it was defending
 *
 * The pass used to COMMIT the rebuilt map, and a commit on master moves the base tip under every
 * running pre-merge gate — #243 then correctly discards that gate's verdict. #998 answered by
 * skipping any project with a merge in flight (the #945 marker). #1018 made the map an untracked,
 * gitignored artifact rebuilt in place, so the pass commits nothing at all: there is no base
 * movement to defer around, and the worktree the gate runs in holds its own snapshot copy, so a
 * rebuild here cannot change what a running gate selects either. Keeping the skip would have cost
 * exactly what #993 was filed about — a map that quietly stops refreshing on a busy project — to
 * defend against a hazard that no longer exists.
 */
import { existsSync } from "node:fs";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";

import type { Database } from "../db/index.js";
import { getProjectById } from "../repositories/project.repository.js";
import { listBoardProjectIds } from "../repositories/project-status.repository.js";
import { resolveTestImpactMapGate, runTestImpactMapPass } from "../services/test-impact-map.service.js";

export interface TestImpactMapStepDeps {
  /** Which projects this cycle may act on (same predicate the rest of the cycle uses). */
  allowProject: (projectId: string) => boolean;
  /**
   * Injected for tests. Deliberately optional-with-no-module-default here: the repositories
   * below already default to the global `db`, so this phase never value-imports it — which is
   * what keeps it off the `startup-bypasses-repositories` list (#715).
   */
  database?: Database;
}

/**
 * Refresh the map for every allowed project whose map is stale. Returns the number of projects
 * whose map was rebuilt this cycle (0 on a quiet board — the freshness check is cheap and
 * short-circuits before the lock is ever taken).
 *
 * Best-effort throughout: a failure on one project is logged and never aborts the cycle.
 */
export async function runTestImpactMapRefresh(
  prefMap: Map<string, string>,
  { allowProject, database }: TestImpactMapStepDeps,
): Promise<number> {
  const boardWideEnabled = getBool(prefMap, "test_impact_map_refresh");

  const projectIds = await listBoardProjectIds(database);

  let rebuilt = 0;
  for (const projectId of projectIds) {
    if (!allowProject(projectId)) continue;
    if (!resolveTestImpactMapGate(prefMap, projectId, boardWideEnabled).enabled) continue;

    try {
      const project = await getProjectById(projectId, database);
      if (!project?.repoPath || !existsSync(project.repoPath)) continue;

      const result = await runTestImpactMapPass(project.repoPath);
      switch (result.outcome) {
        case "rebuilt":
          rebuilt++;
          console.log(
            `[monitor] test-impact map rebuilt for project ${projectId} @ ${result.headSha}` +
            `${result.durationsFed ? " (with measured durations)" : " (no durations report — budgets stay estimated)"}`,
          );
          break;
        case "fresh":
        case "no_skill":
        case "map_not_ignored":
          break; // the steady state — nothing worth a line every cycle
        case "map_tracked":
          // Worth SAYING, unlike the other skips: this one names a ONE-TIME operator action
          // (`git rm --cached`), and until someone takes it the pass is permanently inert on
          // that project — which is precisely the silently-never-refreshing map #993 was filed
          // about.
          console.warn(`[monitor] test-impact map not refreshed for project ${projectId}: ${result.detail}`);
          break;
        case "lock_busy":
          // EXPECTED, not a fault: a merge train holds the repo lock for its whole run, and
          // skipping is the designed response. Warning here would put a line in the log every
          // 30s for the length of every train, which is how a log stops being read.
          break;
        default:
          // A stale map only WIDENS the selection, so none of these is an error worth
          // escalating; they are worth SAYING, because a silently-never-refreshing map is
          // exactly the failure this pass exists to remove.
          console.warn(
            `[monitor] test-impact map not refreshed for project ${projectId}: ` +
            `${result.outcome}${result.detail ? ` — ${result.detail}` : ""}`,
          );
      }
    } catch (err) {
      console.warn(
        `[monitor] test-impact map pass failed for project ${projectId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return rebuilt;
}
