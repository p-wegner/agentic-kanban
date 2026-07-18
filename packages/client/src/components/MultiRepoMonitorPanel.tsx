import { useState, useEffect } from "react";
import type { StatusWithIssues } from "@agentic-kanban/shared";
import { type MatrixCell } from "../lib/multiRepoMatrix.js";
import { cellKey } from "../lib/diffMultiRepoMatrix.js";
import { useLiveMultiRepoMatrix } from "../hooks/useLiveMultiRepoMatrix.js";

interface MultiRepoMonitorPanelProps {
  activeProjectId: string | null;
  /** The project's leading repo path (ProjectResponse.repoPath). */
  leadingRepoPath: string | null;
  columns: StatusWithIssues[];
  onClose: () => void;
}

/** Compact "updated Ns ago" phrasing for the live indicator. */
function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const CELL_STYLES: Record<string, { label: (ahead: number) => string; className: string; title: string }> = {
  "no-change": {
    label: () => "·",
    className: "text-gray-400 dark:text-gray-600",
    title: "No committed changes in this repo",
  },
  merged: {
    label: () => "merged",
    className: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    title: "Work landed on base",
  },
  ahead: {
    label: (ahead) => `↑${ahead}`,
    className: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    title: "Commits ahead of base (in-flight work)",
  },
  stranded: {
    label: (ahead) => `↑${ahead} stranded`,
    className: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    title: "Unlanded work in a workspace that already (partially) merged",
  },
  conflict: {
    label: () => "conflict",
    className: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    title: "Unlanded work that conflicts with base",
  },
  unknown: {
    label: () => "?",
    className: "text-gray-400 dark:text-gray-500",
    title: "Status check failed for this workspace",
  },
};

function MatrixCellBadge({ cell, flash }: { cell: MatrixCell | null; flash: boolean }) {
  const flashClass = flash ? " cell-flash" : "";
  if (!cell) {
    return (
      <span
        className={`inline-block${flashClass}`}
        data-flash={flash ? "true" : undefined}
      >
        <span className="text-gray-300 dark:text-gray-700" title="Repo not part of this workspace">—</span>
      </span>
    );
  }
  const style = CELL_STYLES[cell.state] ?? CELL_STYLES.unknown;
  return (
    <span
      className={`inline-block text-[11px] font-medium px-1.5 py-0.5 rounded ${style.className}${flashClass}`}
      title={style.title}
      data-cell-state={cell.state}
      data-flash={flash ? "true" : undefined}
    >
      {style.label(cell.ahead)}
    </span>
  );
}

