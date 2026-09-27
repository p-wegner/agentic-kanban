// Issue WRITES for the CLI: through the running board server when it serves this CLI's
// database (so an open board broadcasts and shows the change), else directly into the DB
// with one stderr notice. Transport choice and its safety rule: `../board-server-writes.ts`.
import { isTerminalStatusName } from "@agentic-kanban/shared";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { createIssueWithNextNumber, moveIssueToStatus } from "../../repositories/issue.repository.js";
import { updateIssueById } from "../../repositories/issue-service.repository.js";
import { findOpenUnmergedWorkspace } from "../../repositories/workspace.repository.js";
import { isWorkspaceBranchFullyContained } from "../../services/branch-containment.service.js";
import { openWorkspaceBlockMessage } from "../../lib/terminal-move-guard.js";
import { resolveIssueWriteTransport, boardServerWrite, directWriteNotice } from "../board-server-writes.js";

export interface CliIssueCreateInput {
  projectId: string;
  statusId: string;
  title: string;
  description?: string;
  priority?: string;
  issueType?: string;
  tags?: string[];
}

/** `POST /api/issues` (which accepts `tags` in the same transaction, #1108) or the direct insert. */
export async function createIssueOnBoard(input: CliIssueCreateInput): Promise<{ id: string; issueNumber: number | null }> {
  const transport = await resolveIssueWriteTransport();
  if (transport.mode === "server") {
    return boardServerWrite<{ id: string; issueNumber: number | null }>(transport, "POST", "/api/issues", input);
  }
  console.warn(directWriteNotice(transport.reason));
  return createIssueWithNextNumber(input);
}

/** `PATCH /api/issues/:id` with only recognised keys (the server stamps `updatedAt` itself). */
export async function updateIssueOnBoard(issueId: string, updates: Record<string, unknown>): Promise<void> {
  const transport = await resolveIssueWriteTransport();
  if (transport.mode === "server") {
    await boardServerWrite(transport, "PATCH", `/api/issues/${encodeURIComponent(issueId)}`, updates);
    return;
  }
  console.warn(directWriteNotice(transport.reason));
  await updateIssueById(issueId, { ...updates, updatedAt: new Date().toISOString() });
}

/**
 * Move to a status by id. The PATCH route takes `statusId`, never a name (#987), and applies
 * the AK-535 terminal-move guard itself, answering 409 with the same message the direct path
 * prints. Returns the message to print on refusal, or null when the move landed.
 */
export async function moveIssueOnBoard(issueId: string, statusId: string, statusName: string): Promise<string | null> {
  const transport = await resolveIssueWriteTransport();
  if (transport.mode === "server") {
    try {
      await boardServerWrite(transport, "PATCH", `/api/issues/${encodeURIComponent(issueId)}`, { statusId });
      return null;
    } catch (err) {
      return errorMessage(err);
    }
  }
  console.warn(directWriteNotice(transport.reason));
  // AK-535 guard: don't strand an open, non-direct, unmerged branch by moving
  // the issue to a terminal status. Same guard as the server PATCH route and MCP.
  if (isTerminalStatusName(statusName)) {
    const openWs = await findOpenUnmergedWorkspace(issueId);
    // #1205: a branch fully contained in the base (0 ahead) has nothing left to
    // merge — don't let it block the move.
    if (openWs && !(await isWorkspaceBranchFullyContained(openWs.id))) {
      return openWorkspaceBlockMessage(statusName, openWs.branch);
    }
  }
  await moveIssueToStatus(issueId, statusId);
  return null;
}
