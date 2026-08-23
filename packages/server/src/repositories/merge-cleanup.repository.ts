import { issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { projectStatusIdName } from "./projections.js";
import { listProjectStatusIdNames } from "./project-status.repository.js";
import { firstRow } from "../lib/first-row.js";

export async function getIssueStatusAndProject(issueId: string, database: Database = db) {
  return firstRow(
    database
      // statusChangedAt lets reconcileMergedIssue tell "the status never caught up with the
      // merge" apart from "a human deliberately moved this issue AFTER the merge".
      .select({ statusId: issues.statusId, projectId: issues.projectId, statusChangedAt: issues.statusChangedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
  );
}

export async function getIssueProject(issueId: string, database: Database = db) {
  return firstRow(
    database
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
  );
}

// Order-INDEPENDENT (#773): reconcileMergedIssue only `find`s by exact name ("Done" /
// "AI Reviewed") and by the issue's own status id, and (project_id, name) is unique since
// 0125, so no ordering can change which row it picks. Ordered anyway — the accessor always
// is, at no measured cost.
export async function getProjectStatusOptions(projectId: string, database: Database = db) {
  return listProjectStatusIdNames(projectId, database);
}

export async function setIssueStatus(
  issueId: string,
  statusId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await transitionIssueStatus(database, issueId, statusId, { now });
}
