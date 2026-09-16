import type { QuotaUsageResult } from "@agentic-kanban/shared";
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
 * Single write chokepoint for settings: PUT /api/preferences/settings (a
 * partial, merge-not-replace patch) followed by the mandatory
 * invalidateSettings() so cached consumers converge. Bundling the two means no
 * call site can forget the invalidate (the latent staleness bug this replaces:
 * MonitorPopover wrote Start-Mode without invalidating, leaving the shared read
 * cache stale up to the 30s TTL).
 *
 * Owns ONLY the PUT + invalidate. Each caller keeps its own follow-up
 * (local-state refetch, loadTunables(), error swallowing) around this call.
 */
export async function setSettings(patch: Record<string, string>): Promise<void> {
  await apiFetch("/api/preferences/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  invalidateSettings();
}

/**
 * Thin helper for the project-scoped preference families that drift most
 * (start_mode_<id>, board_strategy_<id>, auto_merge_disabled_<id>, …). Keeps the
 * key a plain string by design — the scoped-key space is too large and dynamic
 * for a closed typed union.
 */
export function setProjectPref(projectId: string, key: string, value: string): Promise<void> {
  return setSettings({ [`${key}_${projectId}`]: value });
}

/**
 * Read-only pass-through to GET /api/preferences/quota-usage (#1023, #1028).
 *
 * NOT a settings read: the quota figures are measured server-side from the OAuth usage
 * endpoint and are not part of the flat settings map, so they neither populate the cache
 * above nor participate in `invalidateSettings()` — every call is a fresh request, which is
 * what a "how much is left right now" read-out wants. It lives here anyway because this
 * module OWNS the `/api/preferences` prefix (see `client-conventions-guard`'s bypass
 * ratchet): a component spelling the URL itself is indistinguishable, to a scanner, from
 * one bypassing the settings cache, and the honest answer is to keep every preferences
 * URL literal in the one module that is allowed to hold them.
 */
export function getQuotaUsage(): Promise<QuotaUsageResult> {
  return apiFetch<QuotaUsageResult>("/api/preferences/quota-usage");
}

/**
 * Read-only pass-throughs for the Settings panel's bootstrap/status reads (#1144). Same
 * reasoning as `getQuotaUsage`: none of these populate the settings cache above (the panel
 * owns its own local state for them), but a raw `apiFetch("/api/preferences/…")` call site is
 * indistinguishable, to `client-conventions-guard`'s bypass ratchet, from one that actually
 * bypasses the cache — so every `/api/preferences` URL literal stays in this one module.
 */
export function getSettingsBootstrap<T>(): Promise<T> {
  return apiFetch<T>("/api/preferences/settings-bootstrap");
}

export function getProviderDivergence<T>(projectId: string): Promise<T> {
  return apiFetch<T>(`/api/preferences/provider-divergence?projectId=${projectId}`);
}

export function getAgentProfilesHealth<T>(): Promise<T> {
  return apiFetch<T>("/api/preferences/agent-profiles/health");
}

export function getMcpHealth<T>(): Promise<T> {
  return apiFetch<T>("/api/preferences/mcp/health");
}

type InvalidationListener = () => void;
const invalidationListeners = new Set<InvalidationListener>();

/**
 * Notified after every settings invalidation (#320).
 *
 * Dropping the cache only helps consumers that READ settings through this module. A surface that
 * derives from preferences SERVER-side — the plugin surface's `startPolicy`, resolved by
 * `resolveStartPolicy` in `GET /api/projects/:id/plugin-surface` — has its own fetch, and nothing
 * told it a preference had changed. That is why the Loop pane kept rendering "Start mode is
 * Manual" after the Monitor popover wrote a new `start_mode_<projectId>`: the chip was correct
 * for the surface it had, and the surface was fetched once per project. Subscribers refetch.
 *
 * Fires for every write path (`setSettings`, and the `settings` client-invalidation surface,
 * which calls `invalidateSettings`), so a new call site cannot forget it.
 */
export function subscribeSettingsInvalidated(listener: InvalidationListener): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
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
  // A listener that throws must not swallow the invalidation for the others.
  for (const listener of [...invalidationListeners]) {
    try { listener(); } catch { /* a subscriber's refetch failure is its own problem */ }
  }
}
