/**
 * Monitor step that keeps the committed test-impact map fresh (#952, #955).
 *
 * Runs BETWEEN tickets, in the monitor cycle, against each allowed project's MAIN CHECKOUT —
 * not per ticket and never in a worktree, because single-writer is what makes a committed
 * generated file safe (see `services/test-impact-map.service.ts` for the storage decision).
 *
 * Ordering: BEFORE `runAutoStart`, so a builder launched this cycle forks from the branch this
 * pass just committed to and its `select` reads a map that is fresh. A pass placed after the
 * fan-out would first benefit the cycle after next — which on a busy board is exactly when the
 * map matters most.
 *
 * Not on the merge path deliberately. There is no single "a train landed" point (`runMergeTrain`
 * bisects a red batch and lands recursively), and the merge executor is the worst possible seam:
 * it holds the repo lock inside the window where the train's base-HEAD ancestry invariant must
 * hold. A per-cycle phase cannot delay a merge, and 7.4s is nothing against a cycle.
 */
import { existsSync } from "node:fs";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";

import type { Database } from "../db/index.js";
import { getProjectById } from "../repositories/project.repository.js";
import { listBoardProjectIds } from "../repositories/project-status.repository.js";
import { resolveTestImpactMapGate, runTestImpactMapPass } from "../services/test-impact-map.service.js";
import { listMergeRuns } from "../repositories/merge-run.repository.js";
import { getWorkspaceIssueContext } from "../repositories/workspace-reads.repository.js";

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
 * Projects with a merge IN FLIGHT right now, which must not have their main checkout committed
 * to (#998).
 *
 * A pre-merge gate records the base tip when it starts and runs for 6-40 minutes. If this pass
 * commits the map to master in that window the tip moves, and #243 correctly DISCARDS the
 * verdict — the whole run is thrown away. Measured on this board 2026-09-01: gate attempt 1 for
 * workspace `42eb8b43` PASSED after 590s and was discarded because `base f805f608 -> a0881bf8`
 * moved, where `a0881bf8` is this pass's own `chore: rebuild test-impact map` commit.
 *
 * The `lock_busy` skip below does NOT cover this. The repo lock is held by the merge itself; the
 * gate runs before it — the discarded attempt is named `pre-lock-merge` — so the expensive
 * verification window is precisely the one the existing skip misses.
 *
 * The #945 in-flight marker is the right predicate and already exists: `startMergeJob` writes it
 * and every terminal transition clears it, so it spans the whole gate INCLUDING verification, and
 * it is durable and cross-process rather than a module-local flag.
 *
 * Per PROJECT, not board-wide, so a busy project cannot starve an idle one's map — which would
 * re-create the #993 defect (a map that rots forever) through a different door.
 *
 * Fails OPEN: if the markers cannot be read, the pass proceeds. A missed skip costs one
 * discarded gate; refusing to refresh on an unreadable marker costs the freshness #993 exists
 * to guarantee, indefinitely and silently.
 */
async function projectsWithMergeInFlight(database?: Database): Promise<Set<string>> {
  const blocked = new Set<string>();
  try {
    for (const row of await listMergeRuns(database)) {
      const context = await getWorkspaceIssueContext(row.workspaceId, database).catch(() => null);
      if (context?.projectId) blocked.add(context.projectId);
    }
  } catch (err) {
    console.warn(
      "[monitor] could not read the in-flight merge markers — refreshing maps anyway (#998):",
      err instanceof Error ? err.message : err,
    );
  }
  return blocked;
}

/**
 * Refresh the map for every allowed project whose is stale. Returns the number of projects whose
 * map was rebuilt and committed this cycle (0 on a quiet board — the freshness check is cheap and
 * short-circuits before the lock is ever taken).
 *
 * Best-effort throughout: a failure on one project is logged and never aborts the cycle, and the
 * pass itself never leaves the main checkout dirty (which would block every subsequent merge).
 */
export async function runTestImpactMapRefresh(
  prefMap: Map<string, string>,
  { allowProject, database }: TestImpactMapStepDeps,
): Promise<number> {
  const boardWideEnabled = getBool(prefMap, "test_impact_map_refresh");

  const projectIds = await listBoardProjectIds(database);
  const mergingProjectIds = await projectsWithMergeInFlight(database);

  let rebuilt = 0;
  for (const projectId of projectIds) {
    if (!allowProject(projectId)) continue;
    if (!resolveTestImpactMapGate(prefMap, projectId, boardWideEnabled).enabled) continue;
    if (mergingProjectIds.has(projectId)) {
      // Said out loud rather than skipped silently: #993 was filed because a map that never
      // refreshed looked exactly like one that did. The next sweep is 15 minutes away and a
      // stale map only WIDENS the selection, so deferring is cheap; a discarded gate is not.
      console.log(
        `[monitor] test-impact map refresh deferred for project ${projectId} — a merge is in flight ` +
        "and committing to master would move the base tip under its gate (#998)",
      );
      continue;
    }

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
        case "no_map":
          break; // the steady state — nothing worth a line every cycle
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
