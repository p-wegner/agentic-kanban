import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import { getIssueProjectId } from "../repositories/issue.repository.js";
import {
  insertIssueComment,
  getIssueComments,
  type AddIssueCommentInput,
  type IssueCommentRow,
} from "../repositories/issue-comments.repository.js";

export interface IssueComment {
  id: string;
  issueId: string;
  workspaceId: string | null;
  kind: string;
  author: string;
  body: string;
  /** Parsed structured payload (null when none / unparseable). */
  payload: unknown;
  createdAt: string;
}

function toApiComment(row: IssueCommentRow): IssueComment {
  let payload: unknown = null;
  if (row.payload) {
    try { payload = JSON.parse(row.payload); } catch { payload = null; }
  }
  return {
    id: row.id,
    issueId: row.issueId,
    workspaceId: row.workspaceId,
    kind: row.kind,
    author: row.author,
    body: row.body,
    payload,
    createdAt: row.createdAt,
  };
}

export function createIssueCommentsService(deps: {
  database: Database;
  boardEvents?: BoardEvents;
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

  return { addComment, listComments };
}

export type IssueCommentsService = ReturnType<typeof createIssueCommentsService>;
