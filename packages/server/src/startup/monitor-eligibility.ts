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

export function isMonitorEligibleIssue(issue: MonitorIssueLike): boolean {
  if (FEATURE_LIKE_TYPES.has((issue.issueType ?? "").toLowerCase())) return false;
  if (hasFeatureLikePrefix(issue.title)) return false;
  if (hasFeatureLikePrefix(issue.description)) return false;
  return true;
}

export function monitorEligibleIssueSql(): SQL {
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
