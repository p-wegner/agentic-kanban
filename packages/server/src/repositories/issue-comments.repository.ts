import { randomUUID } from "node:crypto";
import { issueComments } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type IssueCommentKind = "preflight-clarification" | "agent-question" | "merge-attempt" | "note";
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
