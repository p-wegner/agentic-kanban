import { issueDependencies, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";

/**
 * #797 — synchronous foundational merge.
 *
 * The structural complement to #784's read-side `mergedAt` gate. #784 makes a
 * dependent *wait* until its blocker has actually landed on the base branch
 * (`mergedAt != null`); this makes the *foundational* merge land PROMPTLY so the
 * wait is short — ideally zero. Without it, a no-dependency scaffold/shell ticket
 * passes review, is marked `readyForMerge`, and then sits Done-but-unmerged until
 * the next 30s auto-merge-orchestrator tick. In that window a tier-1 dependent can
 * be cut from the PRE-merge base (an empty scaffold) on the very first cascade
 * cycle — exactly fix-direction (c) from #784.
 *
 * A ticket is "foundational" when:
 *   (a) it has NO unresolved dependency of its own (it's at the bottom of the
 *       graph — the scaffold/shell, nothing it must wait for), AND
 *   (b) at least one OTHER still-open (non-terminal) issue depends on it
 *       (`depends_on` / `blocked_by`) — i.e. it actually gates tier-1 work.
 *
 * Only (a)+(b) together justify the synchronous merge: a leaf with no dependents
 * is just a normal ticket (let the timer handle it), and a ticket with its own
 * open blockers can't be the scaffold. Detection is intentionally cheap and
 * read-only so it can run inline in the review-passed exit path.
 */

async function loadDoneStatusIds(database: Database): Promise<Set<string>> {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(sql`${projectStatuses.name} IN ('Done', 'Cancelled')`);
  return new Set(rows.map((r) => r.id));
}

/**
 * True iff `issueId` has at least one UNRESOLVED dependency it must wait for.
 * A dependency is resolved once its blocker reached a terminal (Done/Cancelled)
 * status. We only need to know "any open blocker exists", not landing — a
 * foundational ticket should have none at all.
 */
async function hasUnresolvedDependencies(database: Database, issueId: string, doneStatusIds: Set<string>): Promise<boolean> {
  const deps = await database
    .select({ dependsOnId: issueDependencies.dependsOnId })
    .from(issueDependencies)
    .where(sql`${issueDependencies.issueId} = ${issueId} AND ${issueDependencies.type} IN ('depends_on', 'blocked_by')`);
  if (deps.length === 0) return false;

  const blockerIds = deps.map((d) => d.dependsOnId);
  const blockers = await database
    .select({ id: issues.id, statusId: issues.statusId })
    .from(issues)
    .where(inArray(issues.id, blockerIds));
  // Any blocker not yet terminal => this ticket still has work to wait on.
  return blockers.some((b) => !doneStatusIds.has(b.statusId));
}

/**
 * True iff at least one OTHER still-open (non-terminal) issue depends on `issueId`
 * via depends_on/blocked_by — i.e. landing this ticket would unblock real tier-1
 * work. A dependent that is already terminal doesn't count (nothing to unblock).
 */
async function hasOpenDependents(database: Database, issueId: string, doneStatusIds: Set<string>): Promise<boolean> {
  const dependents = await database
    .select({ issueId: issueDependencies.issueId })
    .from(issueDependencies)
    .where(sql`${issueDependencies.dependsOnId} = ${issueId} AND ${issueDependencies.type} IN ('depends_on', 'blocked_by')`);
  if (dependents.length === 0) return false;

  const dependentIds = [...new Set(dependents.map((d) => d.issueId))].filter((id) => id !== issueId);
  if (dependentIds.length === 0) return false;

  const dependentIssues = await database
    .select({ id: issues.id, statusId: issues.statusId })
    .from(issues)
    .where(inArray(issues.id, dependentIds));
  return dependentIssues.some((d) => !doneStatusIds.has(d.statusId));
}

/**
 * Decide whether `issueId` is a foundational blocker that should merge synchronously
 * (no own unresolved deps + at least one open dependent). Read-only.
 */
export async function isFoundationalBlocker(database: Database, issueId: string): Promise<boolean> {
  try {
    const doneStatusIds = await loadDoneStatusIds(database);
    if (await hasUnresolvedDependencies(database, issueId, doneStatusIds)) return false;
    return await hasOpenDependents(database, issueId, doneStatusIds);
  } catch (err) {
    // Detection is a best-effort optimization; on any error fall back to the timer
    // path (return false) rather than risk an exception in the exit workflow.
    console.warn("[foundational-merge] isFoundationalBlocker check failed (treating as non-foundational):", err instanceof Error ? err.message : String(err));
    return false;
  }
}
