import { workers, sessions, workspaces, issues } from "@agentic-kanban/shared/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type WorkerRow = typeof workers.$inferSelect;
export type NewWorkerRow = typeof workers.$inferInsert;

export async function insertWorker(row: NewWorkerRow, database: Database = db): Promise<void> {
  await database.insert(workers).values(row);
}

export async function getWorkerById(id: string, database: Database = db): Promise<WorkerRow | null> {
  const rows = await database.select().from(workers).where(eq(workers.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listWorkers(database: Database = db): Promise<WorkerRow[]> {
  return database.select().from(workers).orderBy(workers.name);
}

export async function updateWorkerHeartbeat(
  id: string,
  at: string,
  status: string | undefined,
  database: Database = db,
): Promise<void> {
  await database.update(workers)
    .set({ lastHeartbeatAt: at, updatedAt: at, ...(status ? { status } : {}) })
    .where(eq(workers.id, id));
}

export async function updateWorkerStatus(
  id: string,
  status: string,
  at: string,
  database: Database = db,
): Promise<void> {
  await database.update(workers).set({ status, updatedAt: at }).where(eq(workers.id, id));
}

export async function deleteWorker(id: string, database: Database = db): Promise<void> {
  await database.delete(workers).where(eq(workers.id, id));
}

/**
 * The branches a project actually DISPATCHED to a fleet worker — the persisted
 * assignment record (`sessions.workerId` + the workspace's branch) that survives
 * a board restart. The incoming-ref sweep uses it to land only refs it asked a
 * worker to produce (#246): an incoming ref with no such assignment is held and
 * reported, never fast-forwarded onto `refs/heads/*`.
 */
export async function listWorkerAssignedBranches(
  projectId: string,
  database: Database = db,
): Promise<Set<string>> {
  const rows = await database
    .select({ branch: workspaces.branch })
    .from(sessions)
    .innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
    .innerJoin(issues, eq(issues.id, workspaces.issueId))
    .where(and(eq(issues.projectId, projectId), isNotNull(sessions.workerId)));
  return new Set(rows.map((r) => r.branch));
}

/**
 * How long after a fleet session ENDS its result is still landable/pushable (#753).
 *
 * The board learns a remote session is over from the worker's own `exit` event, which the
 * worker sends only AFTER its push completed — so in the normal case the push happens while
 * the session is still `running` and this window is never used. It exists for the two real
 * races: a push that is in flight when the stale-session sweep finalizes the row at board
 * startup, and a retry after a transient push failure. An hour covers both by a wide margin
 * and is still nothing like the 24h a token used to be good for on its own.
 */
export const WORKER_RESULT_LANDABLE_AFTER_END_MS = 60 * 60 * 1000;

/** One fleet dispatch: which worker, which branch, and whether it is still live. */
export interface WorkerBranchAssignment {
  sessionId: string;
  workerId: string;
  branch: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

/**
 * Every fleet dispatch for a project, newest-started first, with the liveness fields
 * a caller needs to decide whether the assignment is still CURRENT (#753).
 *
 * The looser {@link listWorkerAssignedBranches} answers "was this branch ever dispatched",
 * which is the right question for a human-facing inventory and for an operator's deliberate
 * land. It is the wrong question for anything automatic — see
 * {@link isWorkerAssignmentCurrent}.
 */
export async function listWorkerBranchAssignments(
  projectId: string,
  database: Database = db,
): Promise<WorkerBranchAssignment[]> {
  const rows = await database
    .select({
      sessionId: sessions.id,
      workerId: sessions.workerId,
      branch: workspaces.branch,
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
    })
    .from(sessions)
    .innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
    .innerJoin(issues, eq(issues.id, workspaces.issueId))
    .where(and(eq(issues.projectId, projectId), isNotNull(sessions.workerId)));
  return rows
    .map((r) => ({ ...r, workerId: r.workerId! }))
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

/**
 * Is a dispatch still current — running, or ended recently enough that its result is
 * still expected?
 *
 * This is the predicate that bounds a worker's authority in time (#753). Before it, the
 * only bound was the git token's own 24h TTL and `revokeWorker`: nothing at all happened
 * when a session ENDED, so a token holder could clone the project and force-push a
 * descendant of `master` to the branch's incoming ref long after review and merge were
 * finished, and (because the sweep matched "any session ever stamped with a workerId for
 * this branch") have it fast-forwarded on the next board restart.
 */
export function isWorkerAssignmentCurrent(
  assignment: Pick<WorkerBranchAssignment, "status" | "endedAt">,
  nowMs: number = Date.now(),
): boolean {
  if (assignment.status === "running") return true;
  if (!assignment.endedAt) return false;
  const endedMs = new Date(assignment.endedAt).getTime();
  if (!Number.isFinite(endedMs)) return false;
  return nowMs - endedMs <= WORKER_RESULT_LANDABLE_AFTER_END_MS;
}

/**
 * The branches an AUTOMATIC pass may land, i.e. those whose newest fleet dispatch is
 * still current (#753). Deliberately narrower than {@link listWorkerAssignedBranches}:
 * a ref that fails this is HELD and reported, and `POST /api/workers/incoming/land`
 * still lets an operator land it deliberately.
 *
 * "Newest dispatch" and not "any dispatch": a branch name is recycled (`ak-<N>` after a
 * merge), so an old ended session for the same name must not vouch for a ref pushed today
 * — and equally, a fresh dispatch on a recycled name must not be vetoed by its predecessor.
 */
export async function listLandableWorkerBranches(
  projectId: string,
  database: Database = db,
  opts: { nowMs?: number } = {},
): Promise<Set<string>> {
  const nowMs = opts.nowMs ?? Date.now();
  const newestPerBranch = new Map<string, WorkerBranchAssignment>();
  for (const assignment of await listWorkerBranchAssignments(projectId, database)) {
    // Sorted newest-first, so the first hit for a branch is its newest dispatch.
    if (!newestPerBranch.has(assignment.branch)) newestPerBranch.set(assignment.branch, assignment);
  }
  const landable = new Set<string>();
  for (const [branch, assignment] of newestPerBranch) {
    if (isWorkerAssignmentCurrent(assignment, nowMs)) landable.add(branch);
  }
  return landable;
}

/**
 * The current dispatch of ONE branch to ONE worker, or null (#753).
 *
 * This is what the git transport asks on every request: a per-assignment token is only
 * as good as the assignment behind it, so authority is re-derived from the DB per request
 * rather than frozen at issue time.
 */
export async function findCurrentWorkerAssignment(
  params: { projectId: string; workerId: string; branch: string; nowMs?: number },
  database: Database = db,
): Promise<WorkerBranchAssignment | null> {
  const assignments = await listWorkerBranchAssignments(params.projectId, database);
  const forBranch = assignments.filter((a) => a.branch === params.branch && a.workerId === params.workerId);
  if (forBranch.length === 0) return null;
  const nowMs = params.nowMs ?? Date.now();
  // Any current one vouches: a relaunch of the same branch on the same worker legitimately
  // leaves an older ended row behind, and the newest row is not necessarily the running one
  // when two sessions overlap during a handover.
  return forBranch.find((a) => isWorkerAssignmentCurrent(a, nowMs)) ?? null;
}

/**
 * Is this session still live on this worker, from the DB's point of view?
 *
 * Delegates to the `sessions`-owning repository (#957) rather than re-querying the table
 * here — same rule the worker-id write below follows. Re-exported so the fleet callers keep
 * a single worker-shaped import.
 */
export { getSessionLiveness } from "./session/lifecycle.js";

/**
 * Stamp which fleet worker a session runs on (mirrors sessions.containerId).
 *
 * Delegates to the `sessions`-owning repository (#957) instead of writing the table
 * here — same rule `updateSessionContainerId` already follows. Re-exported from this
 * module so fleet callers keep importing it from the worker repository.
 */
export { updateSessionWorkerId } from "./session.repository.js";
