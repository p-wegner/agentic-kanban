import { pluginLoopUnitKey, type PluginLoopDef } from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../../db/index.js";
import { insertIssueComment } from "../../repositories/issue-comments.repository.js";
import { setIssueStatus } from "../../repositories/issue-ai-contract.repository.js";
import { getStatusIdsByName } from "../../repositories/project-status.repository.js";
import type { LoopIssueRow } from "../../repositories/plugins.repository.js";

/**
 * The opt-in `reconcileUnits` half of a loop (#1643): the board's tickets follow the plan.
 *
 * Plain loops treat "a unit already has a ticket" as final (see `loop-unit-tickets.ts`). A loop that
 * declares `reconcileUnits` says the planner's register is the truth about outstanding work, so
 * two things follow that the plain contract cannot express:
 *
 * - **A Done ticket whose unit is still planned is a failed round, not a handled one.** Skipping it
 *   leaves the loop reporting "outstanding" with nothing driving it. The next round is ticketed under
 *   the next `:r<N>` id and carries a pointer to the round that did not settle it.
 * - **An open ticket whose unit left the plan has nothing left to do.** The cause went away
 *   (someone fixed the mapping by hand); the ticket is closed with a comment instead of sitting in Todo.
 *
 * Only `Done` re-opens a round. A `Cancelled` ticket is a human's "won't do" and stays a skip.
 */

const ROUND_SUFFIX = /^(.*):r(\d+)$/;

/** `conflict:KD-49:r1` -> `conflict:KD-49:r2`; an id without a round suffix becomes `<id>:r2`. */
export function nextRoundUnitId(unitId: string): string {
  const match = ROUND_SUFFIX.exec(unitId);
  return match ? `${match[1]}:r${Number(match[2]) + 1}` : `${unitId}:r2`;
}

/** Whether a prior ticket is a settled round the plan nevertheless still reports as outstanding. */
export function isFailedRound(row: Pick<LoopIssueRow, "statusName">): boolean {
  return row.statusName === "Done";
}

/** The brief's lead-in for a round that follows a Done ticket the sync did not accept as resolution. */
export function priorRoundNote(prior: Pick<LoopIssueRow, "issueNumber">, priorUnitId: string): string {
  const ref = prior.issueNumber != null ? `#${prior.issueNumber}` : "the previous ticket";
  return `**Round follow-up.** ${ref} (\`${priorUnitId}\`) was closed as Done, but the sync still reports this unit `
    + `as outstanding, so that round did not resolve it. Read what ${ref} recorded and do not repeat its decision `
    + `blindly: check the current state first, and apply the decision so the sync actually sees both sides agree.`;
}

export interface ClosedUnitTicket {
  unitId: string;
  issueId: string;
  issueNumber: number | null;
}

/**
 * Close every OPEN ticket of the loop whose key is not in `activeKeys` (the keys the current plan
 * maps to). A ticket with a live workspace is left alone: an agent is working it, and finishing is its call.
 */
export async function closeResolvedUnitTickets(args: {
  loop: PluginLoopDef;
  pluginSlug: string;
  projectId: string;
  existing: LoopIssueRow[];
  activeKeys: Set<string>;
  database: Database;
  now?: string;
}): Promise<{ closed: ClosedUnitTicket[]; warnings: string[] }> {
  const now = args.now ?? new Date().toISOString();
  const stale = args.existing.filter(
    (row) => row.statusName !== "Done" && row.statusName !== "Cancelled"
      && !args.activeKeys.has(row.externalKey) && !row.hasLiveWorkspace,
  );
  if (stale.length === 0) return { closed: [], warnings: [] };
  const [doneId] = await getStatusIdsByName(args.projectId, ["Done"], args.database);
  if (!doneId) return { closed: [], warnings: ['Resolved loop tickets were left open: the project has no "Done" status.'] };

  const prefix = pluginLoopUnitKey(args.pluginSlug, args.loop.name, "");
  const closed: ClosedUnitTicket[] = [];
  for (const row of stale) {
    await setIssueStatus(row.id, doneId, now, args.database);
    await insertIssueComment({
      issueId: row.id,
      kind: "note",
      author: "system",
      body: `Resolved by sync at ${now}: the plugin no longer reports this unit as outstanding, so the ticket is closed.`,
      createdAt: now,
    }, args.database);
    closed.push({ unitId: row.externalKey.slice(prefix.length), issueId: row.id, issueNumber: row.issueNumber });
  }
  return { closed, warnings: [] };
}
