import { eq } from "drizzle-orm";
import { workspaceConflictCache } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

/**
 * The one owner of the cached merge-tree conflict probe, over its own table (#815).
 *
 * The three `conflict_cache_*` columns used to sit on `workspaces`. Re-derived on the column
 * names AND the camelCase fields, five non-test files named them against the table: the
 * schema, `workspace-summary.repository.ts` (the board read and the sole writer),
 * `workspace-risk.repository.ts`, `issue.repository.ts` and
 * `workspace-reads.repository.ts`. Every one of those reads now LEFT JOINs this table and
 * aliases the columns straight back to `conflictCacheCheckedAt` / `conflictCacheHasConflicts`
 * / `conflictCacheFiles`, so the four row-readers downstream
 * (`lib/workspace-details-projection.ts`, `lib/workspace-risk-signals.ts`,
 * `services/issue.service.ts`, `services/workspace-summary.service.ts`), the DTOs and the
 * client never see the move.
 *
 * An ABSENT row means "never probed", exactly as a NULL `checked_at` did: the TTL age
 * computes as `Infinity` and `applyConflicts` revalidates. The LEFT JOIN is therefore
 * load-bearing — selecting from this table alone would hide every never-probed workspace
 * from the board.
 */

/** The probe result as `applyConflicts` writes it. */
export interface ConflictCacheValues {
  checkedAt: string;
  hasConflicts: boolean;
  files: string;
}

/**
 * Record the latest probe for a workspace, replacing whatever was memoized before.
 *
 * Upsert rather than insert: the probe re-runs on every TTL expiry, and the record is a
 * LATEST-value memo, which is what the three columns were.
 */
export async function updateWorkspaceConflictCache(
  workspaceId: string,
  values: ConflictCacheValues,
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.insert(workspaceConflictCache).values({ workspaceId, ...values })
    .onConflictDoUpdate({ target: workspaceConflictCache.workspaceId, set: { ...values } });
}

/** The memo for one workspace, or `undefined` when its branch has never been probed. */
export async function getWorkspaceConflictCache(
  workspaceId: string,
  database: Database = db,
): Promise<typeof workspaceConflictCache.$inferSelect | undefined> {
  const [row] = await database.select().from(workspaceConflictCache)
    .where(eq(workspaceConflictCache.workspaceId, workspaceId)).limit(1);
  return row;
}
