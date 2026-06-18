import { and, eq, isNotNull } from "drizzle-orm";
import { issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * Rows backing the milestone burndown/progress summary: issues that belong to a
 * milestone in the given project, joined to their status name. Pure read — the
 * milestone service owns the per-milestone bucketing/burndown aggregation.
 */
export async function getMilestoneIssueRows(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      milestoneId: issues.milestoneId,
      createdAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
      statusName: projectStatuses.name,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(eq(issues.projectId, projectId), isNotNull(issues.milestoneId)));
}
