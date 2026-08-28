/**
 * #917 — the ONE query the Todo-pull loop's scoring needs beyond what it already reads:
 * how many OTHER open issues would this candidate unblock if it landed. A repository
 * (not inlined in `startup/monitor-auto-start.ts`) so it stays injectable for tests the
 * same way `buildContentionGate`/`canDispatch`/`readMachineCapacity` already are there.
 */
import { issueDependencies, issues } from "@agentic-kanban/shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { BLOCKING_DEPENDENCY_TYPES } from "@agentic-kanban/shared/lib/dependency-type-traits";

/**
 * For every candidate id, how many OTHER open (non-terminal-status) issues in the same
 * project name it as a blocker (`depends_on`/`blocked_by`, candidate on the `dependsOnId`
 * side). A candidate absent from the result unblocks nothing.
 *
 * Scoped to a single project's OPEN issues: an issue blocking work in a Done/Cancelled
 * status, or in another project, unblocks nothing a start decision should reward.
 */
export async function computeUnblockCounts(
  projectId: string,
  candidateIds: string[],
  doneStatusIds: ReadonlySet<string>,
  database: Database,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (candidateIds.length === 0) return counts;

  const rows = await database
    .select({ dependsOnId: issueDependencies.dependsOnId, dependentStatusId: issues.statusId })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(and(
      inArray(issueDependencies.dependsOnId, candidateIds),
      inArray(issueDependencies.type, BLOCKING_DEPENDENCY_TYPES),
      eq(issues.projectId, projectId),
    ));

  for (const row of rows) {
    if (doneStatusIds.has(row.dependentStatusId)) continue; // already resolved, not a live unblock
    counts.set(row.dependsOnId, (counts.get(row.dependsOnId) ?? 0) + 1);
  }
  return counts;
}

