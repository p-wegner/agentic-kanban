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
export type LoopStallReason =
  | "builder-finished-unmerged"
  | "workspace-parked-issue-unfinished"
  /**
   * The unit ALREADY LANDED and this open workspace is a leftover (#337) — most often the
   * after-merge review workspace, which is non-closed and has no `mergedAt` of its own, so the
   * query cannot tell it apart from the builder workspace that never merged.
   *
   * MEASURED on kassenbuch round 3, in the ~5-minute window between "step agent finished" and
   * "review workspace closed": `awaitingMerge` pointed at such a row while the ticket was already
   * Done and the merge commit was already on master, and the card rendered a literal "Merge now"
   * button. That is the single worst affordance available here, because the operator documentation
   * maps this exact state to "click Merge now on the loop card". Merging the leftover is at best a
   * no-op and at worst lands a branch nobody reviewed.
   *
   * Still DB-only: the evidence is a SIBLING workspace on the same issue with `mergedAt` set, not
   * a git reachability check — `loopStatuses` runs on every plugin-surface read (#359).
   */
  | "unit-already-landed"
  /**
   * The workspace CLOSED without ever merging while its ticket is still non-terminal (#445).
   *
   * MEASURED on eventhub: 9 of 28 open `requirement-extraction` tickets, In Review since
   * 2026-08-05, each with one `closed` workspace holding `mergedAt: null`. The query excluded
   * closed workspaces entirely, so these produced no stall, no inbox item and no nudge — and
   * because a loop only replans once its round is terminal, they are a permanent brake.
   *
   * `mergeSafe: false` deliberately, and NOT because the branch is empty (that is #363's case):
   * the branch may still exist and be perfectly landable, or the work may be gone with the
   * worktree. Those need different remedies and the row alone cannot tell them apart, so the
   * affordance is "go look", never "click Merge".
   */
  | "workspace-closed-unmerged";

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

  // #337 — checked FIRST, and it overrides the finished-by-issue branch below. A Done unit whose
  // work already merged reaches that branch today and gets `mergeSafe: true`, which is how an
  // already-landed step came to be advertised with a "Merge now" button for five minutes. If a
  // sibling workspace on this issue carries `mergedAt`, the unit's artifacts ARE on the base branch
  // and merging this row is never the right next action.
  if (row.issueHasMergedWorkspace) {
    return {
      workspaceId: row.workspaceId,
      issueNumber: row.issueNumber,
      issueTitle: row.issueTitle,
      reason: "unit-already-landed",
      mergeSafe: false,
      detail: `${ref} already has a MERGED workspace, so this step's work is on the base branch — `
        + `this open workspace is a leftover (typically the after-merge review). Do not merge it; `
        + `it closes on its own, and the loop advances from the merge that already landed.`,
      since: row.workspaceUpdatedAt,
      contradictoryReadyFlag: parkedByWorkspace && !row.workspaceReadyForMerge,
    };
  }

  // #445 — checked before the issue-status branch, because these rows ARE mostly In Review and
  // would otherwise be classified `builder-finished-unmerged` and offered a one-click Merge on a
  // workspace that no longer exists. A closed workspace has had its worktree removed, so "merge
  // it" is not a click the board can honour.
  if (row.workspaceStatus === "closed") {
    return {
      workspaceId: row.workspaceId,
      issueNumber: row.issueNumber,
      issueTitle: row.issueTitle,
      reason: "workspace-closed-unmerged",
      mergeSafe: false,
      detail: `${ref} is "${row.issueStatusName}" but its workspace CLOSED without merging — the `
        + `ticket can never reach a terminal state on its own, so this loop stops advancing once its `
        + `other tickets finish. Inspect the branch: if it still holds the work, land it; if the work `
        + `is gone, relaunch the unit or cancel the ticket. Do not merge blind — a closed workspace `
        + `may have produced nothing at all (#363).`,
      since: row.workspaceUpdatedAt,
      contradictoryReadyFlag: parkedByWorkspace && !row.workspaceReadyForMerge,
    };
  }

  // Issue status wins when BOTH hold: an In-Review ticket whose workspace also reached
  // `ready_for_merge` is #299's ordinary state, and its branch is the one with the work.
  if (finishedByIssue) {
    return {
      workspaceId: row.workspaceId,
      issueNumber: row.issueNumber,
      issueTitle: row.issueTitle,
      reason: "builder-finished-unmerged",
      mergeSafe: true,
      // #384 — the wording used to ASSERT "still open and unmerged", which the board cannot know
      // from the row. There is a measured window (n=10, 3.7s to 158.5s on one pipeline run) in
      // which the git merge has already landed on the base branch and `workspaces.mergedAt` has
      // not been written yet. Read during that window, the old sentence stated something false and
      // pointed the operator at "Merge now" for a branch already on master. What the row actually
      // supports is that the merge is UNRECORDED, so that is what it now says.
      detail: `${ref} is "${row.issueStatusName}" and its workspace has no recorded merge — `
        + `the planner reads the main checkout, so this step stays invisible to it until the merge is recorded. `
        + `Check the base branch first: if the merge commit is already there, finalization is simply pending `
        + `(the ancestor-branch reconciler completes it on its next tick) and there is nothing to click.`,
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
    // #337 — an ALREADY-LANDED leftover sorts last, whatever its issue number. Ordering was purely
    // by issue number, so a leftover review workspace on an earlier unit could win the slot and
    // hide a later unit that genuinely never landed — swapping a misleading card for a missing one.
    // It is still reported when it is the only row, because "nothing to do here" is a real answer.
    // #445 — a CLOSED-unmerged row sorts after every live one. Those rows are old by construction
    // (eventhub's were 8 days old) and their remedy is manual inspection, while a live unmerged
    // builder is both newer and one click from resolved. Ordering purely by issue number would let
    // nine ancient strandings permanently occupy the single slot and hide every actionable stall
    // behind them — surfacing a week-old problem one cycle later costs nothing, hiding today's
    // costs the affordance #299 exists for. They still surface as soon as the live rows clear.
    .sort((a, b) => {
      const landed = Number(a.issueHasMergedWorkspace) - Number(b.issueHasMergedWorkspace);
      if (landed !== 0) return landed;
      const closed = Number(a.workspaceStatus === "closed") - Number(b.workspaceStatus === "closed");
      if (closed !== 0) return closed;
      return (a.issueNumber ?? Number.MAX_SAFE_INTEGER) - (b.issueNumber ?? Number.MAX_SAFE_INTEGER);
    });
  return relevant.length > 0 ? classifyLoopStall(relevant[0]) : null;
}
