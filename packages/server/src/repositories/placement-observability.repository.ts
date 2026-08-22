// Queries behind "where did #N actually run, and why did it not go remote" (#755).
//
// The policy — the ordered decision chain and how it is explained — lives in
// `services/placement-explain.service.ts`. Only the reads live here, so the service
// stays a policy module and `lint:arch`'s `services-bypass-repositories` rule holds.
import { and, desc, eq, inArray } from "drizzle-orm";
import { issues, sessions, workers, workspaces } from "@agentic-kanban/shared/schema";

import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export interface SessionPlacementRow {
  sessionId: string;
  workspaceId: string;
  branch: string | null;
  issueNumber: number | null;
  issueTitle: string | null;
  status: string;
  executor: string;
  startedAt: string;
  endedAt: string | null;
  workerId: string | null;
}

export interface SessionPlacementQuery {
  projectId?: string;
  workspaceId?: string;
  issueId?: string;
  workerId?: string;
  limit?: number;
}

/**
 * Sessions with the machine each one ran on, newest first. A cross-aggregate JOIN
 * read: the workspace/issue identity is what makes a `worker_id` legible to an
 * operator, and fetching it separately would be three round trips for one row set.
 */
export async function listSessionPlacementRows(
  query: SessionPlacementQuery = {},
  database: Database = db,
): Promise<SessionPlacementRow[]> {
  const conditions = [
    query.workspaceId ? eq(sessions.workspaceId, query.workspaceId) : undefined,
    query.issueId ? eq(workspaces.issueId, query.issueId) : undefined,
    query.projectId ? eq(issues.projectId, query.projectId) : undefined,
    query.workerId ? eq(sessions.workerId, query.workerId) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const rows = await database
    .select({
      sessionId: sessions.id,
      workspaceId: sessions.workspaceId,
      branch: workspaces.branch,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      status: sessions.status,
      executor: sessions.executor,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      workerId: sessions.workerId,
    })
    .from(sessions)
    .leftJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .leftJoin(issues, eq(workspaces.issueId, issues.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(sessions.startedAt))
    .limit(query.limit ?? 50);
  return rows;
}

/**
 * id → name for the workers a session set references. Missing ids are simply
 * absent from the map: a revoked worker leaves its id on the session forever, and
 * "ran on a worker that no longer exists" must stay distinguishable from "ran on
 * the host" (that ambiguity is what made #699 unreconstructable).
 */
export async function getWorkerNamesByIds(
  ids: Array<string | null | undefined>,
  database: Database = db,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = await database
    .select({ id: workers.id, name: workers.name })
    .from(workers)
    .where(inArray(workers.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export interface IssueIdentity {
  id: string;
  issueNumber: number;
  title: string;
  projectId: string;
}

/** Issue identity by per-project number, or null. Rows with no number are not addressable by number. */
export async function getIssueIdentityByNumber(
  projectId: string,
  issueNumber: number,
  database: Database = db,
): Promise<IssueIdentity | null> {
  const rows = await database
    .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, projectId: issues.projectId })
    .from(issues)
    .where(and(eq(issues.issueNumber, issueNumber), eq(issues.projectId, projectId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.issueNumber === null) return null;
  return { ...row, issueNumber: row.issueNumber };
}

export interface IssueBranchInfo {
  branch: string;
  baseBranch: string | null;
  isDirect: boolean;
}

/** The issue's newest workspace — its branch is what the git-transport check turns on. */
export async function getLatestWorkspaceBranchForIssue(
  issueId: string,
  database: Database = db,
): Promise<IssueBranchInfo | null> {
  const rows = await database
    .select({ branch: workspaces.branch, baseBranch: workspaces.baseBranch, isDirect: workspaces.isDirect })
    .from(workspaces)
    .where(eq(workspaces.issueId, issueId))
    .orderBy(desc(workspaces.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
