import type { Database } from "../db/index.js";
import type { BoardEventSink } from "./board-events.js";
import { getIssueProjectId } from "../repositories/issue.repository.js";
import type { IssueComment } from "@agentic-kanban/shared/types";
import { isIssueCommentKind } from "@agentic-kanban/shared/lib/issue-comment-kind";
import {
  insertIssueComment,
  getIssueComments,
  deleteIssueComment,
  type AddIssueCommentInput,
  type IssueCommentRow,
} from "../repositories/issue-comments.repository.js";

// Shape lives in shared (#569). `kind` is the six-member union, not a bare string —
// both copies had widened it even though the repository has always had the union.
export type { IssueComment };

function toApiComment(row: IssueCommentRow): IssueComment {
  let payload: unknown = null;
  if (row.payload) {
    try { payload = JSON.parse(row.payload); } catch { payload = null; }
  }
  return {
    id: row.id,
    issueId: row.issueId,
    workspaceId: row.workspaceId,
    // The column is plain text, so an older or hand-written row can hold anything;
    // narrow with the shared guard rather than casting (#569). Unknown reads as "note",
    // which is exactly how the UI renders an unlabelled comment anyway.
    kind: isIssueCommentKind(row.kind) ? row.kind : "note",
    author: row.author,
    body: row.body,
    payload,
    createdAt: row.createdAt,
  };
}

export function createIssueCommentsService(deps: {
  database: Database;
  boardEvents?: BoardEventSink;
}) {
  const { database, boardEvents } = deps;

  async function addComment(input: AddIssueCommentInput): Promise<IssueComment> {
    const row = await insertIssueComment(input, database);
    const projectId = await getIssueProjectId(input.issueId, database);
    if (projectId) boardEvents?.broadcast(projectId, "issue_updated");
    return toApiComment(row);
  }

  async function listComments(issueId: string): Promise<IssueComment[]> {
    const rows = await getIssueComments(issueId, database);
    return rows.map(toApiComment);
  }

  async function removeComment(issueId: string, commentId: string): Promise<void> {
    await deleteIssueComment(commentId, database);
    const projectId = await getIssueProjectId(issueId, database);
    if (projectId) boardEvents?.broadcast(projectId, "issue_updated");
  }

  return { addComment, listComments, removeComment };
}

export type IssueCommentsService = ReturnType<typeof createIssueCommentsService>;
