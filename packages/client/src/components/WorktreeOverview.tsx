import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface WorktreeInfo {
  path: string;
  branch: string;
  isMain: boolean;
  workspace?: {
    id: string;
    status: string;
    isDirect: boolean;
    issueId: string;
    issueNumber: number | null;
    issueTitle: string;
  };
  diffStats?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

interface WorktreeOverviewProps {
  projectId: string;
  onClose: () => void;
  onIssueClick: (issueId: string) => void;
  onWorkspaceChange?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  idle: "bg-yellow-100 text-yellow-700",
  error: "bg-red-100 text-red-700",
  closed: "bg-gray-100 text-gray-500",
};

function truncatePath(path: string, maxLen = 50): string {
  if (path.length <= maxLen) return path;
  return "..." + path.slice(path.length - maxLen + 3);
}

export function WorktreeOverview({ projectId, onClose, onIssueClick, onWorkspaceChange }: WorktreeOverviewProps) {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const loadWorktrees = useCallback(async () => {
    try {
      const data = await apiFetch<WorktreeInfo[]>(`/api/projects/${projectId}/worktrees`);
      setWorktrees(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load worktrees");
    }
  }, [projectId]);

  useEffect(() => {
    async function load() {
      await loadWorktrees();
      setLoading(false);
    }
    load();
  }, [loadWorktrees]);

  async function handleOpenFolder(wt: WorktreeInfo) {
    setOpening(wt.path);
    try {
      await apiFetch(`/api/projects/${projectId}/worktrees/open`, {
        method: "POST",
        body: JSON.stringify({ path: wt.path }),
      });
    } catch {
      showToast("Failed to open folder", "error");
    } finally {
      setOpening(null);
    }
  }

  async function handleDelete(wt: WorktreeInfo) {
    const label = wt.workspace
      ? `#${wt.workspace.issueNumber} ${wt.workspace.issueTitle} (${wt.branch})`
      : wt.branch;

    if (!window.confirm(`Delete worktree "${label}"?\n\nThis will remove the git worktree${wt.workspace ? ", workspace, and all session data" : ""}.`)) return;

    setDeleting(wt.path);
    try {
      const body: Record<string, string> = { path: wt.path };
      if (wt.workspace) body.workspaceId = wt.workspace.id;

      await apiFetch(`/api/projects/${projectId}/worktrees`, {
        method: "DELETE",
        body: JSON.stringify(body),
      });
      await loadWorktrees();
      setSelected((prev) => { const next = new Set(prev); next.delete(wt.path); return next; });
      onWorkspaceChange?.();
      showToast("Worktree deleted", "success");
    } catch {
      showToast("Failed to delete worktree", "error");
    } finally {
      setDeleting(null);
    }
  }

  async function handleBulkDelete() {
    const targets = additionalWorktrees.filter((wt) => selected.has(wt.path));
    if (targets.length === 0) return;

    const orphanCount = targets.filter((wt) => !wt.workspace).length;
    const withWorkspace = targets.filter((wt) => wt.workspace).length;
    const lines = [`Delete ${targets.length} worktree${targets.length !== 1 ? "s" : ""}?`];
    if (orphanCount > 0) lines.push(`• ${orphanCount} orphaned (no workspace)`);
    if (withWorkspace > 0) lines.push(`• ${withWorkspace} with workspace + session data`);
    lines.push("\nThis cannot be undone.");

    if (!window.confirm(lines.join("\n"))) return;

    setBulkDeleting(true);
    let failed = 0;
    for (const wt of targets) {
      try {
        const body: Record<string, string> = { path: wt.path };
        if (wt.workspace) body.workspaceId = wt.workspace.id;
        await apiFetch(`/api/projects/${projectId}/worktrees`, {
          method: "DELETE",
          body: JSON.stringify(body),
        });
      } catch {
        failed++;
      }
    }
    setBulkDeleting(false);
    setSelected(new Set());
    await loadWorktrees();
    onWorkspaceChange?.();
    if (failed > 0) {
      showToast(`Deleted ${targets.length - failed} worktree(s); ${failed} failed`, "error");
    } else {
      showToast(`Deleted ${targets.length} worktree${targets.length !== 1 ? "s" : ""}`, "success");
    }
  }

  function toggleSelect(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleSelectAll() {
    const selectable = additionalWorktrees.map((wt) => wt.path);
    if (selectable.every((p) => selected.has(p))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable));
    }
  }

  function selectOrphans() {
    const orphanPaths = additionalWorktrees.filter((wt) => !wt.workspace).map((wt) => wt.path);
    setSelected(new Set(orphanPaths));
  }

  const additionalWorktrees = worktrees.filter((wt) => !wt.isMain);
  const mainWorktree = worktrees.find((wt) => wt.isMain);
  const orphanCount = additionalWorktrees.filter((wt) => !wt.workspace).length;
  const allSelected = additionalWorktrees.length > 0 && additionalWorktrees.every((wt) => selected.has(wt.path));

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-[min(480px,100vw)] bg-white dark:bg-gray-900 shadow-xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Worktrees</h2>
            <span className="text-sm text-gray-500 dark:text-gray-400">({worktrees.length})</span>
            {orphanCount > 0 && (
              <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-medium">
                {orphanCount} orphaned
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
          >
            &times;
          </button>
        </div>

        {/* Bulk action toolbar */}
        {additionalWorktrees.length > 0 && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-950">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleSelectAll}
              className="h-4 w-4 rounded border-gray-300 text-blue-600"
              title="Select all"
            />
            <span className="text-xs text-gray-500 dark:text-gray-400 flex-1">
              {selected.size > 0 ? `${selected.size} selected` : "Select worktrees to bulk delete"}
            </span>
            {orphanCount > 0 && selected.size === 0 && (
              <button
                onClick={selectOrphans}
                className="text-xs text-orange-600 hover:text-orange-800 hover:underline"
              >
                Select orphaned
              </button>
            )}
            {selected.size > 0 && (
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="flex items-center gap-1 text-xs bg-red-600 text-white px-2.5 py-1 rounded hover:bg-red-700 disabled:opacity-50"
              >
                {bulkDeleting ? (
                  "Deleting..."
                ) : (
                  <>
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                    Delete {selected.size}
                  </>
                )}
              </button>
            )}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-sm text-gray-500 dark:text-gray-400">Loading...</div>
          ) : error ? (
            <div className="p-4 text-sm text-red-600">{error}</div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {/* Main checkout */}
              {mainWorktree && (
                <div className="px-4 py-3 bg-gray-50 dark:bg-gray-950">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {mainWorktree.branch}
                    </span>
                    <span className="text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded">main</span>
                    {mainWorktree.workspace?.isDirect && (
                      <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">direct</span>
                    )}
                    {mainWorktree.workspace && (
                      <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[mainWorktree.workspace.status] ?? "bg-gray-100 text-gray-600"}`}>
                        {mainWorktree.workspace.status}
                      </span>
                    )}
                    <button
                      onClick={() => handleOpenFolder(mainWorktree)}
                      disabled={opening === mainWorktree.path}
                      className="ml-auto p-1 text-gray-300 dark:text-gray-600 hover:text-blue-500 rounded hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50"
                      title="Open folder in explorer"
                    >
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                    </button>
                  </div>
                  <div className="text-xs text-gray-400 dark:text-gray-500 font-mono">
                    {truncatePath(mainWorktree.path, 60)}
                  </div>
                  {mainWorktree.workspace && mainWorktree.workspace.issueNumber != null && (
                    <button
                      onClick={() => onIssueClick(mainWorktree.workspace!.issueId)}
                      className="mt-1.5 text-xs text-blue-600 hover:text-blue-800 hover:underline"
                    >
                      #{mainWorktree.workspace.issueNumber} {mainWorktree.workspace.issueTitle}
                    </button>
                  )}
                </div>
              )}

              {/* Additional worktrees */}
              {additionalWorktrees.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                  No additional worktrees
                </div>
              ) : (
                additionalWorktrees.map((wt) => {
                  const isOrphan = !wt.workspace;
                  const isSelected = selected.has(wt.path);
                  return (
                    <div
                      key={wt.path}
                      className={`px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800 ${isSelected ? "bg-blue-50 dark:bg-blue-900/20" : ""}`}
                    >
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(wt.path)}
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 shrink-0"
                        />
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {wt.branch}
                        </span>
                        {isOrphan && (
                          <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">orphaned</span>
                        )}
                        {wt.workspace?.isDirect && (
                          <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">direct</span>
                        )}
                        {wt.workspace && (
                          <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_COLORS[wt.workspace.status] ?? "bg-gray-100 text-gray-600"}`}>
                            {wt.workspace.status}
                          </span>
                        )}
                        {wt.diffStats && wt.diffStats.filesChanged > 0 && (
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {wt.diffStats.filesChanged} file{wt.diffStats.filesChanged !== 1 ? "s" : ""},{" "}
                            <span className="text-green-600">+{wt.diffStats.insertions}</span>
                            {" "}/{" "}
                            <span className="text-red-600">-{wt.diffStats.deletions}</span>
                          </span>
                        )}
                        <button
                          onClick={() => handleOpenFolder(wt)}
                          disabled={opening === wt.path}
                          className="ml-auto p-1 text-gray-300 dark:text-gray-600 hover:text-blue-500 rounded hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50"
                          title="Open folder in explorer"
                        >
                          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => handleDelete(wt)}
                          disabled={deleting === wt.path}
                          className="p-1 text-gray-300 dark:text-gray-600 hover:text-red-500 rounded hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
                          title="Delete worktree"
                        >
                          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                      <div className="text-xs text-gray-400 dark:text-gray-500 font-mono pl-6">
                        {truncatePath(wt.path, 55)}
                      </div>
                      {wt.workspace && wt.workspace.issueNumber != null && (
                        <button
                          onClick={() => onIssueClick(wt.workspace!.issueId)}
                          className="mt-1.5 ml-6 text-xs text-blue-600 hover:text-blue-800 hover:underline"
                        >
                          #{wt.workspace.issueNumber} {wt.workspace.issueTitle}
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
