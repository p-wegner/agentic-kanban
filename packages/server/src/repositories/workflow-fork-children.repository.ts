/**
 * Fork-CHILD ROW LIFECYCLE — the `workspaces` rows a fork node creates and owns.
 *
 * Split out of `workflow-fork.repository.ts` (#722): that file had grown to 34 top-level
 * declarations, past its shrink-only cohesion baseline of 33. This half is the write
 * authority for a child's existence — queue it, launch it, mark it failed, delete it —
 * plus the roster reads that count/limit concurrent children. It touches exactly one
 * table (`workspaces`) and never reaches into `sessions`, `issues` or `projects`; the
 * cross-aggregate reads live in the sibling modules.
 */
import { and, eq, inArray } from "drizzle-orm";
import { issues, workspaces } from "@agentic-kanban/shared/schema";
import { setWorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * A child workspace row's identity fields: does it exist, and what branch does it already NAME?
 *
 * `branch` is here rather than in a second accessor (#682, and the #889 cohesion ceiling): a
 * queued child persists its branch at queue time and is launched later, possibly after an upgrade
 * that changed how the name is derived — re-deriving at launch then produces a worktree on one
 * branch while the row says another. The launch path reads this instead of recomputing.
 */
export async function selectWorkspaceIdById(childWorkspaceId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id, branch: workspaces.branch })
    .from(workspaces)
    .where(eq(workspaces.id, childWorkspaceId))
    .limit(1);
}

export async function updateChildWorkspaceFailed(
  childWorkspaceId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await setWorkspaceStatus(database, childWorkspaceId, "closed", {
    now,
    set: { forkStatus: "failed", closedAt: now },
  });
}

export async function insertFailedChildWorkspace(
  insertValues: {
    id: string;
    issueId: string;
    branch: string;
    status: string;
    currentNodeId: string;
    parentWorkspaceId: string;
    forkNodeId: string;
    forkJoinNodeId: string;
    forkStatus: string;
    closedAt: string;
    updatedAt: string;
  },
  now: string,
  database: Database = db,
): Promise<void> {
  await database.insert(workspaces).values({ ...insertValues, createdAt: now });
}

export async function insertLaunchedChildWorkspace(
  values: {
    id: string;
    issueId: string;
    branch: string;
    workingDir: string;
    baseBranch: string;
    status: string;
    provider: string;
    claudeProfile: string | null;
    agentCommand: string | null;
    model: string | null;
    skillId: string | null;
    currentNodeId: string;
    parentWorkspaceId: string;
    forkNodeId: string;
    forkJoinNodeId: string;
    forkStatus: string;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(workspaces).values(values);
}

export async function insertQueuedChildWorkspace(
  values: {
    id: string;
    issueId: string;
    branch: string;
    status: string;
    currentNodeId: string;
    parentWorkspaceId: string;
    forkNodeId: string;
    forkJoinNodeId: string;
    forkStatus: string;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(workspaces).values(values);
}

export async function selectProjectRunningForkWorkspaces(projectId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(eq(issues.projectId, projectId), eq(workspaces.forkStatus, "running")));
}

export async function selectExistingForkChildren(
  parentId: string,
  forkNodeId: string,
  database: Database = db,
) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.parentWorkspaceId, parentId), eq(workspaces.forkNodeId, forkNodeId)));
}

export async function selectPendingForkChildren(parentId: string, database: Database = db, forkNodeId?: string) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(
      eq(workspaces.parentWorkspaceId, parentId),
      inArray(workspaces.forkStatus, ["running", "queued"]),
      ...(forkNodeId ? [eq(workspaces.forkNodeId, forkNodeId)] : []),
    ));
}

export async function selectRunningForkChildren(parentId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.parentWorkspaceId, parentId), eq(workspaces.forkStatus, "running")));
}

export async function selectQueuedForkChildren(parentId: string, database: Database = db) {
  return database
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.parentWorkspaceId, parentId), eq(workspaces.forkStatus, "queued")));
}

export async function deleteWorkspaceById(workspaceId: string, database: Database = db): Promise<void> {
  await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
}
