/**
 * The `workspaces` reads and writes the release-candidate heal flow needs (#1239) — inside the
 * `workspaces` owning subtree (#822), in a file of their own so `workspace-crud.repository.ts`
 * stays under its god-module baseline.
 */
import { workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { mirrorWorkspaceColumnsToLeadingRepo } from "./repo.repository.js";

/**
 * Every non-closed workspace of an issue, direct or not (#1239) — what an rc abandon retargets
 * onto the next candidate. Small by construction: an issue holds at most a handful.
 */
export async function listOpenWorkspacesForIssue(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({ id: workspaces.id, branch: workspaces.branch, baseBranch: workspaces.baseBranch, status: workspaces.status })
    .from(workspaces)
    .where(and(eq(workspaces.issueId, issueId), ne(workspaces.status, "closed")))
    .limit(10);
}

/**
 * Move a workspace's base (#1239, rc abandon): `update-base` then rebases onto the new rc and the
 * merge targets it. Mirrored to the leading-repo row exactly as `setWorkspaceWorkingDir` does.
 */
export async function setWorkspaceBaseBranch(
  workspaceId: string,
  values: { baseBranch: string; updatedAt: string },
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({ baseBranch: values.baseBranch, updatedAt: values.updatedAt }).where(eq(workspaces.id, workspaceId));
  await mirrorWorkspaceColumnsToLeadingRepo(workspaceId, { baseBranch: values.baseBranch }, database);
}
