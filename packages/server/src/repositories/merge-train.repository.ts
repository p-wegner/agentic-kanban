import { and, desc, eq, inArray, like } from "drizzle-orm";
import { issues, mergeTrains, workspaces, type MergeTrainState } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * The one owner of `merge_trains` persistence (#906) — the DB record for a release train,
 * replacing the pure per-request scratch state `merge-queue.service.ts` used to hold only in
 * an async generator's closure. See the schema module (`shared/src/schema/merge-trains.ts`)
 * for why the row exists.
 */

/**
 * The one sanctioned way for a caller outside the `db`/`repositories` layer (the CLI, which
 * `cli-not-down-to-persistence` forbids from importing `db/index.js` directly) to get the
 * default database connection for a repository/service call that requires one.
 */
export function getDefaultDatabase(): Database {
  return db;
}

export interface CreateMergeTrainInput {
  id: string;
  projectId: string;
  label: string;
  memberWorkspaceIds: string[];
}

/** Insert the row at assembly start — BEFORE any git/gate work, so a crash mid-assembly is still visible. */
export async function createMergeTrain(
  input: CreateMergeTrainInput,
  database: Database = db,
): Promise<void> {
  await database.insert(mergeTrains).values({
    id: input.id,
    projectId: input.projectId,
    label: input.label,
    memberWorkspaceIds: JSON.stringify(input.memberWorkspaceIds),
    state: "assembling",
  });
}

export interface UpdateMergeTrainStateInput {
  state: MergeTrainState;
  gateEvidence?: Record<string, unknown> | null;
  bisectResult?: Record<string, unknown> | null;
  reconciledReason?: string | null;
  finishedAt?: string | null;
  /**
   * #1203 — restrict this write to rows CURRENTLY in one of these states, so a write that
   * merely reports IN-PROGRESS work (the gate's own `state: "gating"` stamp on every attempt)
   * can never clobber a TERMINAL state an operator or reconciler already wrote. Without this,
   * `updateMergeTrainState(id, { state: "gating" })` was an unconditional overwrite, so an
   * operator's cancel (`abandoned`) racing a bisect's next attempt was resolved by whichever
   * write landed LAST rather than by the operator's intent always winning (#1153's actual gap:
   * marking the row was correct, but nothing stopped the next attempt from re-marking it live).
   * Omitted (every other caller) keeps today's unconditional write.
   */
  guardStates?: MergeTrainState[];
}

/**
 * Advance a train's state, optionally attaching evidence/bisect data or a finish stamp.
 *
 * Returns whether the row was actually written — always `true` when `guardStates` is omitted
 * (an unconditional write either finds the row or is a no-op on a deleted id, matching today's
 * behaviour byte for byte), and `false` when `guardStates` was supplied and the row's CURRENT
 * state was not in that set — i.e. the guard refused the write.
 */
export async function updateMergeTrainState(
  id: string,
  input: UpdateMergeTrainStateInput,
  database: Database = db,
): Promise<boolean> {
  const set: Partial<typeof mergeTrains.$inferInsert> = { state: input.state };
  if (input.gateEvidence !== undefined) set.gateEvidence = input.gateEvidence == null ? null : JSON.stringify(input.gateEvidence);
  if (input.bisectResult !== undefined) set.bisectResult = input.bisectResult == null ? null : JSON.stringify(input.bisectResult);
  if (input.reconciledReason !== undefined) set.reconciledReason = input.reconciledReason;
  if (input.finishedAt !== undefined) set.finishedAt = input.finishedAt;
  const where = input.guardStates && input.guardStates.length > 0
    ? and(eq(mergeTrains.id, id), inArray(mergeTrains.state, input.guardStates))
    : eq(mergeTrains.id, id);
  const result = await database.update(mergeTrains).set(set).where(where);
  // #1203: the driver's row-count field name differs (`rowsAffected` vs `changes`, see
  // `cleanupExpiredRuntimeState`'s same fallback) — a guard that matched no row (state already
  // moved on) must be visible to the caller as "not applied", not as success.
  const rowsAffected = (result as { rowsAffected?: number; changes?: number }).rowsAffected
    ?? (result as { changes?: number }).changes
    ?? 0;
  return input.guardStates ? rowsAffected !== 0 : true;
}

export type MergeTrainRow = typeof mergeTrains.$inferSelect;

/**
 * Append one bisect-tree node to a LIVE train's `gateEvidence.attempts` (#1189), as the
 * attempt finishes. Touches ONLY the `gateEvidence` column: the row's `state` is owned by the
 * gate (`gating`) and by the operator/reconciler (`abandoned`), and a write that also set the
 * state would race an operator's cancel back to a live state — the #1153 failure again. No
 * migration: the list rides inside the existing JSON column; `finishMergeTrain` rewrites the
 * whole evidence at the end with the complete list from the run result, so nothing here needs
 * to be authoritative beyond "what has finished so far".
 *
 * A row that no longer exists is a no-op, and unparseable prior evidence is replaced rather
 * than thrown on — this is progress reporting, never the source of truth for the outcome.
 */
export async function appendMergeTrainAttempt(
  id: string,
  attempt: Record<string, unknown>,
  database: Database = db,
): Promise<void> {
  const row = await getMergeTrain(id, database);
  if (!row) return;
  let evidence: Record<string, unknown> = {};
  if (row.gateEvidence) {
    try {
      const parsed: unknown = JSON.parse(row.gateEvidence);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) evidence = parsed as Record<string, unknown>;
    } catch {
      evidence = {};
    }
  }
  const prior = Array.isArray(evidence.attempts) ? (evidence.attempts as unknown[]) : [];
  await database
    .update(mergeTrains)
    .set({ gateEvidence: JSON.stringify({ ...evidence, attempts: [...prior, attempt] }) })
    .where(eq(mergeTrains.id, id));
}

