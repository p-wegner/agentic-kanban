import { eq } from "drizzle-orm";
import { workspaceMergeGate } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

/**
 * The one owner of pre-merge-gate EVIDENCE persistence, over its own table (#815).
 *
 * The five `merge_gate_*` columns used to sit on `workspaces`. Re-derived on the column names
 * AND the camelCase fields, only four non-test files named them: the schema, the writer
 * (`startup/exit-workflow.ts`), the clear (`startup/exit/fix-and-merge-exit.ts`) and the
 * monitor's candidate SELECT (`startup/monitor-setup.ts`), which aliases the new columns back
 * to `mergeGateRanAt` & co. so `startup/monitor-cycle.ts` — reading them off the projected ROW
 * — never sees the move.
 *
 * An ABSENT row means "no trustworthy evidence", exactly as five NULL columns did:
 * `resolveMergeGate` re-runs the gate when the evidence is missing. So `clearMergeGate` is a
 * DELETE, and any read must LEFT JOIN from `workspaces` rather than select from this table
 * alone — otherwise every never-gated workspace disappears from the monitor's candidate walk
 * and no first merge ever happens.
 */

/** The evidence as `armReadyForMerge` writes it. */
export interface MergeGateEvidenceValues {
  ranAt: string | null;
  stage: string | null;
  source: string | null;
  branchSha: string | null;
  baseSha: string | null;
  /**
   * `gateVerificationKey(strategy, verifyCommand)` for the run that produced this proof (#893).
   * Optional so writers that never resolved one (review-exit before it learns to) stay
   * source-compatible — but see the normalization in {@link setMergeGateEvidence}: an omitted
   * key is WRITTEN as null, never left as the previous row's value.
   */
  verificationKey?: string | null;
}

/**
 * Persist the gate proof for a workspace, replacing whatever was there.
 *
 * Upsert rather than insert: a workspace can be re-gated (a fix-and-merge round, a re-review),
 * and the proof is a LATEST-value record, which is what the five columns were.
 */
export async function setMergeGateEvidence(
  workspaceId: string,
  values: MergeGateEvidenceValues,
  database: Database | TransactionClient = db,
): Promise<void> {
  // Normalize the optional field: an upsert whose SET omits `verification_key` would keep the
  // PREVIOUS run's key beside this run's tips — a proof asserting a tier it never ran under.
  // Every write therefore overwrites the whole row.
  const row = { ...values, verificationKey: values.verificationKey ?? null };
  await database.insert(workspaceMergeGate).values({ workspaceId, ...row })
    .onConflictDoUpdate({ target: workspaceMergeGate.workspaceId, set: { ...row } });
}

/**
 * Drop the proof. Deleting the row IS the cleared state — the reads reconstruct five nulls
 * from a missing row, which is exactly what the columns held after a clear.
 */
export async function clearMergeGateEvidence(
  workspaceId: string,
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.delete(workspaceMergeGate).where(eq(workspaceMergeGate.workspaceId, workspaceId));
}

/** The evidence for one workspace, or `undefined` when the gate has never run on it. */
export async function getMergeGateEvidence(
  workspaceId: string,
  database: Database = db,
): Promise<typeof workspaceMergeGate.$inferSelect | undefined> {
  const [row] = await database.select().from(workspaceMergeGate)
    .where(eq(workspaceMergeGate.workspaceId, workspaceId)).limit(1);
  return row;
}
