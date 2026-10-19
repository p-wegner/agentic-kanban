import { issues, projectStatuses, tags, issueTags } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { issueTextColumns } from "./projections.js";

/** All issues of a project + their status name, ordered by issue number — for export. */
export async function getIssuesForExport(projectId: string, database: Database = db) {
  return database
    .select({
      ...issueTextColumns,
      priority: issues.priority,
      issueType: issues.issueType,
      statusName: projectStatuses.name,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.projectId, projectId))
    .orderBy(issues.issueNumber);
}

/** Tag names for a batch of issues (issue_tags ⋈ tags). Empty input → empty result. */
export async function getTagsForIssues(issueIds: string[], database: Database = db) {
  if (issueIds.length === 0) return [];
  return database
    .select({ issueId: issueTags.issueId, tagName: tags.name })
    .from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(inArray(issueTags.issueId, issueIds));
}