/** One train by id, or undefined. */
export async function getMergeTrain(id: string, database: Database = db): Promise<MergeTrainRow | undefined> {
  const [row] = await database.select().from(mergeTrains).where(eq(mergeTrains.id, id)).limit(1);
  return row;
}

/** History for a project, newest first — the `GET /api/merge-trains` listing. */
export async function listMergeTrainsForProject(
  projectId: string,
  database: Database = db,
): Promise<MergeTrainRow[]> {
  return database
    .select()
    .from(mergeTrains)
    .where(eq(mergeTrains.projectId, projectId))
    .orderBy(desc(mergeTrains.startedAt));
}

/** Rows in the given states, across all projects — what the startup reconciler sweeps. */
export async function listMergeTrainsInStates(
  states: MergeTrainState[],
  database: Database = db,
): Promise<MergeTrainRow[]> {
  return database.select().from(mergeTrains).where(inArray(mergeTrains.state, states));
}

/** Rows in a state for a specific project — used to find the live/in-flight train, if any. */
export async function listActiveMergeTrainsForProject(
  projectId: string,
  states: MergeTrainState[],
  database: Database = db,
): Promise<MergeTrainRow[]> {
  return database
    .select()
    .from(mergeTrains)
    .where(and(eq(mergeTrains.projectId, projectId), inArray(mergeTrains.state, states)));
}

/**
 * #1190 — how many trains this project has already started TODAY (`dateStamp` = `YYYY-MM-DD`,
 * the caller's clock), so the caller can mint the next `train/<dateStamp>-NN` label. Counts
 * rows whose label carries today's date stamp regardless of state, so a resumed/abandoned row
 * still reserves its sequence number — two live trains for one project never happens (see
 * `beginMergeTrain`'s in-flight refusal), but a same-day retry after an abandon must not reuse
 * a label that a stranded row (and its now-orphaned but possibly still-lingering
 * `kanban/train/<label>` ref) already claimed.
 */
export async function countTrainsForProjectOnDate(
  projectId: string,
  dateStamp: string,
  database: Database = db,
): Promise<number> {
  const rows = await database
    .select({ label: mergeTrains.label })
    .from(mergeTrains)
    .where(and(eq(mergeTrains.projectId, projectId), like(mergeTrains.label, `train/${dateStamp}-%`)));
  return rows.length;
}

/**
 * The trains a set of workspaces are aboard or were most recently a member of (#1188) — the
 * per-workspace lookup the card's "boarding pass" chip needs. Membership is JSON text, not
 * queryable in SQL (same limitation as `findActiveMergeTrainForMembers`), so this reads a
 * bounded recent slice per project and matches in memory.
 *
 * Returns at most ONE train per workspace id: an active (`assembling`/`gating`/`landing`) train
 * wins over a terminal one, and among terminal trains the most recently finished wins — a
 * workspace does not appear twice even if it rode two trains in its history (it cannot be
 * aboard two at once, and only the LATEST outcome is what a card should show).
 */
