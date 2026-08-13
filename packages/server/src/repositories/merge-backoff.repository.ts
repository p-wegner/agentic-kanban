import { eq } from "drizzle-orm";
import { workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** The backoff columns `shouldSkipMergeForBackoff` reads off a workspace row. */
export interface MergeBackoffRow {
  failures: number | null;
  signature: string | null;
  branchSha: string | null;
  verifyHash: string | null;
  nextRetryAt: string | null;
}

export async function getMergeBackoffState(
  workspaceId: string,
  database: Database = db,
): Promise<MergeBackoffRow | undefined> {
  const [row] = await database.select({
    failures: workspaces.mergeBackoffFailures,
    signature: workspaces.mergeBackoffSignature,
    branchSha: workspaces.mergeBackoffBranchSha,
    verifyHash: workspaces.mergeBackoffVerifyHash,
    nextRetryAt: workspaces.mergeBackoffNextRetryAt,
  }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return row;
}

/** The subset `recordMergeFailure` needs to decide whether a failure is a repeat. */
export async function getMergeBackoffSignatureState(
  workspaceId: string,
  database: Database = db,
): Promise<{ failures: number | null; signature: string | null; since: string | null } | undefined> {
  const [row] = await database.select({
    failures: workspaces.mergeBackoffFailures,
    signature: workspaces.mergeBackoffSignature,
    since: workspaces.mergeBackoffSince,
  }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return row;
}

export async function clearMergeBackoffState(workspaceId: string, database: Database = db): Promise<void> {
  await database.update(workspaces).set({
    mergeBackoffFailures: 0,
    mergeBackoffSignature: null,
    mergeBackoffError: null,
    mergeBackoffBranchSha: null,
    mergeBackoffVerifyHash: null,
    mergeBackoffNextRetryAt: null,
    mergeBackoffSince: null,
  }).where(eq(workspaces.id, workspaceId));
}

export async function setMergeBackoffState(
  workspaceId: string,
  state: {
    failures: number;
    signature: string;
    error: string;
    branchSha: string | null;
    verifyHash: string | null;
    nextRetryAt: string;
    since: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({
    mergeBackoffFailures: state.failures,
    mergeBackoffSignature: state.signature,
    mergeBackoffError: state.error,
    mergeBackoffBranchSha: state.branchSha,
    mergeBackoffVerifyHash: state.verifyHash,
    mergeBackoffNextRetryAt: state.nextRetryAt,
    mergeBackoffSince: state.since,
    updatedAt: state.updatedAt,
  }).where(eq(workspaces.id, workspaceId));
}
