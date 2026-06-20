// Pure decision helpers extracted from workspace-summary.service's applyDiffStats
// phase. No db / no git — just the cache-interpretation logic, so each rule is a
// directly-unit-testable seam. `nowMs` is injected (never `Date.now()` inline) so
// the staleness rule is deterministically testable.

export interface DiffStatCacheFields {
  diffStatCacheCheckedAt: string | null;
  diffStatCacheFilesChanged: number | null;
  diffStatCacheInsertions: number | null;
  diffStatCacheDeletions: number | null;
  diffStatCacheHeadSha: string | null;
}

export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

function cacheHasChanges(c: DiffStatCacheFields): boolean {
  return (c.diffStatCacheFilesChanged ?? 0) > 0
    || (c.diffStatCacheInsertions ?? 0) > 0
    || (c.diffStatCacheDeletions ?? 0) > 0;
}

/**
 * The cached diff stats to serve immediately, or null when there is no usable
 * cache entry (never checked, or an all-zero diff that carries no information).
 */
export function selectCachedDiffStats(c: DiffStatCacheFields): DiffStats | null {
  if (!c.diffStatCacheCheckedAt || c.diffStatCacheFilesChanged === null) return null;
  if (!cacheHasChanges(c)) return null;
  return {
    filesChanged: c.diffStatCacheFilesChanged,
    insertions: c.diffStatCacheInsertions ?? 0,
    deletions: c.diffStatCacheDeletions ?? 0,
  };
}

/**
 * A plan-only session: an idle workspace, not explicitly in plan mode, that has a
 * computed diff cache showing zero changes — i.e. the agent produced a plan but no
 * code. Requires a cache check to have happened (else we don't know yet).
 */
export function isPlanOnlySession(
  ws: { status: string; planMode: boolean } & DiffStatCacheFields,
): boolean {
  if (ws.status !== "idle" || ws.planMode || !ws.diffStatCacheCheckedAt) return false;
  return !cacheHasChanges(ws);
}

/**
 * Whether the diff-stat cache needs a background refresh: HEAD advanced past the
 * cached SHA, or the cache is missing / older than the TTL.
 */
export function isDiffCacheStale(
  c: Pick<DiffStatCacheFields, "diffStatCacheCheckedAt" | "diffStatCacheHeadSha">,
  currentHeadSha: string | null,
  ttlMs: number,
  nowMs: number,
): boolean {
  const headChanged = currentHeadSha !== null && currentHeadSha !== c.diffStatCacheHeadSha;
  const age = c.diffStatCacheCheckedAt
    ? nowMs - new Date(c.diffStatCacheCheckedAt).getTime()
    : Infinity;
  return headChanged || age >= ttlMs;
}
