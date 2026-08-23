/**
 * Persisted git-transport token scopes (#775).
 *
 * A sibling of `worker.repository.ts` rather than more functions inside it: this table is
 * the git TRANSPORT's authority record, written and read by `git-http.service.ts` on the
 * request path, while the worker repository answers "which branch was dispatched to whom"
 * off `sessions`/`workspaces`. Only revocation crosses the two.
 *
 * The rows hold DIGESTS, never tokens. They also never WIDEN authority: the git transport
 * still re-derives the assignment from `sessions` on every request (#753), so a surviving
 * row for a finished session authorises nothing. What the table buys is that the board does
 * not FORGET a token it issued when the process restarts.
 */
import { workerGitTokens } from "@agentic-kanban/shared/schema";
import { eq, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { firstRow } from "@agentic-kanban/shared/lib/first-row";

export type GitTokenRow = typeof workerGitTokens.$inferSelect;

export interface PersistedGitTokenScope {
  workerId: string;
  projectId: string;
  incomingRef?: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

/**
 * Record a scope under its digest.
 *
 * `onConflictDoUpdate` rather than a plain insert: a digest collision is not reachable with
 * 256 bits of entropy, but a REPLAY of the same row is — the insert sits behind a
 * fire-and-forget call and a retry must not turn into an unhandled constraint error on a
 * path whose failures are invisible.
 */
export async function insertGitToken(
  tokenHash: string,
  scope: PersistedGitTokenScope,
  database: Database = db,
): Promise<void> {
  const values = {
    tokenHash,
    workerId: scope.workerId,
    projectId: scope.projectId,
    incomingRef: scope.incomingRef ?? null,
    issuedAtMs: scope.issuedAtMs,
    expiresAtMs: scope.expiresAtMs,
  };
  await database.insert(workerGitTokens).values(values).onConflictDoUpdate({
    target: workerGitTokens.tokenHash,
    set: values,
  });
}

/** The scope for a digest, or null when the board never issued it (or it was revoked). */
export async function findGitTokenByHash(
  tokenHash: string,
  database: Database = db,
): Promise<GitTokenRow | null> {
  return firstRow(
    database
      .select()
      .from(workerGitTokens)
      .where(eq(workerGitTokens.tokenHash, tokenHash))
      .limit(1)
  );
}

/** Forget one digest. Returns nothing: the caller's in-memory drop already said whether it existed. */
export async function deleteGitToken(tokenHash: string, database: Database = db): Promise<void> {
  await database.delete(workerGitTokens).where(eq(workerGitTokens.tokenHash, tokenHash));
}

/**
 * Forget every digest held by one worker — the persisted half of `revokeWorker` (#247).
 *
 * Without this, revocation would only clear the process's memory and a restart would
 * resurrect the revoked worker's credential from the table.
 */
export async function deleteGitTokensForWorker(
  workerId: string,
  database: Database = db,
): Promise<number> {
  const rows = await database
    .select({ tokenHash: workerGitTokens.tokenHash })
    .from(workerGitTokens)
    .where(eq(workerGitTokens.workerId, workerId));
  if (rows.length === 0) return 0;
  await database.delete(workerGitTokens).where(eq(workerGitTokens.workerId, workerId));
  return rows.length;
}

/**
 * Drop rows past their TTL ceiling. Run once when the git transport starts, which is the
 * only moment a restart cannot have pruned: the in-memory store pruned on every issue, and
 * a board that issues nothing for a month would otherwise keep a month of dead rows.
 */
export async function pruneExpiredGitTokens(
  nowMs: number = Date.now(),
  database: Database = db,
): Promise<void> {
  await database.delete(workerGitTokens).where(lte(workerGitTokens.expiresAtMs, nowMs));
}
