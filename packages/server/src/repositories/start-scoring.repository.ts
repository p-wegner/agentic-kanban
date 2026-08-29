/**
 * #917 — the ONE query the Todo-pull loop's scoring needs beyond what it already reads:
 * how many OTHER open issues would this candidate unblock if it landed. A repository
 * (not inlined in `startup/monitor-auto-start.ts`) so it stays injectable for tests the
 * same way `buildContentionGate`/`canDispatch`/`readMachineCapacity` already are there.
 *
 * #942 — the START-ELIGIBILITY half (`isMonitorEligibleIssue`, `monitorEligibleIssueSql`,
 * `notDriveOrEpicMetaSql`, `resolveCandidateStatusIds`) moved here from
 * `startup/monitor-eligibility.ts`. It was never monitor-ENGINE code: no cycle state, no
 * launching, nothing periodic — two drizzle SQL fragments, one pure predicate over an issue
 * row, and one status-id lookup, i.e. the candidate-selection slice this file already owns.
 * Its placement in `startup/` was what made the read-only preview endpoint below reachable
 * only through `startup/`, which is the `server-route -> server-monitor` edge #942 exists to
 * remove. Same slice, one file: `resolveCandidateStatusIds` calling
 * `findProjectStatusIdByName` is now an internal call rather than a cross-repository import.
 */
import { drives, issueDependencies, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { firstRow } from "../lib/first-row.js";
import { issueIdentityColumns } from "./projections.js";
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
 * fragments (`monitorEligibleIssueSql`, `notDriveOrEpicMetaSql`) � passed IN rather than
 * imported, so the query lives on this side of the persistence boundary while the monitor
 * keeps owning what "eligible" means.
 */
export async function selectScorableCandidates(statusIds: string[], filters: SQL[], database: Database) {
  if (statusIds.length === 0) return [];
  return database.select({
    ...issueIdentityColumns,
    description: issues.description, issueType: issues.issueType,
    priority: issues.priority, createdAt: issues.createdAt, statusChangedAt: issues.statusChangedAt,
  }).from(issues).where(and(inArray(issues.statusId, statusIds), ...filters));
}

type MonitorIssueLike = {
  issueType?: string | null;
  title?: string | null;
  description?: string | null;
};

const FEATURE_LIKE_PREFIX = /^(feature|enhancement)\s*[:-]/i;
const FEATURE_LIKE_TYPES = new Set(["feature", "enhancement"]);

function hasFeatureLikePrefix(value: string | null | undefined): boolean {
  return FEATURE_LIKE_PREFIX.test((value ?? "").trim());
}

/**
 * Per-issue eligibility for monitor auto-start.
 *
 * The feature/enhancement exclusion (by issueType OR a `feature:`/`enhancement:`
 * title/description prefix) keeps the GLOBAL monitor from auto-starting tickets
 * meant for human-scoped epic planning. But on an AUTO-DRIVEN project
 * (`board_autodrive`) feature tickets ARE the intended work — excluding them
 * makes the whole epic invisible to auto-start. Callers pass
 * `allowFeatureTypes: true` for auto-driven projects to skip that exclusion (#773).
 */
export function isMonitorEligibleIssue(issue: MonitorIssueLike, allowFeatureTypes = false): boolean {
  if (allowFeatureTypes) return true;
  if (FEATURE_LIKE_TYPES.has((issue.issueType ?? "").toLowerCase())) return false;
  if (hasFeatureLikePrefix(issue.title)) return false;
  if (hasFeatureLikePrefix(issue.description)) return false;
  return true;
}

/**
 * SQL counterpart of {@link isMonitorEligibleIssue}. For auto-driven projects
 * (`allowFeatureTypes`) the predicate is a no-op so feature/enhancement tickets
 * stay in the candidate set (#773).
 */
export function monitorEligibleIssueSql(allowFeatureTypes = false): SQL {
  if (allowFeatureTypes) return sql`1 = 1`;
  return sql`
    lower(coalesce(${issues.issueType}, 'task')) NOT IN ('feature', 'enhancement')
    AND lower(coalesce(${issues.title}, '')) NOT LIKE 'feature:%'
    AND lower(coalesce(${issues.title}, '')) NOT LIKE 'feature-%'
    AND lower(coalesce(${issues.title}, '')) NOT LIKE 'enhancement:%'
    AND lower(coalesce(${issues.title}, '')) NOT LIKE 'enhancement-%'
    AND lower(coalesce(${issues.description}, '')) NOT LIKE 'feature:%'
    AND lower(coalesce(${issues.description}, '')) NOT LIKE 'feature-%'
    AND lower(coalesce(${issues.description}, '')) NOT LIKE 'enhancement:%'
    AND lower(coalesce(${issues.description}, '')) NOT LIKE 'enhancement-%'
  `;
}

/**
 * SQL predicate that EXCLUDES drive/epic metas from the auto-start candidate query (#824). This is
 * the in-query enforcement of the same rule `isDriveOrEpicMeta` (`monitor-auto-start.ts`) documents —
 * applied as a WHERE condition so a meta is never even a candidate (no per-issue query, no stray
 * builder workspace).
 */
export function notDriveOrEpicMetaSql(): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM ${drives} WHERE ${drives.metaIssueId} = ${issues.id})
    AND NOT EXISTS (SELECT 1 FROM ${issueDependencies} WHERE (${issueDependencies.issueId} = ${issues.id} AND ${issueDependencies.type} = 'parent_of') OR (${issueDependencies.dependsOnId} = ${issues.id} AND ${issueDependencies.type} = 'child_of'))`;
}

/**
 * The Todo (and, for auto-driven projects, Backlog) status ids a project pulls candidates
 * from (#536). Returned as one list so the WIP-cap tally and the candidate query cannot
 * disagree about what "queued work" means.
 */
export async function resolveCandidateStatusIds(
  projectId: string,
  todoStatusId: string,
  allowFeatureTypes: boolean,
  database: Database,
): Promise<string[]> {
  const ids = [todoStatusId];
  if (allowFeatureTypes) {
    const backlogStatusId = await findProjectStatusIdByName(projectId, "Backlog", database);
    if (backlogStatusId) ids.push(backlogStatusId);
  }
  return ids;
}

/** The id of a project's status with this exact name, or null when it has none. */
export async function findProjectStatusIdByName(projectId: string, name: string, database: Database): Promise<string | null> {
  const row = await firstRow(database.select({ id: projectStatuses.id }).from(projectStatuses)
    .where(sql`${projectStatuses.name} = ${name} AND ${projectStatuses.projectId} = ${projectId}`).limit(1));
  return row?.id ?? null;
}

/**
 * Every status id carrying one of these names, ACROSS projects � the terminal-status set
 * `computeUnblockCounts` tests against, which is deliberately not project-scoped.
 */
export async function findStatusIdsByNames(names: readonly string[], database: Database): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const rows = await database.select({ id: projectStatuses.id }).from(projectStatuses)
    .where(inArray(projectStatuses.name, [...names]));
  return new Set(rows.map((r) => r.id));
}

/**
 * Stamp one issue's computed start score. Never throws � a score is a decoration on an
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
