import { apiFetch } from "./api.js";

/** Full settings payload of GET /api/preferences/settings (flat key -> value map). */
export type Settings = Record<string, string>;

/**
 * Safety-net TTL. Freshness is primarily maintained by invalidateSettings()
 * after every successful save; the TTL only bounds staleness for out-of-band
 * writes (CLI/MCP/server-side changes) at ~30s.
 */
const TTL_MS = 30_000;

let cached: Settings | null = null;
let cachedAt = 0;
let inFlight: Promise<Settings> | null = null;
/** Bumped on invalidate so an in-flight response from before the
 *  invalidation never repopulates the cache with stale data. */
let generation = 0;

/**
 * Shared, deduped read of GET /api/preferences/settings.
 *
 * - Concurrent callers (StrictMode double-mounts, parallel mount effects)
 *   share a single network request.
 * - The result is cached; consumers keep their own key-selection logic and
 *   error handling, exactly as with a direct apiFetch.
 * - Errors are never cached: a failed fetch rejects all waiters and the next
 *   call retries.
 * - Each caller receives its own shallow copy so accidental mutation cannot
 *   pollute the shared cache.
 */
export function getSettings(): Promise<Settings> {
  if (cached !== null && Date.now() - cachedAt < TTL_MS) {
    return Promise.resolve({ ...cached });
  }
  if (inFlight) return inFlight;
  const gen = generation;
  const req: Promise<Settings> = apiFetch<Settings>("/api/preferences/settings").then(
    (s) => {
      if (inFlight === req) inFlight = null;
      if (gen === generation) {
        cached = s;
        cachedAt = Date.now();
      }
      return { ...s };
    },
    (err) => {
      if (inFlight === req) inFlight = null;
      throw err;
    },
  );
  inFlight = req;
  return req;
}

/**
 * Drop the cached settings so the next getSettings() hits the network.
 * MUST be called after every successful PUT /api/preferences/settings so
 * cached consumers converge on the new values.
 */
export function invalidateSettings(): void {
  generation++;
  cached = null;
  cachedAt = 0;
  inFlight = null;
}
