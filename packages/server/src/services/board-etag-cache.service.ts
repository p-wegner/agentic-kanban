// Conditional-GET fast path for GET /api/projects/:id/board: a memo of the last
// served response's ETag per (projectId + query shape). A request whose
// If-None-Match equals the memoized ETag can be answered 304 WITHOUT rebuilding
// the board, as long as the workspace-summary cache generation is unchanged and
// the memo is younger than BOARD_ETAG_MEMO_MAX_AGE_MS. The invariant making the
// bounded staleness safe: every board-affecting mutation flows through
// boardEvents.broadcast(), whose invalidation listener bumps the cache
// generation — so with an unchanged generation the board body can only drift via
// time-derived fields (columnAgeDays / staleDays / isStale), which have DAY
// granularity. 60s of fast-path staleness is therefore invisible; the TTL is just
// a safety net. Extracted from routes/projects.ts so the route stays declarative
// and the cache invariants are unit-testable in isolation.
const BOARD_ETAG_MEMO_MAX_AGE_MS = 60_000;
const BOARD_ETAG_MEMO_MAX_ENTRIES = 500;

interface BoardEtagMemo {
  etag: string;
  generation: number;
  computedAt: number;
}

export interface BoardEtagCache {
  /**
   * Fast-path a conditional GET. Returns a 304 `Response` when the request's
   * `ifNoneMatch` matches a fresh memo for `memoKey` at the current generation;
   * otherwise `null` (caller takes the full compute path). Always `null` when the
   * cache is disabled or `ifNoneMatch` is absent.
   */
  tryServe(memoKey: string, ifNoneMatch: string | undefined, currentGeneration: number): Response | null;
  /** Record the ETag served on the full path (LRU-evicting at the entry cap). */
  store(memoKey: string, etag: string, generation: number): void;
}

/**
 * The fast path is only sound when board mutations bump the generation (i.e.
 * boardEvents is wired). Pass `enabled: false` to make it never permissive — it
 * then returns `null` from every `tryServe` and the route always recomputes.
 */
export function createBoardEtagCache(options: { enabled: boolean }): BoardEtagCache {
  const { enabled } = options;
  const memos = new Map<string, BoardEtagMemo>();

  return {
    tryServe(memoKey, ifNoneMatch, currentGeneration) {
      if (!enabled || !ifNoneMatch) return null;
      const memo = memos.get(memoKey);
      if (
        memo !== undefined &&
        ifNoneMatch === memo.etag &&
        currentGeneration === memo.generation &&
        Date.now() - memo.computedAt < BOARD_ETAG_MEMO_MAX_AGE_MS
      ) {
        return new Response(null, { status: 304, headers: { ETag: memo.etag } });
      }
      return null;
    },

    store(memoKey, etag, generation) {
      if (!enabled) return;
      if (!memos.has(memoKey) && memos.size >= BOARD_ETAG_MEMO_MAX_ENTRIES) {
        const firstKey = memos.keys().next().value;
        if (firstKey !== undefined) memos.delete(firstKey);
      }
      memos.set(memoKey, { etag, generation, computedAt: Date.now() });
    },
  };
}