export async function findRecentMergeTrainsForWorkspaces(
  projectId: string,
  workspaceIds: string[],
  database: Database = db,
): Promise<Map<string, MergeTrainRow>> {
  const wanted = new Set(workspaceIds);
  const result = new Map<string, MergeTrainRow>();
  if (wanted.size === 0) return result;

  // Newest first (see listMergeTrainsForProject) — bounded to a recent slice so a long-lived
  // project's full train history is never read just to paint today's cards. 50 trains is far
  // beyond how many a card would ever still care about (a terminal train's chip is a one-cycle
  // "just happened" courtesy, not a permanent record — the issue comment is that record).
  const recent = (await listMergeTrainsForProject(projectId, database)).slice(0, 50);

  for (const row of recent) {
    let members: string[];
    try {
      members = JSON.parse(row.memberWorkspaceIds) as string[];
    } catch {
      continue;
    }
    for (const workspaceId of members) {
      if (!wanted.has(workspaceId)) continue;
      const existing = result.get(workspaceId);
      if (!existing) {
        result.set(workspaceId, row);
        continue;
      }
      // Newest-first iteration means `existing` is already the most recent train seen for this
      // workspace; an active train still wins over an older one even if a still-more-recent
      // terminal train also named this workspace (a re-ride after a drop), since "aboard right
      // now" is the more useful fact for a live card.
      const existingActive = existing.state === "assembling" || existing.state === "gating" || existing.state === "landing";
      if (!existingActive && (row.state === "assembling" || row.state === "gating" || row.state === "landing")) {
        result.set(workspaceId, row);
      }
    }
  }

  return result;
}

/**
 * `(workspaceId -> issueNumber)` for a set of workspaces (#1188) — the co-member issue numbers
 * a "landed with #N #M" boarding-pass chip needs. A workspace absent from the DB (or whose
 * issue has no number) is simply absent from the returned map.
 */
export async function getIssueNumbersByWorkspaceIds(
  workspaceIds: string[],
  database: Database = db,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (workspaceIds.length === 0) return result;
  const rows = await database
    .select({ workspaceId: workspaces.id, issueNumber: issues.issueNumber })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(inArray(workspaces.id, workspaceIds));
  for (const r of rows) {
    if (r.issueNumber !== null) result.set(r.workspaceId, r.issueNumber);
  }
  return result;
}

/**
 * `(workspaceId -> projectId)` for a set of workspaces (#1188) — resolves the project a main
 * workspace belongs to, which `buildWorkspaceSummaryMap`'s issue-keyed summary map does not
 * carry, so the boarding-pass lookup (per-PROJECT, like every other train query) knows where
 * to look for each workspace.
 */
export async function getProjectIdsByWorkspaceIds(
  workspaceIds: string[],
  database: Database = db,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (workspaceIds.length === 0) return result;
  const rows = await database
    .select({ workspaceId: workspaces.id, projectId: issues.projectId })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(inArray(workspaces.id, workspaceIds));
  for (const r of rows) {
    if (r.projectId) result.set(r.workspaceId, r.projectId);
  }
  return result;
}

/**
 * Find an already-`assembling`/`gating` train for this EXACT member set (#1158) — so a caller
 * about to start a new attempt for a batch can join the existing row instead of minting a
 * duplicate one. Compared as a SET, not an ordered list: `computePlan`'s ordering is not a
 * membership fact, and treating it as one would defeat the dedup on the most common retry
 * shape (the same ids, reordered by a re-run classifier).
 *
 * Membership is stored as JSON text, not queryable in SQL, so this reads the project's active
 * rows (already state-filtered and therefore few) and compares in memory.
 */
export async function findActiveMergeTrainForMembers(
  projectId: string,
  memberWorkspaceIds: string[],
  database: Database = db,
): Promise<MergeTrainRow | undefined> {
  const wanted = new Set(memberWorkspaceIds);
  const active = await listActiveMergeTrainsForProject(projectId, ["assembling", "gating"], database);
  return active.find((row) => {
    let members: string[];
    try {
      members = JSON.parse(row.memberWorkspaceIds) as string[];
    } catch {
      return false;
    }
    return members.length === wanted.size && members.every((id) => wanted.has(id));
  });
}
