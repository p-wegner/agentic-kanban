// Conditional-GET fast path for GET /api/projects/:id/board: a memo of the last
// served response's ETag per (projectId + query shape). A request whose
// If-None-Match equals the memoized ETag can be answered 304 WITHOUT rebuilding
// the board, as long as the workspace-summary cache generation is unchanged.
//
// The invariant making that safe: every board-affecting mutation bumps the cache
// generation — foreground mutations through boardEvents.broadcast()'s
// invalidation listener, and (G13) background write-throughs that mutate
// board-visible workspace fields (diff stats, conflict cache, code metrics, the
// #399 git projection) through the summary-write-through notifier, which batches
// a sweep's changes into one invalidation. So with an unchanged generation the
// board body can only drift via time-derived fields (columnAgeDays / staleDays /
// isStale), which have DAY granularity.
//
// G12: a memo hit at a matching generation REFRESHES the memo's freshness stamp
// instead of expiring after 60s — recomputing an unchanged board just to answer
// 304 was the single most expensive no-op on the read path. The residual drift of
// the time-derived day-granularity fields is bounded by a HARD cap on the memo's
// age since its last full compute (15 min — invisible at day granularity), after
// which the route recomputes regardless of generation.
//
// Extracted from routes/projects.ts so the route stays declarative and the cache
// invariants are unit-testable in isolation.
import { createHash } from "node:crypto";

/** Hard cap: max age since the memo's last FULL compute before a matching
 * conditional GET recomputes anyway (bounds day-granularity time-field drift). */
const BOARD_ETAG_MEMO_HARD_MAX_AGE_MS = 15 * 60_000;
const BOARD_ETAG_MEMO_MAX_ENTRIES = 500;

/**
 * Cheap content-hash ETag over a serialized body: sha1, first 16 hex chars,
 * quoted (an opaque strong validator — the same algorithm the board route has
 * always used, so tokens stay format-compatible across endpoints).
 */
export function computeBodyEtag(body: string): string {
  return `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
}

/**
 * Conditional-GET wrapper for list endpoints (GET /api/projects,
 * GET /api/workspaces): hash the serialized payload, answer 304 with no body
 * when If-None-Match carries the same token, otherwise a 200 JSON response
 * with the ETag attached. This still pays the serialize on every request (the
 * data set has no generation counter to memo against, unlike the board route)
 * but skips the response body — and, downstream, the jsonGzip middleware
 * passes 304s through untouched, so the gzip cost disappears too.
 *
 * ── Pass extra headers HERE, never on the returned Response (#426) ──
 *
 * A Hono handler that returns its own `Response` LOSES any header set on that object afterwards.
 * Measured while adding `X-Total-Count` to `GET /api/issues` (#424): the body and the `ETag` —
 * both passed through the constructor's `init` — arrived fine, while the header set afterwards
 * never reached the wire. All three obvious spellings failed the same silent way:
 *
 *     const res = conditionalJsonResponse(...); res.headers.set("X-Total-Count", n); return res;
 *     c.header("X-Total-Count", n); return conditionalJsonResponse(...);
 *     c.res = conditionalJsonResponse(...); c.res.headers.set(...); return c.res;
 *
 * Verified against the backend directly (port 13001), so it is neither the dev proxy nor the gzip
 * middleware — that one copies headers via `new Headers(res.headers)`, and the response was under
 * `COMPRESS_MIN_BYTES` anyway. No error, no warning, just a missing header, with a green test
 * suite unless someone asserts the header explicitly.
 *
 * `extraHeaders` therefore folds into the `init`, where headers survive. They are attached to the
 * 304 too: a conditional response that drops a header the 200 carried would make the header
 * intermittent, which is worse than absent.
 */
export function conditionalJsonResponse(
  body: string,
  ifNoneMatch: string | undefined,
  extraHeaders?: Record<string, string>,
): Response {
  const etag = computeBodyEtag(body);
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, ...extraHeaders } });
  }
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: etag, ...extraHeaders },
  });
}

interface BoardEtagMemo {
  etag: string;
  generation: number;
  /** Sliding freshness stamp — refreshed on every generation-matched hit (G12). */
  computedAt: number;
  /** When the FULL board compute that produced this ETag ran — never refreshed;
   * the hard cap is measured against this. */
  fullComputedAt: number;
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
        Date.now() - memo.fullComputedAt < BOARD_ETAG_MEMO_HARD_MAX_AGE_MS
      ) {
        // G12: generation still matches, so the board is provably unchanged —
        // refresh the memo instead of expiring it and recomputing for a 304.
        memo.computedAt = Date.now();
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
      const now = Date.now();
      memos.set(memoKey, { etag, generation, computedAt: now, fullComputedAt: now });
    },
  };
}
