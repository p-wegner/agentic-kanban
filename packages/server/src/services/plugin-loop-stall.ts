import type { PluginLoopGate, PluginLoopProgressStep } from "@agentic-kanban/shared";
import type { LoopUnmergedWorkspaceRow } from "../repositories/plugins.repository.js";
import { isLoopUnitAccountedForByPlanner } from "./plugin-loop-accounting.js";
import { parsePluginLoopUnitKey } from "@agentic-kanban/shared/lib/plugin-manifest";

/**
 * Classify the loop's "finished work exists but nothing landed it" state (#299/#336/#363).
 *
 * Extracted from `plugin-loop.service.ts` because the decision stopped being a filter and became
 * a diagnosis. `listPluginLoopUnmergedWorkspaces` used to return exactly one kind of row — issue
 * In Review/AI Reviewed/Done with an open unmerged workspace — and the only question was whether
 * the planner had already accounted for it. It now also returns rows parked by WORKSPACE status
 * while the issue never left In Progress, and those need a different affordance:
 *
 * | reason | what happened | right affordance |
 * |---|---|---|
 * | `builder-finished-unmerged` (#299) | the builder finished, the merge did not happen | one-click Merge |
 * | `workspace-parked-issue-unfinished` (#336/#363) | the workspace was parked `ready_for_merge` but the issue never advanced | INSPECT, not merge |
 *
 * The second one is why this is a classification and not a wider filter. On #363's live stall the
 * parked branch had **zero commits** (`git log master..HEAD` empty, `git status` empty) — the
 * agent ran 3m36s and produced nothing. Surfacing that as "Step done — waiting for merge" with a
 * Merge button would replace one wrong answer with another: there is nothing to merge, and merging
 * an empty branch would close the unit without its artifacts and deadlock the loop (the failure
 * `exit-workflow.ts` already refuses by name).
 *
 * Deliberately DB-only: no git call, no commit count. `loopStatuses` runs on every plugin-surface
 * read, and adding a `rev-list` per loop per read would feed exactly the event-loop blocking #359
 * is about. The classification therefore says "parked, and the ticket never finished — go look",
 * which is falsifiable from the row alone, rather than guessing whether the branch has content.
 */
export type LoopStallReason = "builder-finished-unmerged" | "workspace-parked-issue-unfinished";

export interface LoopStall {
  workspaceId: string;
  issueNumber: number | null;
  issueTitle: string;
  reason: LoopStallReason;
  /**
   * True only when landing the branch is known to be the right next action. False means the UI
   * must NOT offer a one-click merge — see the table above.
   */
  mergeSafe: boolean;
  /** One falsifiable sentence naming the two states that disagree. */
  detail: string;
  /** `workspaces.updatedAt` — how long this state has been held. */
  since: string;
  /**
   * Set when the row reports `status: "ready_for_merge"` together with `readyForMerge: false`
   * (measured on #363). Surfaced rather than silently resolved: whichever column a consumer
   * happens to read, it gets the opposite answer, and that is worth seeing.
   */
  contradictoryReadyFlag: boolean;
}

export function classifyLoopStall(row: LoopUnmergedWorkspaceRow): LoopStall {
  const parkedByWorkspace = row.workspaceStatus === "ready_for_merge";
  const finishedByIssue = row.issueStatusName === "In Review"
    || row.issueStatusName === "AI Reviewed"
    || row.issueStatusName === "Done";
  const ref = row.issueNumber != null ? `#${row.issueNumber}` : row.issueId;

  // Issue status wins when BOTH hold: an In-Review ticket whose workspace also reached
  // `ready_for_merge` is #299's ordinary state, and its branch is the one with the work.
  if (finishedByIssue) {
    return {
      workspaceId: row.workspaceId,
      issueNumber: row.issueNumber,
      issueTitle: row.issueTitle,
      reason: "builder-finished-unmerged",
      mergeSafe: true,
      detail: `${ref} is "${row.issueStatusName}" but its workspace is still open and unmerged — `
        + `the planner reads the main checkout, so this step stays invisible to it until the branch lands.`,
      since: row.workspaceUpdatedAt,
      contradictoryReadyFlag: parkedByWorkspace && !row.workspaceReadyForMerge,
    };
  }

  return {
    workspaceId: row.workspaceId,
    issueNumber: row.issueNumber,
    issueTitle: row.issueTitle,
    reason: "workspace-parked-issue-unfinished",
    mergeSafe: false,
    detail: `${ref}'s workspace is parked "${row.workspaceStatus}" while the ticket is still `
      + `"${row.issueStatusName}" — nothing transitioned the issue, so no exit workflow, review or `
      + `auto-merge will pick it up. Inspect the branch before merging: a parked workspace whose `
      + `ticket never advanced may have produced no commits at all (#363).`,
    since: row.workspaceUpdatedAt,
    contradictoryReadyFlag: parkedByWorkspace && !row.workspaceReadyForMerge,
  };
}

/**
 * Pick the one stall to surface, or null.
 *
 * Two filters, both pre-existing behaviour kept verbatim from `loopStatuses`:
 * - a row whose unit the planner has already accounted for is STALE (#326/#353) — the planner
 *   having seen the artifacts is the same claim as "the merge landed", so keeping the banner there
 *   put a "waiting for merge" card directly above a gate card for the same unit;
 * - oldest issue number first, because on a sequential pipeline that is the one actually blocking.
 *
 * One addition: among equally un-accounted-for rows, a `builder-finished-unmerged` row is preferred
 * over a parked one at the SAME issue number is impossible (one row per workspace), so ordering is
 * still purely by issue number — no tie-break needed.
 */
export function selectLoopStall(
  rows: LoopUnmergedWorkspaceRow[],
  gate: PluginLoopGate | null,
  progress: { steps: PluginLoopProgressStep[] } | null,
): LoopStall | null {
  const relevant = rows
    .filter((row) => {
      const unitId = parsePluginLoopUnitKey(row.externalKey)?.unitId;
      // A row we cannot attribute to a unit is kept: it is genuinely unmerged loop work, and
      // silently hiding it is the failure mode #336 is about.
      if (!unitId) return true;
      return !isLoopUnitAccountedForByPlanner(unitId, gate, progress);
    })
    .sort((a, b) => (a.issueNumber ?? Number.MAX_SAFE_INTEGER) - (b.issueNumber ?? Number.MAX_SAFE_INTEGER));
  return relevant.length > 0 ? classifyLoopStall(relevant[0]) : null;
}
