import { eq } from "drizzle-orm";
import { workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { mirrorWorkspaceColumnsToLeadingRepo } from "./repo.repository.js";
import { markWorkspaceRepoSummariesDirty } from "./workspace-summary-projection.repository.js";

/**
 * Stamp mergedAt/mergedHeadSha/updatedAt on a workspace row.
 * Also marks the summary projection dirty (#399, decision 014): a merge changes the git
 * facts the board summary serves, so the projection must refresh before its next TTL.
 */
export async function stampWorkspaceMergedAt(
  id: string,
  now: string,
  mergedHeadSha: string | null,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({ mergedAt: now, mergedHeadSha, updatedAt: now, summaryDirty: true }).where(eq(workspaces.id, id));
  await mirrorWorkspaceColumnsToLeadingRepo(id, { mergedHeadSha }, database);
  // #415 — a landed merge moves every repo's ahead/merged facts, not just the leading's.
  await markWorkspaceRepoSummariesDirty(id, database);
}

/**
 * Stamp ONLY mergedHeadSha (+updatedAt) on a workspace row, leaving mergedAt untouched.
 * Used by the reconcile-as-done close path (#115) which sets mergedAt separately via
 * closeWorkspace/finalizeMergeCleanup and only needs to record the landed leading tip.
 */
export async function stampWorkspaceMergedHeadSha(
  id: string,
  mergedHeadSha: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({ mergedHeadSha, updatedAt: now }).where(eq(workspaces.id, id));
  await mirrorWorkspaceColumnsToLeadingRepo(id, { mergedHeadSha }, database);
}
