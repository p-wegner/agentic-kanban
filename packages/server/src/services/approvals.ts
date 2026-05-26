import { randomUUID } from "crypto";
import { getSessionWorkspaceId } from "../repositories/session.repository.js";
import { getWorkspaceById } from "../repositories/workspace.repository.js";
import { getIssueProjectId } from "../repositories/issue.repository.js";

export type ApprovalDecision = "allow" | "deny" | "allow_session" | "deny_session";

export interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  workspaceId?: string;
  projectId?: string;
  createdAt: number;
  decision?: ApprovalDecision;
}

const pending = new Map<string, PendingApproval>();

export function createApproval(data: Omit<PendingApproval, "id" | "createdAt">): PendingApproval {
  const approval: PendingApproval = {
    id: randomUUID(),
    createdAt: Date.now(),
    ...data,
  };
  pending.set(approval.id, approval);
  return approval;
}

export function getApproval(id: string): PendingApproval | undefined {
  return pending.get(id);
}

export function resolveApproval(id: string, decision: ApprovalDecision): boolean {
  const approval = pending.get(id);
  if (!approval) return false;
  approval.decision = decision;
  return true;
}

export function deleteApproval(id: string) {
  pending.delete(id);
}

export async function resolveApprovalContext(sessionId: string): Promise<{
  workspaceId?: string;
  projectId?: string;
}> {
  try {
    const workspaceId = await getSessionWorkspaceId(sessionId) ?? undefined;
    if (!workspaceId) return {};
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return { workspaceId };
    const projectId = await getIssueProjectId(ws.issueId) ?? undefined;
    return { workspaceId, projectId };
  } catch {
    return {};
  }
}
