import { randomUUID } from "node:crypto";
import { issueComments } from "@agentic-kanban/shared/schema";
import { and, desc, eq } from "drizzle-orm";
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

export async function getIssueComments(
  issueId: string,
  database: Database = db,
): Promise<IssueCommentRow[]> {
  return database
    .select()
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId))
    .orderBy(issueComments.createdAt);
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
