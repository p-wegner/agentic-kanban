import { eq } from "drizzle-orm";
import { issues, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getIssueProjectRef(
  issueId: string,
  database: Database = db,
) {
  const issueRows = await database
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return issueRows[0] ?? null;
}

export async function getWorkspacesForIssueMergedCommits(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({
      id: workspaces.id,
      branch: workspaces.branch,
      baseBranch: workspaces.baseBranch,
      baseCommitSha: workspaces.baseCommitSha,
      mergedAt: workspaces.mergedAt,
      mergedHeadSha: workspaces.mergedHeadSha,
      isDirect: workspaces.isDirect,
    })
    .from(workspaces)
    .where(eq(workspaces.issueId, issueId));
}
