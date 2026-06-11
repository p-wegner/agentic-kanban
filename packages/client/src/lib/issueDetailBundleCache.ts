import { apiFetch } from "./api.js";

// Shape of GET /api/issues/:id/detail-bundle. Kept loose (the panel owns the
// precise field types) — this layer only caches and dedupes the round-trip.
export interface IssueDetailBundleData {
  issue: { id: string; description: string | null };
  workspaces: { id: string }[];
  tags: { id: string; name: string; color: string | null }[];
  dependencies: unknown;
  artifacts: unknown[];
  comments: unknown[];
  activity: { events: unknown[] };
}

interface CacheEntry {
  data: IssueDetailBundleData;
  ts: number;
}

// Stale-while-revalidate cache + in-flight dedup for the issue detail bundle.
//
// - Dedup: concurrent callers for the same issue (React StrictMode double-invoke
//   in dev, or the panel + a hover prefetch racing) share ONE network request.
// - SWR: a cached bundle is returned instantly so re-opening a recently-viewed
//   ticket paints immediately; `isFresh` tells the caller whether to revalidate.
// - Prefetch: warming the cache on card hover/focus makes the click feel instant.
const TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<IssueDetailBundleData>>();

function fetchBundle(issueId: string): Promise<IssueDetailBundleData> {
  const existing = inflight.get(issueId);
  if (existing) return existing;
  const p = apiFetch<IssueDetailBundleData>(`/api/issues/${issueId}/detail-bundle`)
    .then((data) => {
      cache.set(issueId, { data, ts: Date.now() });
      return data;
    })
    .finally(() => {
      inflight.delete(issueId);
    });
  inflight.set(issueId, p);
  return p;
}

/** Cached bundle if present (regardless of age), else null. */
export function getCachedBundle(issueId: string): { data: IssueDetailBundleData; isFresh: boolean } | null {
  const entry = cache.get(issueId);
  if (!entry) return null;
  return { data: entry.data, isFresh: Date.now() - entry.ts < TTL_MS };
}

/** Force a network fetch (deduped) and update the cache. */
export function revalidateBundle(issueId: string): Promise<IssueDetailBundleData> {
  return fetchBundle(issueId);
}

/**
 * Load the bundle. Returns the deduped in-flight/network promise; if a fresh
 * cache entry exists, resolves from cache without a network call.
 */
export function loadBundle(issueId: string): Promise<IssueDetailBundleData> {
  const cached = getCachedBundle(issueId);
  if (cached?.isFresh) return Promise.resolve(cached.data);
  return fetchBundle(issueId);
}

/** Warm the cache ahead of a click (hover/focus). Best-effort; errors ignored. */
export function prefetchBundle(issueId: string): void {
  const cached = getCachedBundle(issueId);
  if (cached?.isFresh) return;
  if (inflight.has(issueId)) return;
  fetchBundle(issueId).catch(() => { /* prefetch is best-effort */ });
}

/** Drop a cached bundle (e.g. after an edit that the panel made). */
export function invalidateBundle(issueId: string): void {
  cache.delete(issueId);
}
