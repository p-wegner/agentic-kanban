import { issues } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import {
  getMaxIssueNumber as sharedGetMaxIssueNumber,
  nextIssueNumber as sharedNextIssueNumber,
  isIssueNumberUniqueConstraintError,
} from "@agentic-kanban/shared/lib/issue-number";

export { isIssueNumberUniqueConstraintError };


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
 * The allocator and its UNIQUE-constraint sniff now live in
 * `@agentic-kanban/shared/lib/issue-number` (#533), so the MCP — which runs against a
 * separate drizzle client — shares them instead of keeping a verbatim mirror. Both sanctioned
 * allocators — and nothing else — are allowed to write `max(...issueNumber...)` SQL;
 * this is enforced by `packages/shared/__tests__/issue-number-single-source.test.ts`.
 */
export async function getMaxIssueNumber(
  projectId: string,
  database: DbOrTx = db,
): Promise<number | null> {
  return sharedGetMaxIssueNumber(database as never, issues, projectId);
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
  return sharedNextIssueNumber(database as never, issues, projectId);
}
