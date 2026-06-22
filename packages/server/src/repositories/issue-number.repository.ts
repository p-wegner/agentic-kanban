import { issues } from "@agentic-kanban/shared/schema";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

/** A drizzle connection that is either the base db or an open transaction. */
type DbOrTx = Database | TransactionClient;

/**
 * Single source of truth for per-project issue-number allocation.
 *
 * Issue numbers are assigned `MAX(issue_number) + 1` per project. This logic was
 * previously copy-pasted across five repositories (with a drifted `?? 0` vs `?? null`
 * default that risked duplicate numbers) plus three inline queries in
 * issue.repository.ts. Every create path now funnels through `nextIssueNumber` here.
 *
 * The mcp-server keeps its own mirror (`db-utils.ts#nextIssueNumber`) because it runs
 * against a separate drizzle client and may not import server internals. Both sanctioned
 * allocators — and nothing else — are allowed to write `max(...issueNumber...)` SQL;
 * this is enforced by `packages/shared/__tests__/issue-number-single-source.test.ts`.
 */
export async function getMaxIssueNumber(
  projectId: string,
  database: DbOrTx = db,
): Promise<number | null> {
  const rows = await database
    .select({ maxNum: sql<number | null>`max(${issues.issueNumber})` })
    .from(issues)
    .where(eq(issues.projectId, projectId));
  return rows[0]?.maxNum ?? null;
}

/**
 * The next issue number to assign for a project: `max existing + 1` (1 when the
 * project has no issues yet). This is the canonical allocator every create path
 * must call instead of re-deriving the `(max ?? 0) + 1` arithmetic itself.
 */
export async function nextIssueNumber(
  projectId: string,
  database: DbOrTx = db,
): Promise<number> {
  return ((await getMaxIssueNumber(projectId, database)) ?? 0) + 1;
}
