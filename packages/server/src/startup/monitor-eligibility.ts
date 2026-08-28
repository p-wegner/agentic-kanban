import { drives, issueDependencies, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";

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
export async function resolveCandidateStatusIds(projectId: string, todoStatusId: string, allowFeatureTypes: boolean): Promise<string[]> {
  const ids = [todoStatusId];
  if (allowFeatureTypes) {
    const backlogStatus = await db.select({ id: projectStatuses.id }).from(projectStatuses)
      .where(sql`${projectStatuses.name} = 'Backlog' AND ${projectStatuses.projectId} = ${projectId}`).limit(1);
    if (backlogStatus.length > 0) ids.push(backlogStatus[0].id);
  }
  return ids;
}
