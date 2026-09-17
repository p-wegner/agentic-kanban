import { and, desc, eq, inArray, like } from "drizzle-orm";
import { mergeTrains, type MergeTrainState } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * The one owner of `merge_trains` persistence (#906) — the DB record for a release train,
 * replacing the pure per-request scratch state `merge-queue.service.ts` used to hold only in
 * an async generator's closure. See the schema module (`shared/src/schema/merge-trains.ts`)
 * for why the row exists.
 */

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
}

/** Advance a train's state, optionally attaching evidence/bisect data or a finish stamp. */
export async function updateMergeTrainState(
  id: string,
  input: UpdateMergeTrainStateInput,
  database: Database = db,
): Promise<void> {
  const set: Partial<typeof mergeTrains.$inferInsert> = { state: input.state };
  if (input.gateEvidence !== undefined) set.gateEvidence = input.gateEvidence == null ? null : JSON.stringify(input.gateEvidence);
  if (input.bisectResult !== undefined) set.bisectResult = input.bisectResult == null ? null : JSON.stringify(input.bisectResult);
  if (input.reconciledReason !== undefined) set.reconciledReason = input.reconciledReason;
  if (input.finishedAt !== undefined) set.finishedAt = input.finishedAt;
  await database.update(mergeTrains).set(set).where(eq(mergeTrains.id, id));
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
