import type { Database } from "../db/index.js";
import { getWorkspacesByIssueId } from "../repositories/workspace-reads.repository.js";
import { findRunningCreateJobForIssue } from "./create-job.service.js";

/**
 * What is ACTUALLY true about a planned loop unit right now (#357/#360).
 *
 * ── The bug this exists to remove ──
 *
 * `resolveGate` rendered both its HTTP reply and the butler's turn from its OWN advance's
 * `startOutcomes`, and `startOutcomes` is built from `created` only — by construction a unit
 * reported as `skippedExisting` can never appear in it. When any other advance queues behind the
 * resolve (the monitor attempts one per loop per cycle, and cycles run back-to-back per #359), that
 * other advance wins the lock, creates AND starts the unit, and `resolveGate`'s own advance then
 * finds the ticket, reports `skippedExisting`, and hands the butler an empty sentence list. The
 * butler's fallback branch then asserts that nothing was planned.
 *
 * Measured: 2 of 3 live approvals. The worse of the two offered to "create and launch" a ticket
 * that already existed and was 80s from having a live workspace — accepting it fires a redundant
 * advance. Speaking wrongly is worse than the silence #357 was filed for, because a wrong statement
 * is what made humans intervene unnecessarily in earlier rounds.
 *
 * ── Why it reads THESE sources and not the obvious ones ──
 *
 * - **Not `issues.statusName`.** Measured ≥84s behind reality (#358's window), so guidance built on
 *   it inherits the bug it is meant to fix.
 * - **Not "which advance created it".** That is precisely the accident that decides whether the
 *   report is true, so the report must not depend on it. Resolving the unit's own state makes the
 *   answer identical whoever won the lock.
 * - **Workspace row AND the create-job registry.** The row does not exist until provisioning
 *   finishes (its insert and the issue's move to In Progress are one transaction at the END), so the
 *   row alone cannot distinguish "a launch is in flight" from "nothing will ever start" — the exact
 *   distinction that was reported backwards. `startPlannedLoopTickets` and the `?async=1` route both
 *   register in that registry, so the in-flight window is now visible.
 *
 * Every state below is falsifiable against a board API, which is the bar this had to meet: if the
 * report says started, `GET /api/workspaces?issueId=…` has a row; if it says queued, the state names
 * why, and the reason is checkable.
 */
export type PlannedUnitState =
  | { kind: "workspace-open"; branch: string; workspaceStatus: string; createdAt: string }
  | { kind: "workspace-merged"; branch: string; mergedAt: string }
  | { kind: "workspace-closed-unmerged"; branch: string }
  | { kind: "provisioning"; startedAt: string }
  | { kind: "no-workspace" };

export interface PlannedUnitRef {
  issueId: string;
  issueNumber: number | null;
}

export async function resolvePlannedUnitState(
  issueId: string,
  database: Database,
): Promise<PlannedUnitState> {
  const rows = await getWorkspacesByIssueId(issueId, database);
  // Newest first: a relaunch (or a reopen retry) leaves the older rows behind, and the newest is
  // the one that describes what is happening now.
  const sorted = [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const open = sorted.find((w) => w.status !== "closed");
  if (open) {
    return { kind: "workspace-open", branch: open.branch, workspaceStatus: open.status, createdAt: open.createdAt };
  }
  const merged = sorted.find((w) => w.mergedAt != null);
  if (merged?.mergedAt) {
    return { kind: "workspace-merged", branch: merged.branch, mergedAt: merged.mergedAt };
  }
  // Only now is the absence of a row meaningful — and it still might mean "provisioning".
  const job = findRunningCreateJobForIssue(issueId);
  if (job) return { kind: "provisioning", startedAt: job.startedAt };
  if (sorted.length > 0) return { kind: "workspace-closed-unmerged", branch: sorted[0].branch };
  return { kind: "no-workspace" };
}

/**
 * One short sentence per unit, stating only what was observed.
 *
 * Deliberately never says "generating", "running" or "working": #354's over-claim was exactly that,
 * and a workspace row proves provisioning happened, not that an agent is producing output. The
 * `no-workspace` wording names WHY nothing is visible instead of asserting a cause the board has not
 * checked — the retracted "the pipeline is waiting on something else" is what made the message
 * actively misleading.
 */
export function describePlannedUnitState(ref: PlannedUnitRef, state: PlannedUnitState): string {
  const label = ref.issueNumber !== null ? `#${ref.issueNumber}` : ref.issueId;
  switch (state.kind) {
    case "workspace-open":
      return `${label} was already planned by an earlier advance and its workspace EXISTS `
        + `(branch \`${state.branch}\`, workspace status "${state.workspaceStatus}", created ${state.createdAt}) — `
        + `it does not need to be started again.`;
    case "workspace-merged":
      return `${label} was already planned by an earlier advance and its branch \`${state.branch}\` `
        + `has already been merged (${state.mergedAt}) — there is nothing left to start for it.`;
    case "workspace-closed-unmerged":
      return `${label} was already planned by an earlier advance, but its only workspace `
        + `(\`${state.branch}\`) is closed and never merged — it produced nothing and needs a look.`;
    case "provisioning":
      return `${label} was already planned by an earlier advance and its workspace is being `
        + `provisioned right now (started ${state.startedAt}; worktree + dependency install takes a `
        + `few minutes before the agent's first output) — it does not need to be started again.`;
    case "no-workspace":
      return `${label} was already planned by an earlier advance but has NO workspace and no launch `
        + `in flight — nothing is provisioning it. Start it from the board, or let the monitor's next `
        + `auto-start pass pick it up if this project's Start Mode is "monitor".`;
  }
}

/**
 * How many already-ticketed units to resolve individually before summarising.
 *
 * A strict-linear pipeline reports one; a fan-out loop can report every unit of a 24-unit round as
 * `skippedExisting` on every monitor cycle, and one DB read each would put 24 queries on a path the
 * monitor walks continuously (#359 is about exactly that kind of accumulation).
 */
export const MAX_REPORTED_EXISTING_UNITS = 5;

/**
 * Sentences for the units an advance reported as ALREADY TICKETED, resolved from their real state.
 */
export async function describeExistingUnits(
  refs: PlannedUnitRef[],
  database: Database,
): Promise<string[]> {
  const reported = refs.slice(0, MAX_REPORTED_EXISTING_UNITS);
  const out: string[] = [];
  for (const ref of reported) {
    out.push(describePlannedUnitState(ref, await resolvePlannedUnitState(ref.issueId, database)));
  }
  const remaining = refs.length - reported.length;
  if (remaining > 0) {
    out.push(`${remaining} further unit(s) were already ticketed by an earlier advance; their state is not itemised here.`);
  }
  return out;
}
