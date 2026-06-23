import { eq } from "drizzle-orm";
import * as schema from "../../schema/index.js";
import { getDiffShortstat, getChangedFileNames } from "../git-service.js";
import type { WorkflowDb, WorkflowNodeRow, TransitionTarget } from "./types.js";
import { evaluateCondition, type SignalContext } from "./conditions.js";
import { getNode, getOutgoingTransitions, countNodeVisits } from "./node-queries.js";
import { resolveStatusId } from "./status-resolution.js";

/**
 * Compute the live workspace signals used to evaluate edge conditions: the diff
 * state (from git) plus any agent-reported values (e.g. testsPassed). Safe to
 * call with no worktree — diff signals are simply left undefined.
 */
export async function computeWorkspaceSignals(
  db: WorkflowDb,
  workspaceId: string,
  reported?: { testsPassed?: boolean },
): Promise<SignalContext> {
  const ctx: SignalContext = { testsPassed: reported?.testsPassed };
  const rows = await db
    .select({ workingDir: schema.workspaces.workingDir, baseBranch: schema.workspaces.baseBranch })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  const ws = rows[0];
  if (ws?.workingDir) {
    const base = ws.baseBranch || "HEAD";
    try {
      const stat = await getDiffShortstat(ws.workingDir, base);
      ctx.diffFilesChanged = stat.filesChanged;
      ctx.diffFiles = await getChangedFileNames(ws.workingDir, base);
    } catch {
      /* leave diff signals undefined → those conditions fall back to manual */
    }
  }
  return ctx;
}

export interface ProposeResult {
  ok: boolean;
  error?: string;
  toNode?: WorkflowNodeRow;
  statusName?: string | null;
  statusId?: string | null;
  /** Outgoing transitions from the new node (for re-injection). */
  nextTransitions?: TransitionTarget[];
  /** True when the engine auto-resolved the target from a firing condition. */
  autoResolved?: boolean;
}

/**
 * Advance a workspace to a new node along a valid edge from its current node.
 * Enforces maxVisits, records the transition, updates workspace.currentNodeId
 * and the issue's currentNodeId + derived status.
 */
