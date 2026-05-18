import { randomUUID } from "crypto";

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
