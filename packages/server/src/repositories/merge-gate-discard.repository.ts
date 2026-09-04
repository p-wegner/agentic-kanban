import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { mergeGateDiscards } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

/**
 * The one owner of the discarded-gate-verdict ledger (#1030) — see
 * `shared/src/schema/merge-gate-discards.ts` for why the table exists.
 *
 * Append-only: a discard is a historical fact about one gate run, never a latest-value record,
 * so there is no upsert and no clear. Nothing on the merge path READS it; it is written by
 * `runGateWithEvidence`'s discard branch and read back by `merge-status` and by a human asking
 * "how often, and on what, does #243 throw a pass away?".
 */

export type MergeGateDiscardRow = typeof mergeGateDiscards.$inferSelect;

export interface MergeGateDiscardValues {
  workspaceId: string;
  discardedAt: string;
  source: string;
  stage?: string | null;
  durationMs?: number | null;
  jobId?: string | null;
  attempt?: number | null;
  moved: "branch" | "base";
  branchShaBefore?: string | null;
  branchShaAfter?: string | null;
  baseShaBefore?: string | null;
  baseShaAfter?: string | null;
  /** Already-serialised JSON array of paths, or null when the base did not move / could not be diffed. */
  baseMoveFiles?: string | null;
  /** Already-serialised JSON of the run's `GateImpactSelection`, or null. */
  impactSelection?: string | null;
}

/** Append one discard. Returns the new row's id. */
export async function recordMergeGateDiscard(
  values: MergeGateDiscardValues,
  database: Database | TransactionClient = db,
  id: string = randomUUID(),
): Promise<string> {
  await database.insert(mergeGateDiscards).values({
    id,
    workspaceId: values.workspaceId,
    discardedAt: values.discardedAt,
    source: values.source,
    stage: values.stage ?? null,
    durationMs: values.durationMs ?? null,
    jobId: values.jobId ?? null,
    attempt: values.attempt ?? null,
    moved: values.moved,
    branchShaBefore: values.branchShaBefore ?? null,
    branchShaAfter: values.branchShaAfter ?? null,
    baseShaBefore: values.baseShaBefore ?? null,
    baseShaAfter: values.baseShaAfter ?? null,
    baseMoveFiles: values.baseMoveFiles ?? null,
    impactSelection: values.impactSelection ?? null,
  });
  return id;
}

/** Every discard for a workspace, newest first. */
export async function listMergeGateDiscards(
  workspaceId: string,
  database: Database = db,
): Promise<MergeGateDiscardRow[]> {
  return database.select().from(mergeGateDiscards)
    .where(eq(mergeGateDiscards.workspaceId, workspaceId))
    .orderBy(desc(mergeGateDiscards.discardedAt));
}
