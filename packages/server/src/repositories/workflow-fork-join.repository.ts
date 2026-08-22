/**
 * JOIN / CONVERGENCE / CANCEL — how a fork ENDS.
 *
 * Split out of `workflow-fork.repository.ts` (#722, shrink-only cohesion baseline). Where
 * the children module owns a child's existence, this one owns its convergence: the node
 * context the join reconciler compares (`currentNodeId` vs `forkJoinNodeId`), the two
 * terminal status flips (joined / cancelled), and the parent+issue+children reads the
 * consolidate step needs to summarise the fork back onto the parent.
 *
 * `selectConsolidateIssue` reads `issues` here rather than from the launch-context module
 * on purpose: it is the consolidate step's own projection (it carries `workflowTemplateId`
 * for the join-node lookup) and it is read at JOIN time, not at fork time.
 */
import { and, eq } from "drizzle-orm";
import { issues, workspaces } from "@agentic-kanban/shared/schema";
import { setWorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function selectChildJoinContext(childWorkspaceId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id, parentWorkspaceId: workspaces.parentWorkspaceId, forkNodeId: workspaces.forkNodeId, forkJoinNodeId: workspaces.forkJoinNodeId })
    .from(workspaces)
    .where(eq(workspaces.id, childWorkspaceId))
    .limit(1);
}

export async function updateChildWorkspaceJoined(
  childWorkspaceId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await setWorkspaceStatus(database, childWorkspaceId, "closed", {
    now,
    set: { forkStatus: "joined", closedAt: now },
  });
}

export async function updateChildWorkspaceCancelled(
  childWorkspaceId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await setWorkspaceStatus(database, childWorkspaceId, "closed", {
    now,
    set: { forkStatus: "cancelled", closedAt: now },
  });
}

export async function selectCancelOverdueChild(childWorkspaceId: string, database: Database = db) {
  return database.select({ forkStatus: workspaces.forkStatus, parentWorkspaceId: workspaces.parentWorkspaceId, forkNodeId: workspaces.forkNodeId, forkJoinNodeId: workspaces.forkJoinNodeId, currentNodeId: workspaces.currentNodeId }).from(workspaces).where(eq(workspaces.id, childWorkspaceId)).limit(1);
}

/**
 * Fork-child context for the post-session-exit join reconciler (#1000): does this
 * workspace belong to a fork (has a parent) and, if so, is it already sitting on
 * its recorded `forkJoinNodeId` (the agent successfully called propose_transition
 * before its session exited) even though `forkStatus` was never flipped to
 * "joined" — the fire-and-forget cross-process notify that normally does that
 * (`notifyWorkflowAdvanced`) has no delivery guarantee and can be lost/raced by a
 * concurrent session-exit status write (e.g. usage-limit -> blocked).
 */
export async function selectForkChildNodeContext(childWorkspaceId: string, database: Database = db) {
  return database
    .select({
      id: workspaces.id,
      currentNodeId: workspaces.currentNodeId,
      parentWorkspaceId: workspaces.parentWorkspaceId,
      forkNodeId: workspaces.forkNodeId,
      forkJoinNodeId: workspaces.forkJoinNodeId,
      forkStatus: workspaces.forkStatus,
    })
    .from(workspaces)
    .where(eq(workspaces.id, childWorkspaceId))
    .limit(1);
}

export async function selectWorkspaceNodeContext(workspaceId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id, currentNodeId: workspaces.currentNodeId, parentWorkspaceId: workspaces.parentWorkspaceId, forkStatus: workspaces.forkStatus })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}

export async function selectConsolidateParent(parentWorkspaceId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id, issueId: workspaces.issueId, branch: workspaces.branch, workingDir: workspaces.workingDir, currentNodeId: workspaces.currentNodeId })
    .from(workspaces).where(eq(workspaces.id, parentWorkspaceId)).limit(1);
}

export async function selectConsolidateIssue(issueId: string, database: Database = db) {
  return database.select({ issueNumber: issues.issueNumber, title: issues.title, description: issues.description, projectId: issues.projectId, workflowTemplateId: issues.workflowTemplateId }).from(issues).where(eq(issues.id, issueId)).limit(1);
}

export async function selectForkChildrenForConsolidate(parentId: string, database: Database = db, forkNodeId?: string) {
  return database
    .select({ id: workspaces.id, branch: workspaces.branch, workingDir: workspaces.workingDir, forkStatus: workspaces.forkStatus, forkNodeId: workspaces.forkNodeId })
    .from(workspaces)
    .where(and(
      eq(workspaces.parentWorkspaceId, parentId),
      ...(forkNodeId ? [eq(workspaces.forkNodeId, forkNodeId)] : []),
    ));
}
