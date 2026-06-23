import { issues } from "@agentic-kanban/shared/schema";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

/** A drizzle connection that is either the base db or an open transaction. */
type DbOrTx = Database | TransactionClient;
const ISSUE_NUMBER_UNIQUE_INDEX = "idx_issues_project_id_issue_number";

function errorText(err: unknown): string {
  const record = typeof err === "object" && err !== null ? err as Record<string, unknown> : {};
  const cause = record.cause;
  return [
    err instanceof Error ? err.message : "message" in record ? String(record.message) : String(err),
    typeof cause === "object" && cause !== null && "message" in cause
      ? String((cause as { message?: unknown }).message)
      : "",
    "code" in record ? String(record.code) : "",
    typeof cause === "object" && cause !== null && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "",
  ].join("\n");
}

export function isIssueNumberUniqueConstraintError(err: unknown): boolean {
  const text = errorText(err);
  return (
    (text.includes("UNIQUE constraint") || text.includes("SQLITE_CONSTRAINT_UNIQUE")) &&
    (
      text.includes(ISSUE_NUMBER_UNIQUE_INDEX) ||
      (text.includes("issues.project_id") && text.includes("issues.issue_number"))
    )
  );
}

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
