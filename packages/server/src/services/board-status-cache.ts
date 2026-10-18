import type { BoardStatusResponse } from "@agentic-kanban/shared";

/**
 * Single-flight + short-TTL cache in front of `getBoardStatus` (#1614). `status --watch` polls
 * every few seconds; with 15 workspaces one build took 20-45 s, so overlapping polls piled up and
 * stalled the event loop. Concurrent callers for the same key now share ONE computation, and a
 * fresh answer is reused for `ttlMs`. Failures are never cached.
 */
export const BOARD_STATUS_TTL_MS = 5_000;

interface Entry {
  /** Null while the computation is in flight — a pending entry is always shared, however slow. */
  at: number | null;
  value: Promise<BoardStatusResponse>;
}

export function createBoardStatusCache(ttlMs: number = BOARD_STATUS_TTL_MS) {
  const entries = new Map<string, Entry>();
  return {
    get(key: string, compute: () => Promise<BoardStatusResponse>, nowMs: number = Date.now()): Promise<BoardStatusResponse> {
      const hit = entries.get(key);
      if (hit && (hit.at === null || nowMs - hit.at < ttlMs)) return hit.value;
      const value = compute();
      const entry: Entry = { at: null, value };
      entries.set(key, entry);
      value.then(
        () => { entry.at = Date.now(); },
        () => { if (entries.get(key) === entry) entries.delete(key); },
      );
      return value;
    },
    clear(): void {
      entries.clear();
    },
  };
}

export const boardStatusCache = createBoardStatusCache();
