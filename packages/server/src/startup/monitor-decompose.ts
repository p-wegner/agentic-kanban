import type { Database } from "../db/index.js";
import { createBoardEvents } from "../services/board-events.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import { decomposeEpic, confirmEpicDecomposition } from "../services/issue-ai.service.js";
import { markTooSmallToDecompose } from "../services/decompose-verdict.service.js";
import { projectHasStatuses, selectUndecomposedEpics } from "../repositories/start-scoring.repository.js";

/**
 * Auto-decompose step (#1134) — a freshly planned drive epic (or any REST-seeded epic-tagged
 * issue) with no children is work for the DECOMPOSER, not for a builder: `notDriveOrEpicMetaSql`
 * now excludes it from start scoring, so without this step such an epic would just stall —
 * excluded from auto-start, with nothing else in the cycle that advances it.
 *
 * Runs BEFORE the fan-out (`runAutoStart`), for every project the cycle is otherwise allowed to
 * act on (the same `allowProject` gate the rest of the hands-off pipeline uses — no separate
 * opt-in preference, since this is what makes a drive planned hands-off actually fan out rather
 * than a new feature to enable). For each undecomposed epic it finds:
 *   - `tooSmallToDecompose: true` (the #116 atomic floor) → tag it `right-sized` so it becomes a
 *     startable candidate again (#1074's case) — no children created.
 *   - otherwise → confirm the proposal as-is, creating the children that make the epic itself
 *     correctly excluded going forward (it now has parent_of/child_of edges).
 *
 * Best-effort per epic: a failure on one issue is logged and never aborts the monitor cycle, and
 * is left for the next cycle to retry.
 */
export interface AutoDecomposeDeps {
  boardEvents: ReturnType<typeof createBoardEvents>;
  logMonitorAction: (action: MonitorActionName, workspaceId: string, issueId: string) => void;
  /** Which projects this cycle may act on (same predicate the rest of the cycle uses). */
  allowProject: (projectId: string) => boolean;
  /** All project ids the cycle is considering this pass. */
  projectIds: string[];
  database: Database;
}

/** Returns the number of epics advanced (decomposed into children OR marked right-sized). */
export async function runAutoDecompose(
  { boardEvents, logMonitorAction, allowProject, projectIds, database }: AutoDecomposeDeps,
): Promise<number> {
  let advanced = 0;

  for (const projectId of projectIds) {
    if (!allowProject(projectId)) continue;
    // Only act on projects that actually exist (have statuses); skip silently otherwise.
    if (!(await projectHasStatuses(projectId, database))) continue;

    let candidates;
    try {
      candidates = await selectUndecomposedEpics(projectId, database);
    } catch (err) {
      console.warn(`[monitor] auto-decompose discovery failed for project ${projectId}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (candidates.length === 0) continue;

    for (const epic of candidates) {
      try {
        const proposal = await decomposeEpic(epic.id, projectId, database);
        if (proposal.tooSmallToDecompose || proposal.children.length === 0) {
          await markTooSmallToDecompose(epic.id, database);
          console.log(`[monitor] auto-decompose: epic #${epic.issueNumber} is already right-sized (project ${projectId}) — marked right-sized`);
          logMonitorAction("auto_decompose_right_sized", "", epic.id);
        } else {
          await confirmEpicDecomposition(
            { issueId: epic.id, projectId, children: proposal.children, dependencies: proposal.dependencies },
            database,
          );
          console.log(`[monitor] auto-decompose: epic #${epic.issueNumber} split into ${proposal.children.length} children (project ${projectId})`);
          logMonitorAction("auto_decompose", "", epic.id);
          boardEvents.broadcast(projectId, "issue_created");
        }
        advanced++;
      } catch (err) {
        console.warn(`[monitor] auto-decompose failed for epic #${epic.issueNumber} (project ${projectId}):`, err instanceof Error ? err.message : err);
      }
    }
  }
  return advanced;
}
