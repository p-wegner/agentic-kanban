import { inArray } from "drizzle-orm";
import { workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";

export interface StrandedInReviewWorkspaceRow {
  issueId: string;
  status: string;
  isDirect: boolean;
  mergedAt: string | null;
  updatedAt: string | null;
}

/** All workspaces for the given issue ids, sliced to what findStrandedInReviewIssueIds needs. */
export async function getWorkspacesForStrandedInReviewCheck(
  issueIds: string[],
  database: Database = db,
): Promise<StrandedInReviewWorkspaceRow[]> {
  if (issueIds.length === 0) return [];
  return database
    .select({
      issueId: workspaces.issueId,
      status: workspaces.status,
      isDirect: workspaces.isDirect,
      mergedAt: workspaces.mergedAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(inArray(workspaces.issueId, issueIds));
}
