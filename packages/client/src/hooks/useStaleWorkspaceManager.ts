import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../lib/api.js";

export interface StaleWorktreeEntry {
  id: string;
  branch: string;
  workingDir: string;
  workspaceStatus: string;
  closedAt: string | null;
  mergedAt: string | null;
  updatedAt: string | null;
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  issueStatusName: string;
  projectId: string;
  repoPath: string;
}

interface UseStaleWorkspaceManagerOptions {
  /** Only fetch when the stale tab is active. */
  enabled: boolean;
  /** Active project filter; "all" fetches across every project. */
  projectFilter: string;
}

export interface StaleWorkspaceManager {
  staleWorktrees: StaleWorktreeEntry[];
  staleLoading: boolean;
  removingIds: Set<string>;
  staleErrors: Record<string, string>;
  /** Remove a single worktree, prompting for confirmation first. */
  removeStale: (id: string) => Promise<void>;
  /** Remove every listed worktree, prompting once for confirmation. */
  removeAllStale: () => Promise<void>;
  /** Re-fetch the stale worktree list. */
  refresh: () => void;
}

/**
 * Owns all stale-workspace coordination — fetching the list, the in-flight
 * removal/error bookkeeping, and the async DELETE calls plus their state
 * mutation. Extracted from AllWorkspacesPanel (#647) so the component focuses
 * on rendering while the previously high-complexity handleRemoveStaleSilent
 * coordination logic lives here in one place.
 */
export function useStaleWorkspaceManager({ enabled, projectFilter }: UseStaleWorkspaceManagerOptions): StaleWorkspaceManager {
  const [staleWorktrees, setStaleWorktrees] = useState<StaleWorktreeEntry[]>([]);
  const [staleLoading, setStaleLoading] = useState(false);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [staleErrors, setStaleErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    if (!enabled) return;
    setStaleLoading(true);
    const query = projectFilter !== "all" ? `?projectId=${projectFilter}` : "";
    apiFetch<StaleWorktreeEntry[]>(`/api/workspaces/stale-worktrees${query}`)
      .then((data) => { setStaleWorktrees(data); setStaleErrors({}); })
      .catch(() => setStaleWorktrees([]))
      .finally(() => setStaleLoading(false));
  }, [enabled, projectFilter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Core removal coordination: marks the id as in-flight, issues the DELETE,
   * then reconciles the list or records the error. No UI feedback (no confirm
   * prompt) — callers that need confirmation gate on it before calling.
   */
  const removeStaleSilent = useCallback(async (id: string) => {
    setRemovingIds((prev) => new Set(prev).add(id));
    setStaleErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
    try {
      const result = await apiFetch<{ success: boolean; error?: string }>(`/api/workspaces/${id}/stale-worktree`, { method: "DELETE" });
      if (result.success) {
        setStaleWorktrees((prev) => prev.filter((w) => w.id !== id));
      } else {
        setStaleErrors((prev) => ({ ...prev, [id]: result.error ?? "Unknown error" }));
      }
    } catch (err) {
      setStaleErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : String(err) }));
    }
    setRemovingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }, []);

  const removeStale = useCallback(async (id: string) => {
    const entry = staleWorktrees.find((w) => w.id === id);
    const label = entry ? `#${entry.issueNumber} ${entry.branch}` : "this worktree";
    if (!window.confirm(`Remove stale worktree for ${label}?\n\nThis deletes the directory:\n${entry?.workingDir ?? ""}`)) return;
    await removeStaleSilent(id);
  }, [staleWorktrees, removeStaleSilent]);

  const removeAllStale = useCallback(async () => {
    if (staleWorktrees.length === 0) return;
    const confirmed = window.confirm(
      `Remove ${staleWorktrees.length} stale worktree${staleWorktrees.length !== 1 ? "s" : ""}?\n\nThis deletes all listed directories.`
    );
    if (!confirmed) return;

    const ids = staleWorktrees.map((w) => w.id);
    for (const id of ids) {
      await removeStaleSilent(id);
    }
  }, [staleWorktrees, removeStaleSilent]);

  return { staleWorktrees, staleLoading, removingIds, staleErrors, removeStale, removeAllStale, refresh };
}
