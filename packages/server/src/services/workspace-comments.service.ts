import type { Database } from "../db/index.js";
import {
  getDiffComments,
  createDiffComment as createDiffCommentRepo,
  updateDiffComment as updateDiffCommentRepo,
  setDiffCommentResolved,
  findDiffComment,
  deleteDiffComment,
} from "../repositories/session.repository.js";
import { getWorkspaceById } from "../repositories/workspace.repository.js";
import { WorkspaceError } from "./workspace-internals.js";

export function createWorkspaceCommentService(deps: { database: Database }) {
  const { database } = deps;

  async function listComments(workspaceId: string, filePath?: string) {
    return getDiffComments(workspaceId, filePath, database);
  }

  async function createComment(
    workspaceId: string,
    body: { filePath: string; body: string; lineNumOld?: number | null; lineNumNew?: number | null; side?: string },
  ) {
    const ws = await getWorkspaceById(workspaceId, database);
    if (!ws) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    return createDiffCommentRepo(workspaceId, body, database);
  }

  async function updateComment(workspaceId: string, commentId: string, body: string) {
    const existing = await findDiffComment(commentId, workspaceId, database);
    if (!existing) throw new WorkspaceError("Comment not found", "NOT_FOUND");
    await updateDiffCommentRepo(commentId, body, database);
    return { id: commentId };
  }

  async function deleteComment(workspaceId: string, commentId: string) {
    const existing = await findDiffComment(commentId, workspaceId, database);
    if (!existing) throw new WorkspaceError("Comment not found", "NOT_FOUND");
    await deleteDiffComment(commentId, database);
  }

  async function resolveComment(workspaceId: string, commentId: string, resolved: boolean) {
    const existing = await findDiffComment(commentId, workspaceId, database);
    if (!existing) throw new WorkspaceError("Comment not found", "NOT_FOUND");
    await setDiffCommentResolved(commentId, resolved, database);
    return findDiffComment(commentId, workspaceId, database);
  }

  return { listComments, createComment, updateComment, deleteComment, resolveComment };
}
