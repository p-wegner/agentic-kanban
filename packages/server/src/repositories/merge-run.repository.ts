import { eq } from "drizzle-orm";
import { workspaceMergeRun } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

/**
 * The one owner of the durable "a merge is in flight" marker (#945) — see
 * `shared/src/schema/workspace-merge-run.ts` for why it exists at all.
 *
 * An ABSENT row means "no merge is in flight", so {@link clearMergeRun} is a DELETE and every
 * write path must clear on BOTH terminal outcomes. A row that outlives its process is the
 * signal `startup/merge-run-reconciler.ts` reads.
 */

export type MergeRunRow = typeof workspaceMergeRun.$inferSelect;

export interface MergeRunValues {
  jobId: string;
  startedAt: string;
  source?: string | null;
  pid?: string | null;
}

/**
 * Mark a merge as in flight for this workspace, replacing any previous marker.
 *
 * Upsert rather than insert: a workspace is merged more than once over its life (a retry after
 * a conflict, a fix-and-merge round), and a stale marker left by an earlier dead process must
 * be overwritten by the live attempt rather than colliding with it.
 */
export async function setMergeRun(
  workspaceId: string,
  values: MergeRunValues,
  database: Database | TransactionClient = db,
): Promise<void> {
  const row = { ...values, source: values.source ?? null, pid: values.pid ?? null };
  await database.insert(workspaceMergeRun).values({ workspaceId, ...row })
    .onConflictDoUpdate({ target: workspaceMergeRun.workspaceId, set: { ...row } });
}

/**
 * Drop the marker. Deleting the row IS "no merge in flight" — there is no terminal state to
 * record here, because the terminal state of a merge lives where it always has (the merge job,
 * `workspaces.mergedAt`, the `merge-attempt` timeline note).
 */
export async function clearMergeRun(
  workspaceId: string,
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.delete(workspaceMergeRun).where(eq(workspaceMergeRun.workspaceId, workspaceId));
}

/** The marker for one workspace, or `undefined` when no merge is in flight. */
export async function getMergeRun(
  workspaceId: string,
  database: Database = db,
): Promise<MergeRunRow | undefined> {
  const [row] = await database.select().from(workspaceMergeRun)
    .where(eq(workspaceMergeRun.workspaceId, workspaceId)).limit(1);
  return row;
}

/** Every in-flight marker. At boot these are, by construction, orphans (#945). */
export async function listMergeRuns(database: Database = db): Promise<MergeRunRow[]> {
  return database.select().from(workspaceMergeRun);
}
