/**
 * #919 â€” turning a PROJECT-WIDE auto-start hold into a per-TICKET answer.
 *
 * The monitor's four project-wide holds (`wip_cap`, `machine_saturated`, `verify_gate_running`,
 * `no_available_worker`) all return before the candidate list is ever built, so none of them has
 * a ticket to attribute its reason to â€” which is exactly why "why is #57 not running" used to be
 * answerable only as a project tally reading `wip_cap: 7`, naming no ticket at all. This module
 * is the other half: enumerate the tickets a hold is holding, and persist the reason on each.
 *
 * Split out of `monitor-auto-start.ts` (which is at the god-module ceiling) because it is a
 * cohesive unit with one job and no dependency on the cycle's own state â€” it takes the recorder
 * as an interface, which is also what lets the auto-start suites assert attribution without a DB.
 */
import type { Database } from "../db/index.js";
import { clearAutoStartSkipReason, heldCandidateIds, persistAutoStartSkipReason } from "../repositories/auto-start-skip.repository.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * The half of the cycle context this module needs â€” narrowed so it cannot reach anything else.
 *
 * Generic in the reason type rather than pinned to `AutoStartSkipReason`: that union is declared
 * in `monitor-auto-start.ts`, which imports this module, so naming it here would make the two
 * files circular. Widening it to `string` instead would be worse than circular â€” a recorder that
 * accepts only the union is not assignable to one accepting any string (parameter contravariance),
 * so the caller would need a cast, and the cast is exactly what would let a typo through. With
 * `R` the caller's own union flows in and stays enforced end to end.
 */
export interface IssueSkipRecorder<R extends string> {
  noteIssueSkip: (issueId: string, reason: R) => void;
}

/**
 * Re-exported so this module stays the one import site for skip attribution; the query itself
 * lives in `auto-start-skip.repository.ts` (see its header for why it is not inlined here).
 */
export { heldCandidateIds };

/**
 * Attribute a project-wide hold to every ticket it holds. Best-effort: the hold has already been
 * decided and tallied by the caller, so a failure to enumerate the held tickets must not change
 * the cycle's behaviour â€” it only costs the per-ticket explanation.
 */
export async function noteHeldCandidates<R extends string>(
  ctx: IssueSkipRecorder<R>,
  projectId: string,
  allowFeatureTypes: boolean,
  reason: R,
  database: Database,
): Promise<void> {
  try {
    for (const id of await heldCandidateIds(projectId, allowFeatureTypes, database)) ctx.noteIssueSkip(id, reason);
  } catch (err) {
    console.warn(`[monitor] could not attribute the "${reason}" hold on project ${projectId} to its queued tickets: ${errorMessage(err)}`);
  }
}

/**
 * The cycle state the three project-wide hold recorders below read. Structural rather than the
 * concrete `AutoStartCycle` (which is declared in `monitor-auto-start.ts`, our importer) â€” and
 * usefully so: it states exactly what recording a hold is allowed to touch.
 */
export interface HoldRecorderCycle<R extends string, Info> extends IssueSkipRecorder<R> {
  prefMap: Map<string, string>;
  skipInfo: Map<string, Info>;
  noteSkip: (projectId: string, issueNumber: number | null | undefined, reason: R, count?: number) => void;
  /**
   * The connection to enumerate held tickets through. On the ctx rather than a separate
   * parameter because the cycle already owns it, and because `startup/` importing the `db`
   * singleton is the persistence-boundary backlog (#715) that may only shrink.
   */
  database: Database;
}

/**

 * #179: WIP is full â€” but only worth surfacing as a "skipped" cause if there is actually
 * queued Todo/Backlog work waiting behind it, not on every idle project.
 */
export async function noteWipCapSkip<Info>(
  ctx: HoldRecorderCycle<"wip_cap", Info>,
  projectId: string,
  allowFeatureTypes: boolean,
): Promise<void> {
  const held = await heldCandidateIds(projectId, allowFeatureTypes, ctx.database);
  if (held.length === 0) return;
  ctx.noteSkip(projectId, null, "wip_cap", held.length);
  // #919: and on each of the held tickets, so the issue panel can answer for #57 specifically.
  for (const id of held) ctx.noteIssueSkip(id, "wip_cap");
}

/**
 * Persist this cycle's per-issue skip reasons and clear the records of issues that DID start.
 * Best-effort throughout: these are decorations on decisions already taken and acted on, so a
 * write failure warns and the cycle's result is unaffected.
 */
export async function flushIssueSkipRecords(
  issueSkips: ReadonlyMap<string, string>,
  startedIssueIds: ReadonlySet<string>,
  database: Database,
): Promise<void> {
  const at = new Date().toISOString();
  for (const [issueId, reason] of issueSkips) {
    const err = await persistAutoStartSkipReason(issueId, { reason, at }, database);
    if (err) console.warn(`[monitor] Failed to record auto-start skip reason "${reason}" for issue ${issueId}: ${errorMessage(err)}`);
  }
  const clearErr = await clearAutoStartSkipReason([...startedIssueIds], database);
  if (clearErr) console.warn(`[monitor] Failed to clear auto-start skip reasons for ${startedIssueIds.size} started issue(s): ${errorMessage(clearErr)}`);
}
