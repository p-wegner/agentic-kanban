import { useState, useEffect, useCallback } from "react";
import type { ProjectRepoResponse, StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import {
  buildMultiRepoMatrix,
  type MatrixCell,
  type MatrixWorkspaceInput,
  type MultiRepoMatrix,
  type RepoMergeStatusResponse,
} from "../lib/multiRepoMatrix.js";

/** Slim projection of GET /api/workspaces?projectId= (see listWorkspacesSlim). */
interface SlimWorkspace {
  id: string;
  issueId: string;
  branch: string | null;
  status: string;
  mergedAt: string | null;
  isDirect: boolean;
}

interface MultiRepoMonitorPanelProps {
  activeProjectId: string | null;
  /** The project's leading repo path (ProjectResponse.repoPath). */
  leadingRepoPath: string | null;
  columns: StatusWithIssues[];
  onClose: () => void;
}

interface MonitorData {
  additionalRepos: ProjectRepoResponse[];
  workspaces: MatrixWorkspaceInput[];
  matrix: MultiRepoMatrix;
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

function MatrixCellBadge({ cell }: { cell: MatrixCell | null }) {
  if (!cell) {
    return <span className="text-gray-300 dark:text-gray-700" title="Repo not part of this workspace">—</span>;
  }
  const style = CELL_STYLES[cell.state] ?? CELL_STYLES.unknown;
  return (
    <span
      className={`inline-block text-[11px] font-medium px-1.5 py-0.5 rounded ${style.className}`}
      title={style.title}
      data-cell-state={cell.state}
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
  const [data, setData] = useState<MonitorData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!activeProjectId) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [additionalRepos, allWorkspaces] = await Promise.all([
          apiFetch<ProjectRepoResponse[]>(`/api/projects/${activeProjectId}/repos`),
          apiFetch<SlimWorkspace[]>(
            `/api/workspaces?projectId=${activeProjectId}&status=active,idle,reviewing,fixing`,
          ),
        ]);
        // repo-merge-status is not applicable to direct workspaces (400).
        const active = allWorkspaces.filter((w) => !w.isDirect);

        const statuses = await Promise.all(
          active.map((w) =>
            apiFetch<RepoMergeStatusResponse>(`/api/workspaces/${w.id}/repo-merge-status`)
              .catch(() => null),
          ),
        );
        // The conflict check runs real git merge-trees per repo — only pay for it on
        // workspaces that actually have unlanded work.
        const conflicts = await Promise.all(
          active.map((w, i) => {
            const st = statuses[i];
            if (!st?.repos.some((r) => r.hasWork && !r.merged)) return Promise.resolve(null);
            return apiFetch<{ hasConflicts: boolean }>(`/api/workspaces/${w.id}/conflicts`)
              .catch(() => null);
          }),
        );

        const issueById = new Map(
          columns.flatMap((c) => c.issues).map((i) => [i.id, i]),
        );
        const workspaces: MatrixWorkspaceInput[] = active.map((w, i) => {
          const issue = issueById.get(w.issueId);
          return {
            id: w.id,
            issueNumber: issue?.issueNumber ?? null,
            issueTitle: issue?.title ?? null,
            branch: w.branch,
            status: w.status,
            mergedAt: w.mergedAt,
            repoStatus: statuses[i],
            hasConflicts: conflicts[i]?.hasConflicts ?? false,
          };
        });

        const repoInputs = [
          ...(leadingRepoPath ? [{ name: null, path: leadingRepoPath, isLeading: true }] : []),
          ...additionalRepos.map((r) => ({ name: r.name, path: r.path, isLeading: false })),
        ];
        setData({
          additionalRepos,
          workspaces,
          matrix: buildMultiRepoMatrix(repoInputs, workspaces),
        });
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
  }, [activeProjectId, leadingRepoPath, columns]);

  useEffect(() => {
    load();
    // Intentionally load once per open — `load`'s deps churn with board refreshes
    // and each run fans out git work server-side; refresh is manual (↻).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  const summary = data?.matrix.summary ?? null;
  const isMultiRepo = (data?.additionalRepos.length ?? 0) > 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-[min(860px,100vw)] bg-surface-raised dark:bg-surface-raised-dark shadow-xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <GridIcon />
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 heading-serif">Multi-Repo Monitor</h2>
            {loading && <span className="text-sm text-gray-400 dark:text-gray-500">Loading…</span>}
            {!loading && summary && isMultiRepo && (
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
            <button
              onClick={load}
              disabled={loading}
              title="Refresh"
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

          {activeProjectId && error && (
            <div className="flex flex-col items-center justify-center h-48 text-red-500 dark:text-red-400 gap-2 px-6 text-center">
              <span className="text-sm">{error}</span>
              <button onClick={load} className="text-xs underline text-red-400 hover:text-red-600">
                Retry
              </button>
            </div>
          )}

          {activeProjectId && !loading && !error && data && !isMultiRepo && (
            <div className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-500 gap-2 px-6 text-center">
              <p className="text-sm font-medium">Not a multi-repo project</p>
              <p className="text-xs">Add additional repos in Settings → Project → Repos to monitor them here.</p>
            </div>
          )}

          {activeProjectId && !loading && !error && data && isMultiRepo && data.workspaces.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-500 gap-2 px-6 text-center">
              <p className="text-sm font-medium">No active workspaces</p>
              <p className="text-xs">Start a workspace to see its per-repo merge state here.</p>
            </div>
          )}

          {activeProjectId && !loading && !error && data && isMultiRepo && data.workspaces.length > 0 && (
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
                        <MatrixCellBadge cell={cell} />
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
