// Last-known-good cache + bounded background refresh queue for per-worktree
// `git diff --shortstat` results (#342).
//
// GET /api/projects/:id/worktrees used to await one `git diff --shortstat`
// subprocess per non-main worktree inline, inside a Promise.all — no cache, no
// concurrency limit, no budget. With ~45 active worktrees that is 40+ parallel git
// spawns against the same repo, which on Windows serialize on disk/index-lock
// contention: the endpoint measured 112.7s, then two 120s timeouts.
//
// Worktrees that map to a workspace are served from the `diff_stat_cache_*` columns
// the board path already maintains, so they need nothing here. This module covers the
// remainder — worktrees with no workspace row (or a workspace whose cache is empty),
// which have nowhere in the DB to be cached. It follows the same stale-while-
// revalidate philosophy as the board summary cache: serve the last known value
// immediately, refresh in the background at most CONCURRENCY spawns at a time, and
// return `undefined` (rendered as "no diff") on a true first sighting.
//
// No git here — the caller injects the compute function, so this is a pure,
// directly-testable scheduler.

export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** How long a cached entry is considered fresh; older entries are still SERVED, then refreshed. */
export const WORKTREE_DIFF_STATS_TTL_MS = 30_000;
/** Ceiling on concurrent background git spawns. Matches the board path's BG_GIT_CONCURRENCY. */
export const WORKTREE_DIFF_STATS_CONCURRENCY = 5;

interface Entry {
  /** null = computed, but an all-zero diff, i.e. "nothing to show". */
  stats: DiffStats | null;
  checkedAtMs: number;
}

const cache = new Map<string, Entry>();
/** Keys with a refresh queued or running — prevents the same worktree being queued twice. */
const inflight = new Set<string>();
const queue: string[] = [];
const computeByKey = new Map<string, () => Promise<DiffStats>>();
let running = 0;
/** Resolves once the queue is fully drained. Test hook only. */
let drained: Promise<void> = Promise.resolve();
let signalDrained: () => void = () => {};

function cacheKey(worktreePath: string, base: string): string {
  return `${worktreePath}::${base}`;
}

function isEmpty(stats: DiffStats): boolean {
  return stats.filesChanged === 0 && stats.insertions === 0 && stats.deletions === 0;
}

/**
 * The last known diff stats for a worktree, or undefined when nothing has been
 * computed yet or the computed diff was empty. Stale entries are returned as-is —
 * a value one refresh cycle behind is the point of the design.
 */
export function cachedWorktreeDiffStats(worktreePath: string, base: string): DiffStats | undefined {
  const entry = cache.get(cacheKey(worktreePath, base));
  if (!entry || entry.stats === null) return undefined;
  return entry.stats;
}

/**
 * Queue a background refresh for a worktree when its cached value is missing or
 * older than the TTL. A no-op when the value is fresh or a refresh is already
 * pending for this key, so a poll loop cannot pile spawns up.
 */
export function scheduleWorktreeDiffStatsRefresh(
  worktreePath: string,
  base: string,
  compute: () => Promise<DiffStats>,
  nowMs: number = Date.now(),
): void {
  const key = cacheKey(worktreePath, base);
  if (inflight.has(key)) return;
  const entry = cache.get(key);
  if (entry && nowMs - entry.checkedAtMs < WORKTREE_DIFF_STATS_TTL_MS) return;

  inflight.add(key);
  computeByKey.set(key, compute);
  if (queue.length === 0 && running === 0) {
    drained = new Promise<void>((resolve) => { signalDrained = resolve; });
  }
  queue.push(key);
  pump();
}

function pump(): void {
  while (running < WORKTREE_DIFF_STATS_CONCURRENCY && queue.length > 0) {
    const key = queue.shift()!;
    const compute = computeByKey.get(key);
    computeByKey.delete(key);
    if (!compute) {
      inflight.delete(key);
      continue;
    }
    running++;
    void compute()
      .then((stats) => {
        cache.set(key, { stats: isEmpty(stats) ? null : stats, checkedAtMs: Date.now() });
      })
      .catch(() => {
        // A failed spawn must not retry in a tight loop: record the attempt so the TTL
        // gates the next one. The previous value (if any) is deliberately kept.
        const previous = cache.get(key);
        cache.set(key, { stats: previous?.stats ?? null, checkedAtMs: Date.now() });
      })
      .finally(() => {
        running--;
        inflight.delete(key);
        if (queue.length > 0) pump();
        else if (running === 0) signalDrained();
      });
  }
}

/** Test hook: resolves once every queued refresh has settled. */
export function whenWorktreeDiffStatsIdle(): Promise<void> {
  return running === 0 && queue.length === 0 ? Promise.resolve() : drained;
}

/** Test hook: drop all cached state so suites don't leak into each other. */
export function resetWorktreeDiffStatsCacheForTest(): void {
  cache.clear();
  inflight.clear();
  queue.length = 0;
  computeByKey.clear();
  running = 0;
}
