// Pure decision helpers for the project code/history metrics cache in
// git-info.service.ts. No git, no fs, no clock of their own (`nowMs` is injected) —
// so each rule is a directly-unit-testable seam, the same shape as
// workspace-diff-cache.ts.

export interface MetricsCacheEntryMeta {
  /** When the blob was computed. */
  timestamp: number;
  /** The HEAD sha the blob was computed at, or null when rev-parse could not resolve it. */
  head: string | null;
}

/**
 * HEAD is an INVALIDATION input, not part of the cache key (#340).
 *
 * The cache used to be keyed `${repoPath}:${head}` and to refuse to cache at all when
 * `git rev-parse` failed (key = null, so no store AND no in-flight dedupe). That is
 * exactly backwards: rev-parse only times out when the machine is ALREADY loaded, so
 * the cache and the coalescing both switched themselves off precisely when they were
 * needed, and every concurrent /stats request started its own full 6000-file walk —
 * the measured 4-deep, 132-509s pile-up.
 *
 * Keying on repo+branch instead means there is only ever ONE entry per repo+branch, so
 * a rev-parse that succeeds on one call and times out on the next can no longer split
 * the sync and async paths onto two entries and defeat the shared cache.
 */
export function metricsCacheKey(repoPath: string, branch: string): string {
  return `${repoPath}@${branch}`;
}

/**
 * Whether a cached entry may be served for the head we just observed.
 *
 * - Expired by TTL: no.
 * - Head resolved and DIFFERENT from the stored one: no — a new commit landed.
 * - Head resolved and equal (or the entry predates any known head): yes.
 * - Head UNRESOLVABLE: yes. A blob at most one TTL stale is strictly better than an
 *   uncached multi-minute recompute, and an unresolved head tells us nothing about
 *   whether the entry is actually out of date.
 */
export function isMetricsEntryUsable(
  entry: MetricsCacheEntryMeta | undefined,
  head: string | null,
  ttlMs: number,
  nowMs: number,
): boolean {
  if (!entry) return false;
  if (nowMs - entry.timestamp >= ttlMs) return false;
  if (head === null) return true;
  return entry.head === null || entry.head === head;
}
