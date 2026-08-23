import { eq } from "drizzle-orm";
import { workspaceDiffStatCache } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

/**
 * The one owner of the cached `git diff --shortstat` memo, over its own table (#815).
 *
 * The five `diff_stat_cache_*` columns used to sit on `workspaces`. Re-derived on the column
 * names AND the camelCase fields, ten non-test files named them against the table: the schema,
 * eight repositories (`issue`, `project-service`, `showdown`, `workspace-reads`,
 * `workspace-repo-status-batch`, `workspace-risk`, `workspace-summary-projection`,
 * `workspace-summary`) and one inline `db.select` in `startup/monitor-setup.ts`. Every one of
 * those reads now LEFT JOINs this table and aliases the columns straight back to
 * `diffStatCacheCheckedAt` / `diffStatCacheHeadSha` / `diffStatCacheFilesChanged` /
 * `diffStatCacheInsertions` / `diffStatCacheDeletions`, so the row-readers downstream
 * (`lib/workspace-diff-cache.ts`, `lib/workspace-details-projection.ts`,
 * `lib/workspace-risk-signals.ts`, `services/monitor-cycle-rules.ts`, the diff/summary/
 * repo-status services), the DTOs and the client never see the move.
 *
 * An ABSENT row means "never diffed", exactly as five NULL columns did: every staleness
 * predicate keys off a null `checked_at` and revalidates, and `hasNonEmptyDiffStats` /
 * `projectDiffStats` read a null `files_changed` as "no stats yet". That is why — unlike the
 * `summary_*` family, whose `dirty` flag was `NOT NULL DEFAULT TRUE` — no read here coalesces,
 * and so none needs `.mapWith(...)` to undo a coalesce bypassing a column's mode mapping.
 * The LEFT JOIN is still load-bearing: an inner join would hide every never-diffed workspace.
 */

/** The shortstat as the SWR refresh paths write it. */
export interface DiffStatCacheValues {
  checkedAt: string;
  headSha: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/**
 * Record the latest shortstat for a workspace, replacing whatever was memoized before.
 *
 * Upsert rather than update: the memo is a LATEST-value record that must exist after the first
 * refresh, and the plain `update(workspaces).set(...)` this replaced always had a row to write
 * to. An UPDATE here would silently no-op for every workspace that has never been diffed —
 * which is precisely the case the refresh runs for.
 */
export async function updateWorkspaceDiffStatCache(
  workspaceId: string,
  values: DiffStatCacheValues,
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.insert(workspaceDiffStatCache).values({ workspaceId, ...values })
    .onConflictDoUpdate({ target: workspaceDiffStatCache.workspaceId, set: { ...values } });
}

/** The memo for one workspace, or `undefined` when its branch has never been diffed. */
export async function getWorkspaceDiffStatCache(
  workspaceId: string,
  database: Database = db,
): Promise<typeof workspaceDiffStatCache.$inferSelect | undefined> {
  const [row] = await database.select().from(workspaceDiffStatCache)
    .where(eq(workspaceDiffStatCache.workspaceId, workspaceId)).limit(1);
  return row;
}
