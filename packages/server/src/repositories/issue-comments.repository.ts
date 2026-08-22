import { randomUUID } from "node:crypto";
import { issueComments } from "@agentic-kanban/shared/schema";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type IssueCommentKind = "preflight-verdict" | "preflight-clarification" | "agent-question" | "merge-attempt" | "note" | "gate-decision";
export type IssueCommentAuthor = "user" | "butler" | "agent" | "preflight" | "system";

export interface AddIssueCommentInput {
  issueId: string;
  workspaceId?: string | null;
  kind: IssueCommentKind;
  author: IssueCommentAuthor;
  body: string;
  /** Structured payload (e.g. Q&A pairs); serialized to JSON. */
  payload?: unknown;
  /** ISO timestamp — passed in so callers control time (nowOverride pattern). */
  createdAt?: string;
}

export type IssueCommentRow = typeof issueComments.$inferSelect;

export async function insertIssueComment(
  input: AddIssueCommentInput,
  database: Database = db,
): Promise<IssueCommentRow> {
  const id = randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const row = {
    id,
    issueId: input.issueId,
    workspaceId: input.workspaceId ?? null,
    kind: input.kind,
    author: input.author,
    body: input.body,
    payload: input.payload === undefined ? null : JSON.stringify(input.payload),
    createdAt,
  };
  await database.insert(issueComments).values(row);
  return row;
}

/** Most recent comment of a given kind for an issue, or null. Used to dedup repeated system notes. */
export async function getLatestIssueCommentByKind(
  issueId: string,
  kind: IssueCommentKind,
  database: Database = db,
): Promise<IssueCommentRow | null> {
  const rows = await database
    .select()
    .from(issueComments)
    .where(and(eq(issueComments.issueId, issueId), eq(issueComments.kind, kind)))
    .orderBy(desc(issueComments.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Default number of comments an issue-detail read returns (#738).
 *
 * The read was unbounded: four issues on the dev board carried ~7,478 comments each, so
 * opening one loaded ~3.8 MB of comment text — and because the order was ASCENDING the
 * reader waited for all of it before seeing the newest entry. A cap is needed regardless of
 * whether duplicates ever come back: a long-lived issue accumulates a legitimately long
 * thread too.
 */
export const ISSUE_COMMENT_PAGE_LIMIT = 200;
/** Hard ceiling on a caller-supplied `limit`, so `?limit=100000` cannot re-open the hole. */
export const ISSUE_COMMENT_PAGE_LIMIT_MAX = 1000;

export interface IssueCommentsPage {
  /** The page, ASCENDING by createdAt — see the ordering note below. */
  comments: IssueCommentRow[];
  /** Total comments on the issue, so a caller can say "showing 200 of 7,478". */
  totalCount: number;
  /** True when older comments exist beyond this page. */
  hasMore: boolean;
  /**
   * `createdAt` of the OLDEST row in this page — pass it back as `before` to page further
   * into the past. A keyset cursor, not an offset: an offset re-scans everything it skips.
   */
  nextCursor: string | null;
}

export interface IssueCommentsPageOptions {
  limit?: number;
  /** Keyset cursor: return only comments strictly older than this ISO timestamp. */
  before?: string | null;
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined || limit <= 0) return ISSUE_COMMENT_PAGE_LIMIT;
  return Math.min(Math.trunc(limit), ISSUE_COMMENT_PAGE_LIMIT_MAX);
}

/**
 * One page of an issue's comments, NEWEST-FIRST at the SQL level and reversed to ascending
 * before returning.
 *
 * Both halves of that matter. Newest-first + LIMIT is what makes the query cheap — it walks
 * `idx_issue_comments_issue_id_created_at` backwards and stops after `limit` rows instead of
 * reading the whole thread. Returning ascending is what keeps every existing reader correct:
 * the detail panel and the API have always rendered a comment thread oldest-to-newest, and
 * the client is not this ticket's to change. So the page is "the newest N, in reading order".
 */
export async function getIssueCommentsPage(
  issueId: string,
  opts: IssueCommentsPageOptions = {},
  database: Database = db,
): Promise<IssueCommentsPage> {
  const limit = clampLimit(opts.limit);
  const filters = [eq(issueComments.issueId, issueId)];
  if (opts.before) filters.push(lt(issueComments.createdAt, opts.before));

  // limit + 1 so "are there older ones?" needs no second count-with-cursor query.
  const rows = await database
    .select()
    .from(issueComments)
    .where(and(...filters))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const totalRows = await database
    .select({ n: sql<number>`count(*)` })
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId));

  return {
    comments: page.slice().reverse(),
    totalCount: Number(totalRows[0]?.n ?? 0),
    hasMore,
    nextCursor: page.length > 0 ? page[page.length - 1].createdAt : null,
  };
}

/**
 * The newest page of an issue's comments, ascending. Capped — see
 * `getIssueCommentsPage` for why, and use that directly when the caller needs to page.
 */
export async function getIssueComments(
  issueId: string,
  database: Database = db,
  opts: IssueCommentsPageOptions = {},
): Promise<IssueCommentRow[]> {
  return (await getIssueCommentsPage(issueId, opts, database)).comments;
}

export async function deleteIssueComment(
  commentId: string,
  database: Database = db,
): Promise<void> {
  await database.delete(issueComments).where(eq(issueComments.id, commentId));
}

/**
 * The most recent comments for one issue (optionally narrowed to a workspace and kind),
 * newest first. Used by callers that must decide whether a system note they are about to
 * write is a REPEAT of one already on the timeline (#737) — the timeline itself is the
 * record of what was last reported, so no extra column is needed to remember it.
 */
export async function listRecentIssueComments(
  issueId: string,
  opts: { workspaceId?: string | null; kind?: IssueCommentKind; limit?: number } = {},
  database: Database = db,
): Promise<IssueCommentRow[]> {
  const filters = [eq(issueComments.issueId, issueId)];
  if (opts.workspaceId) filters.push(eq(issueComments.workspaceId, opts.workspaceId));
  if (opts.kind) filters.push(eq(issueComments.kind, opts.kind));
  return database
    .select()
    .from(issueComments)
    .where(and(...filters))
    .orderBy(desc(issueComments.createdAt))
    .limit(opts.limit ?? 20);
}
