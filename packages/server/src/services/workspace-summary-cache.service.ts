import type { WorkspaceSummary } from "./workspace-summary.service.js";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_STALE_TTL_MS = 5 * 60 * 1000; // serve stale for up to 5 minutes while rebuilding
const DEFAULT_MAX_PROJECTS = 200;

interface CacheEntry {
  value: Map<string, WorkspaceSummary>;
  expiresAt: number;
  staleUntil: number;
  rebuilding: boolean;
}

export interface WorkspaceSummaryCacheOptions {
  ttlMs?: number;
  staleTtlMs?: number;
  maxProjects?: number;
}

export interface CacheGetResult {
  value: Map<string, WorkspaceSummary>;
  stale: boolean;
}

export function createWorkspaceSummaryCache(options: WorkspaceSummaryCacheOptions = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const staleTtlMs = options.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
  const maxProjects = options.maxProjects ?? DEFAULT_MAX_PROJECTS;

  const cache = new Map<string, CacheEntry>();

  // Per-project invalidation generation, bumped on every invalidate()/clear().
  // A rebuild captures the generation when it starts; if it differs on completion,
  // a mutation arrived mid-build and the result must be discarded instead of cached.
  // Keys are never deleted (a reset to 0 could falsely match a captured 0) — entries
  // are a (string, number) pair per project ever invalidated, negligible memory.
  const generations = new Map<string, number>();

  /**
   * Returns the cached value with a `stale` flag.
   * - Fresh (within TTL): stale=false
   * - Expired but within staleTtl: stale=true (caller should rebuild in background)
   * - Completely expired or missing: returns null
   */
  function get(projectId: string): CacheGetResult | null {
    const entry = cache.get(projectId);
    if (!entry) return null;
    const now = Date.now();
    if (now > entry.staleUntil) {
      cache.delete(projectId);
      return null;
    }
    const stale = now > entry.expiresAt;
    return { value: entry.value, stale };
  }

  /** Returns true if a background rebuild is already in flight for this project. */
  function isRebuilding(projectId: string): boolean {
    return cache.get(projectId)?.rebuilding ?? false;
  }

  /** Mark a cache entry as currently being rebuilt to avoid duplicate rebuilds. */
  function markRebuilding(projectId: string): void {
    const entry = cache.get(projectId);
    if (entry) entry.rebuilding = true;
  }

  /** Clear the rebuilding flag (on success or failure). */
  function clearRebuilding(projectId: string): void {
    const entry = cache.get(projectId);
    if (entry) entry.rebuilding = false;
  }

  function set(projectId: string, value: Map<string, WorkspaceSummary>): void {
    // Evict oldest entries when at capacity (simple FIFO eviction)
    if (!cache.has(projectId) && cache.size >= maxProjects) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    const now = Date.now();
    cache.set(projectId, { value, expiresAt: now + ttlMs, staleUntil: now + ttlMs + staleTtlMs, rebuilding: false });
  }

  function invalidate(projectId: string): void {
    cache.delete(projectId);
    generations.set(projectId, (generations.get(projectId) ?? 0) + 1);
  }

  function clear(): void {
    const known = new Set([...cache.keys(), ...generations.keys()]);
    cache.clear();
    for (const key of known) generations.set(key, (generations.get(key) ?? 0) + 1);
  }

  /** Current invalidation generation for a project (monotonic; bumped by invalidate/clear). */
  function getGeneration(projectId: string): number {
    return generations.get(projectId) ?? 0;
  }

  function size(): number {
    return cache.size;
  }

  return { get, set, invalidate, clear, size, isRebuilding, markRebuilding, clearRebuilding, getGeneration };
}

export type WorkspaceSummaryCache = ReturnType<typeof createWorkspaceSummaryCache>;
