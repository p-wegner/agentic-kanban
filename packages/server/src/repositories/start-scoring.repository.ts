/**
 * #917 â€” the ONE query the Todo-pull loop's scoring needs beyond what it already reads:
 * how many OTHER open issues would this candidate unblock if it landed. A repository
 * (not inlined in `startup/monitor-auto-start.ts`) so it stays injectable for tests the
 * same way `buildContentionGate`/`canDispatch`/`readMachineCapacity` already are there.
 */
import { issueDependencies, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
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

/**
 * The candidate rows the start scorer ranks. `filters` are the caller's eligibility
 * fragments (`monitorEligibleIssueSql`, `notDriveOrEpicMetaSql`) — passed IN rather than
 * imported, so the query lives on this side of the persistence boundary while the monitor
 * keeps owning what "eligible" means.
 */
export async function selectScorableCandidates(statusIds: string[], filters: SQL[], database: Database) {
  if (statusIds.length === 0) return [];
  return database.select({
    id: issues.id, title: issues.title, description: issues.description, issueType: issues.issueType,
    issueNumber: issues.issueNumber, priority: issues.priority, createdAt: issues.createdAt, statusChangedAt: issues.statusChangedAt,
  }).from(issues).where(and(inArray(issues.statusId, statusIds), ...filters));
}

/** The id of a project's status with this exact name, or null when it has none. */
export async function findProjectStatusIdByName(projectId: string, name: string, database: Database): Promise<string | null> {
  const rows = await database.select({ id: projectStatuses.id }).from(projectStatuses)
    .where(sql`${projectStatuses.name} = ${name} AND ${projectStatuses.projectId} = ${projectId}`).limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Every status id carrying one of these names, ACROSS projects — the terminal-status set
 * `computeUnblockCounts` tests against, which is deliberately not project-scoped.
 */
export async function findStatusIdsByNames(names: readonly string[], database: Database): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const rows = await database.select({ id: projectStatuses.id }).from(projectStatuses)
    .where(inArray(projectStatuses.name, [...names]));
  return new Set(rows.map((r) => r.id));
}

/**
 * Stamp one issue's computed start score. Never throws — a score is a decoration on an
 * ordering the caller has already made, so a write failure must not abort it; the error is
 * RETURNED so the caller can warn in its own voice.
 */
export async function persistStartScore(
  issueId: string,
  fields: { score: number; componentsJson: string; scoredAt: string },
  database: Database,
): Promise<Error | null> {
  try {
    await database.update(issues).set({
      lastStartScore: fields.score,
      lastStartScoreComponentsJson: fields.componentsJson,
      lastStartScoredAt: fields.scoredAt,
    }).where(eq(issues.id, issueId));
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}
