import type { WorkspaceSummary } from "./workspace-summary.service.js";

const DEFAULT_TTL_MS = 3_000;
const DEFAULT_MAX_PROJECTS = 200;

interface CacheEntry {
  value: Map<string, WorkspaceSummary>;
  expiresAt: number;
}

export interface WorkspaceSummaryCacheOptions {
  ttlMs?: number;
  maxProjects?: number;
}

export function createWorkspaceSummaryCache(options: WorkspaceSummaryCacheOptions = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxProjects = options.maxProjects ?? DEFAULT_MAX_PROJECTS;

  const cache = new Map<string, CacheEntry>();

  function get(projectId: string): Map<string, WorkspaceSummary> | null {
    const entry = cache.get(projectId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cache.delete(projectId);
      return null;
    }
    return entry.value;
  }

  function set(projectId: string, value: Map<string, WorkspaceSummary>): void {
    // Evict oldest entries when at capacity (simple FIFO eviction)
    if (!cache.has(projectId) && cache.size >= maxProjects) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(projectId, { value, expiresAt: Date.now() + ttlMs });
  }

  function invalidate(projectId: string): void {
    cache.delete(projectId);
  }

  function clear(): void {
    cache.clear();
  }

  function size(): number {
    return cache.size;
  }

  return { get, set, invalidate, clear, size };
}

export type WorkspaceSummaryCache = ReturnType<typeof createWorkspaceSummaryCache>;