export async function proposeTransition(
  db: WorkflowDb,
  opts: {
    workspaceId: string;
    toNodeId?: string;
    toNodeName?: string;
    summary?: string;
    triggeredBy?: string;
    /** Workspace state signals for evaluating data-driven edge conditions (#85). */
    signals?: SignalContext;
  },
): Promise<ProposeResult> {
  const { workspaceId, toNodeId, toNodeName, summary, triggeredBy = "agent", signals = {} } = opts;

  const wsRows = await db
    .select({
      id: schema.workspaces.id,
      issueId: schema.workspaces.issueId,
      currentNodeId: schema.workspaces.currentNodeId,
      parentWorkspaceId: schema.workspaces.parentWorkspaceId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (wsRows.length === 0) return { ok: false, error: `Workspace ${workspaceId} not found` };
  const ws = wsRows[0];

  if (!ws.currentNodeId) {
    return { ok: false, error: "This workspace is not running a workflow (no current node)." };
  }

  const transitions = await getOutgoingTransitions(db, ws.currentNodeId);
  let target: TransitionTarget | undefined;
  let autoResolved = false;

  if (toNodeId) {
    target = transitions.find((t) => t.toNodeId === toNodeId);
  } else if (toNodeName) {
    target =
      transitions.find((t) => t.toNodeName === toNodeName) ??
      transitions.find((t) => t.toNodeName.toLowerCase() === toNodeName.toLowerCase());
  } else {
    // No explicit target: auto-resolve from edge conditions (#85). Take the edge
    // iff exactly one fires given the current signals.
    const firing = transitions.filter((t) => evaluateCondition(t.condition, signals) === "fire");
    if (firing.length === 1) {
      target = firing[0];
      autoResolved = true;
    } else {
      const valid = transitions.map((t) => `${t.toNodeName} [${t.condition}]`).join(", ") || "(none — terminal stage)";
      return {
        ok: false,
        error:
          firing.length === 0
            ? `No edge condition fired automatically. Specify a target stage. Valid next stages: ${valid}`
            : `Multiple edges fired (${firing.map((t) => t.toNodeName).join(", ")}). Specify which stage to advance to.`,
      };
    }
  }

  if (!target) {
    const valid = transitions.map((t) => t.toNodeName).join(", ") || "(none — terminal stage)";
    return {
      ok: false,
      error: `No valid transition to "${toNodeName ?? toNodeId}" from the current stage. Valid next stages: ${valid}`,
    };
  }

  // Gate an explicitly-chosen target whose condition is known to be unsatisfied.
  if (!autoResolved) {
    const verdict = evaluateCondition(target.condition, signals);
    if (verdict === "block") {
      return {
        ok: false,
        error: `Transition to "${target.toNodeName}" is gated by condition "${target.condition}", which is not satisfied by the current workspace state.`,
      };
    }
  }

  const toNode = await getNode(db, target.toNodeId);
  if (!toNode) return { ok: false, error: `Target node ${target.toNodeId} not found` };

  // Cycle protection.
  if (toNode.maxVisits > 0) {
    const visits = await countNodeVisits(db, workspaceId, toNode.id);
    if (visits >= toNode.maxVisits) {
      return {
        ok: false,
        error: `Node "${toNode.name}" has reached its visit budget (${toNode.maxVisits}). Escalate to a human instead of looping further.`,
      };
    }
  }

  const now = new Date().toISOString();

  // Resolve the issue's project to map statusName → statusId.
  const issueRows = await db
    .select({ id: schema.issues.id, projectId: schema.issues.projectId })
    .from(schema.issues)
    .where(eq(schema.issues.id, ws.issueId))
    .limit(1);
  const issue = issueRows[0];

  // A fork child shares the parent's issue; its transitions must NOT drive the
  // shared issue's currentNode/status — only the parent path does that.
  const isForkChild = !!ws.parentWorkspaceId;

  let statusId: string | null = null;
  if (issue && !isForkChild && toNode.statusName) {
    statusId = await resolveStatusId(db, issue.projectId, toNode.statusName);
  }

  // Record the transition (history → analytics + progress + visit counting).
  await db.insert(schema.workflowTransitions).values({
    id: crypto.randomUUID(),
    workspaceId,
    fromNodeId: ws.currentNodeId,
    toNodeId: toNode.id,
    summary: summary ?? null,
    triggeredBy,
    createdAt: now,
  });

  await db
    .update(schema.workspaces)
    .set({ currentNodeId: toNode.id, updatedAt: now })
    .where(eq(schema.workspaces.id, workspaceId));

  if (issue && !isForkChild) {
    const issueUpdate: Record<string, unknown> = { currentNodeId: toNode.id, updatedAt: now };
    if (statusId) {
      issueUpdate.statusId = statusId;
      issueUpdate.statusChangedAt = now;
    }
    await db.update(schema.issues).set(issueUpdate).where(eq(schema.issues.id, issue.id));
  }

  const nextTransitions = await getOutgoingTransitions(db, toNode.id);
  return { ok: true, toNode, statusName: toNode.statusName, statusId, nextTransitions, autoResolved };
}

/**
 * Directly place a workspace on a node (NOT validated against edges) and record
 * the transition. Used by the parallel fork/join orchestrator, where movement is
 * structural (fork → child entry, all-children-joined → join) rather than via a
 * single edge. When `syncIssue` is true, the issue's currentNode + derived status
 * are updated too (used for the parent path, never for fork children).
 */
export async function placeWorkspaceOnNode(
  db: WorkflowDb,
  opts: {
    workspaceId: string;
    issueId: string;
    projectId: string;
    fromNodeId: string | null;
    toNode: WorkflowNodeRow;
    summary?: string;
    triggeredBy?: string;
    syncIssue: boolean;
  },
): Promise<void> {
  const { workspaceId, issueId, projectId, fromNodeId, toNode, summary, triggeredBy = "system", syncIssue } = opts;
  const now = new Date().toISOString();

  await db.insert(schema.workflowTransitions).values({
    id: crypto.randomUUID(),
    workspaceId,
    fromNodeId,
    toNodeId: toNode.id,
    summary: summary ?? null,
    triggeredBy,
    createdAt: now,
  });

  await db
    .update(schema.workspaces)
    .set({ currentNodeId: toNode.id, updatedAt: now })
    .where(eq(schema.workspaces.id, workspaceId));

  if (syncIssue) {
    const issueUpdate: Record<string, unknown> = { currentNodeId: toNode.id, updatedAt: now };
    if (toNode.statusName) {
      const statusId = await resolveStatusId(db, projectId, toNode.statusName);
      if (statusId) {
        issueUpdate.statusId = statusId;
        issueUpdate.statusChangedAt = now;
      }
    }
    await db.update(schema.issues).set(issueUpdate).where(eq(schema.issues.id, issueId));
  }
}
