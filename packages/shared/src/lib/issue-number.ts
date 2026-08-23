// Per-project issue-number allocation + its UNIQUE-constraint sniff (#533).
//
// The server repository and the MCP `db-utils` carried VERBATIM copies of
// `errorText` and `isIssueNumberUniqueConstraintError`, and two spellings of the
// allocator. The server file's own comment explained why: the MCP "runs against a
// separate drizzle client and may not import server internals". True — but that is a
// reason to put the logic in shared, not to copy it: shared already takes a drizzle
// client as a parameter elsewhere for exactly this reason
// (`findOpenUnmergedWorkspace` in issue-status-orchestration.ts).
//
// Duplication here is not cosmetic. The sniff decides whether a collision is retried
// or surfaced as a hard failure, so the two copies drifting apart would make the
// server and the MCP disagree about whether the same DB error is retryable.

import { eq, sql } from "drizzle-orm";

/** The unique index guarding (project_id, issue_number). */
export const ISSUE_NUMBER_UNIQUE_INDEX = "idx_issues_project_id_issue_number";

/**
 * Flatten an error to searchable text, INCLUDING `cause` and driver `code` fields.
 *
 * Deliberately richer than `errorMessage` (#527): a libsql UNIQUE violation puts the
 * distinguishing detail on `cause.message` / `code`, which a plain `.message` read
 * never sees — the whole reason this sniff needs its own extractor.
 */
function constraintErrorText(err: unknown): string {
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

/** Whether `err` is the (project_id, issue_number) uniqueness violation — i.e. retryable. */
export function isIssueNumberUniqueConstraintError(err: unknown): boolean {
  const text = constraintErrorText(err);
  return (
    (text.includes("UNIQUE constraint") || text.includes("SQLITE_CONSTRAINT_UNIQUE")) &&
    (
      text.includes(ISSUE_NUMBER_UNIQUE_INDEX) ||
      (text.includes("issues.project_id") && text.includes("issues.issue_number"))
    )
  );
}

/**
 * Minimal drizzle surface: anything that can run this one select — the server db,
 * an open transaction, or the MCP's separate client. Structural on purpose, so shared
 * never has to import either package's concrete Database type.
 */
export interface IssueNumberDb {
  select: (fields: Record<string, unknown>) => {
    from: (table: unknown) => {
      where: (condition: unknown) => Promise<Array<{ maxNum: number | null }>>;
    };
  };
}

/** Highest issue number in a project, or null when it has none yet. */
export async function getMaxIssueNumber(
  database: IssueNumberDb,
  issuesTable: { issueNumber: unknown; projectId: unknown },
  projectId: string,
): Promise<number | null> {
  const rows = await database
    .select({ maxNum: sql<number | null>`max(${issuesTable.issueNumber})` })
    .from(issuesTable)
    .where(eq(issuesTable.projectId as never, projectId));
  return rows[0]?.maxNum ?? null;
}

/**
 * The next issue number for a project: `max existing + 1`, or 1 when it has none.
 *
 * The canonical allocator. Every create path must call this rather than re-deriving
 * `(max ?? 0) + 1` — a previous drift between `?? 0` and `?? null` risked handing out
 * duplicate numbers.
 */
export async function nextIssueNumber(
  database: IssueNumberDb,
  issuesTable: { issueNumber: unknown; projectId: unknown },
  projectId: string,
): Promise<number> {
  return ((await getMaxIssueNumber(database, issuesTable, projectId)) ?? 0) + 1;
}

/**
 * How many times a create path re-allocates an issue number after a UNIQUE collision.
 *
 * Was a private `const ISSUE_NUMBER_INSERT_ATTEMPTS = 3` in six modules (#772), each with
 * its own copy of the retry loop below — the same drift risk the sniff above was pulled
 * into shared to end.
 */
export const ISSUE_NUMBER_INSERT_ATTEMPTS = 3;

/**
 * Allocate an issue number and insert with it, retrying the whole pair when the
 * (project_id, issue_number) unique index rejects it — a concurrent create took the
 * number between the `max()` read and the insert.
 *
 * `allocate` and `insert` are both re-run per attempt because the retry must pick a FRESH
 * number, and every caller also mints fresh row ids/timestamps inside the attempt.
 *
 * Semantics are the hand-written loop's, exactly: a non-collision error propagates
 * immediately, and a collision on the LAST attempt propagates too. The hand-written copies
 * each followed the loop with an `if (id === null) return "could not allocate…"` guard that
 * was unreachable for that reason; it is not reproduced here.
 */
export async function withUniqueIssueNumber<T>(
  allocate: () => Promise<number>,
  insert: (issueNumber: number) => Promise<T>,
  attempts: number = ISSUE_NUMBER_INSERT_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const issueNumber = await allocate();
    try {
      return await insert(issueNumber);
    } catch (err: unknown) {
      if (attempt < attempts && isIssueNumberUniqueConstraintError(err)) continue;
      throw err;
    }
  }
}
