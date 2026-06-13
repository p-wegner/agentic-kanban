import { issues } from "@agentic-kanban/shared/schema";
import { sql, type SQL } from "drizzle-orm";

type MonitorIssueLike = {
  issueType?: string | null;
  title?: string | null;
  description?: string | null;
};

const FEATURE_LIKE_PREFIX = /^(feature|enhancement)\s*[:\-]/i;
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