function GridIcon() {
  return (
    <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

/**
 * Multi-Repo Monitor (#82): repo × workspace matrix for multi-repo projects.
 * Rows = registered repos (leading + additional), columns = active (non-closed)
 * workspaces, each cell = that workspace's merge state IN that repo, sourced
 * from GET /api/workspaces/:id/repo-merge-status (fetched in parallel).
 */
export function MultiRepoMonitorPanel({
  activeProjectId,
  leadingRepoPath,
  columns,
  onClose,
}: MultiRepoMonitorPanelProps) {
  const { data, loading, error, changedCells, lastUpdated, paused, setPaused, refresh } =
    useLiveMultiRepoMatrix(activeProjectId, leadingRepoPath, columns);

  // Tick once a second so the "updated Ns ago" label stays current between refreshes.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const summary = data?.matrix.summary ?? null;
  const isMultiRepo = (data?.additionalRepos.length ?? 0) > 0;
  const agoLabel = lastUpdated !== null ? formatAgo(Date.now() - lastUpdated) : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-[min(860px,100vw)] bg-surface-raised dark:bg-surface-raised-dark shadow-xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <GridIcon />
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 heading-serif">Multi-Repo Monitor</h2>
            {loading && !data && <span className="text-sm text-gray-400 dark:text-gray-500">Loading…</span>}
            {summary && isMultiRepo && (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {summary.repoCount} repos · {summary.workspaceCount} active workspace{summary.workspaceCount === 1 ? "" : "s"}
                {summary.strandedWorkspaceCount > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">
                    {" "}· {summary.strandedWorkspaceCount} with stranded work
                  </span>
                )}
                {summary.conflictWorkspaceCount > 0 && (
                  <span className="text-red-600 dark:text-red-400">
                    {" "}· {summary.conflictWorkspaceCount} conflicted
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Live status indicator — ticks "updated Ns ago" and shows pause state. */}
            {activeProjectId && (
              <span
                className="flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500 whitespace-nowrap"
                data-testid="multi-repo-live-indicator"
                data-live={paused ? "paused" : "live"}
                title={paused ? "Live updates paused — press ▶ to resume" : "Live: the matrix updates as the board changes"}
              >
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    paused
                      ? "bg-gray-400 dark:bg-gray-600"
                      : "bg-green-500 graph-active-dot"
                  }`}
                />
                {paused ? "paused" : "live"}
                {agoLabel && <span className="text-gray-300 dark:text-gray-600">· updated {agoLabel}</span>}
              </span>
            )}
            <button
              onClick={() => setPaused(!paused)}
              title={paused ? "Resume live updates" : "Pause live updates"}
              aria-pressed={paused}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-sm px-1.5 py-0.5 rounded"
            >
              {paused ? "▶" : "❚❚"}
            </button>
            <button
              onClick={refresh}
              disabled={loading}
              title="Refresh now"
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40 text-sm px-1.5 py-0.5 rounded"
            >
              ↻
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {!activeProjectId && (
            <div className="flex items-center justify-center h-48 text-gray-400 dark:text-gray-500">
              <span className="text-sm">No active project selected.</span>
            </div>
          )}

          {/* Full-height error only before we ever loaded data; a failed *background*
              refresh keeps the last good matrix visible (the live indicator still ticks). */}
          {activeProjectId && error && !data && (
            <div className="flex flex-col items-center justify-center h-48 text-red-500 dark:text-red-400 gap-2 px-6 text-center">
              <span className="text-sm">{error}</span>
              <button onClick={refresh} className="text-xs underline text-red-400 hover:text-red-600">
                Retry
              </button>
            </div>
          )}

          {activeProjectId && data && !isMultiRepo && (
            <div className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-500 gap-2 px-6 text-center">
              <p className="text-sm font-medium">Not a multi-repo project</p>
              <p className="text-xs">Add additional repos in Settings → Project → Repos to monitor them here.</p>
            </div>
          )}

          {activeProjectId && data && isMultiRepo && data.workspaces.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-500 gap-2 px-6 text-center">
              <p className="text-sm font-medium">No active workspaces</p>
              <p className="text-xs">Start a workspace to see its per-repo merge state here.</p>
            </div>
          )}

          {activeProjectId && data && isMultiRepo && data.workspaces.length > 0 && (
            <table className="text-sm border-collapse min-w-full" data-testid="multi-repo-matrix">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-surface-raised dark:bg-surface-raised-dark text-left text-xs font-semibold text-gray-500 dark:text-gray-400 px-4 py-2 border-b border-gray-200 dark:border-gray-700">
                    Repo
                  </th>
                  {data.workspaces.map((ws) => (
                    <th
                      key={ws.id}
                      className="text-left text-xs font-medium px-3 py-2 border-b border-gray-200 dark:border-gray-700 align-bottom"
                      title={`${ws.issueTitle ?? ""}\n${ws.branch ?? ""}`}
                    >
                      <div className="text-gray-700 dark:text-gray-200 font-mono">
                        {ws.issueNumber !== null ? `#${ws.issueNumber}` : "—"}
                      </div>
                      <div className="text-[10px] text-gray-400 dark:text-gray-500 font-mono truncate max-w-[120px]">
                        {ws.branch ?? ""}
                      </div>
                      <div className="text-[10px] text-gray-400 dark:text-gray-500 capitalize">{ws.status}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.matrix.rows.map((row) => (
                  <tr key={row.key} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                    <td
                      className="sticky left-0 bg-surface-raised dark:bg-surface-raised-dark px-4 py-2 border-b border-gray-100 dark:border-gray-800 whitespace-nowrap"
                      title={row.path}
                    >
                      <span className="text-xs font-mono text-gray-800 dark:text-gray-200">{row.label}</span>
                      {row.isLeading && (
                        <span className="ml-1.5 text-[10px] font-medium px-1 py-0.5 rounded bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">
                          leading
                        </span>
                      )}
                    </td>
                    {row.cells.map((cell, i) => (
                      <td key={data.workspaces[i].id} className="px-3 py-2 border-b border-gray-100 dark:border-gray-800">
                        <MatrixCellBadge cell={cell} flash={changedCells.has(cellKey(row.key, data.workspaces[i].id))} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-gray-100 dark:border-gray-800 text-xs text-gray-400 dark:text-gray-500">
          Per-repo merge state of active workspaces · read-only
        </div>
      </div>
    </div>
  );
}
