import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffResponse, ProjectRepoResponse, StatusWithIssues } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { BOARD_WS_EVENT, type BoardWsEventDetail } from "../lib/useBoardEvents.js";
import {
  buildCrossRepoImpact,
  type CrossRepoImpact,
  type ImpactWorkspaceInput,
  type ImpactCell,
  type IntensityBucket,
  type WorkspaceOverlap,
  type WorkspaceRepoDiff,
} from "../lib/crossRepoImpact.js";

/**
 * Cross-Repo Change-Impact Heatmap (#97). File-contention detection is
 * leading-repo-oriented and pairwise; this is the fleet-wide answer to "where is
 * change concentrated right now" — a matrix of active workspaces (rows) × registered
 * repos (cols), each cell coloured by change intensity (files touched / lines changed)
 * for that workspace in that repo. Cross-cutting rows (a workspace touching ≥ 2 repos)
 * and hot columns (change concentrating in a repo) are highlighted, and a cell is
 * marked "contended" when two active workspaces touch overlapping files in the same repo.
 *
 * No new server endpoint: it reuses the same GET data the per-workspace diff panel
 * does — each workspace's `GET /diff` per-repo `stats` for intensity, plus the
 * project's `file-contention` overlaps — and re-aggregates on relevant board events so
 * it stays live without a second WebSocket. The intensity mapping is the pure
 * `crossRepoImpact.ts` module (unit-tested independently).
 */

/** Non-terminal workspace statuses — the ones whose in-flight change we want to see. */
const NON_CLOSED_WORKSPACE_STATUSES = [
  "active",
  "idle",
  "blocked",
  "reviewing",
  "fixing",
  "ready_for_merge",
  "awaiting-plan-approval",
  "error",
].join(",");

/** Board-event reasons that can change a workspace's diff footprint. */
const RELEVANT_REASONS = new Set<string>([
  "board_changed",
  "workspace_created",
  "workspace_setup",
  "workspace_merged",
  "workspace_closed",
  "workspace_updated",
  "session_completed",
  "session_launched",
  "session_stopped",
  "reconnect",
  "poll",
]);

const REFRESH_DEBOUNCE_MS = 1500;

/** Slim projection of GET /api/workspaces?projectId= (see listWorkspacesSlim). */
interface SlimWorkspace {
  id: string;
  issueId: string;
  branch: string | null;
  status: string;
  isDirect: boolean;
}

/** Shape of GET /api/projects/:id/file-contention (see FileContentionPanel). */
interface FileContentionResult {
  contested: Array<{ path: string; workspaces: Array<{ workspaceId: string }> }>;
}

/** Colour + label per intensity bucket (light + dark). `none` is the empty cell. */
const BUCKET_STYLES: Record<IntensityBucket, { label: string; cell: string; swatch: string }> = {
  none: {
    label: "none",
    cell: "text-gray-300 dark:text-gray-700",
    swatch: "bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700",
  },
  low: {
    label: "low",
    cell: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
    swatch: "bg-emerald-200 dark:bg-emerald-800",
  },
  medium: {
    label: "medium",
    cell: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
    swatch: "bg-amber-200 dark:bg-amber-700",
  },
  high: {
    label: "high",
    cell: "bg-orange-200 text-orange-900 dark:bg-orange-900/50 dark:text-orange-200",
    swatch: "bg-orange-300 dark:bg-orange-700",
  },
  severe: {
    label: "severe",
    cell: "bg-red-300 text-red-900 dark:bg-red-900/60 dark:text-red-100",
    swatch: "bg-red-400 dark:bg-red-700",
  },
};

/** All distinct unordered workspace pairs sharing a contested file → overlaps for the pure builder. */
function overlapsFromContention(result: FileContentionResult | null): WorkspaceOverlap[] {
  if (!result) return [];
  const seen = new Set<string>();
  const overlaps: WorkspaceOverlap[] = [];
  for (const file of result.contested) {
    const ids = file.workspaces.map((w) => w.workspaceId);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        const key = `${a}::${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        overlaps.push({ a, b });
      }
    }
  }
  return overlaps;
}

/** Map a workspace's DiffResponse into the per-repo summaries the pure builder consumes. */
function repoDiffsFromDiff(diff: DiffResponse | null, leadingRepoPath: string | null): WorkspaceRepoDiff[] {
  if (!diff) return [];
  if (diff.repos && diff.repos.length > 0) {
    return diff.repos.map((r) => ({
      path: r.path,
      name: r.name,
      filesChanged: r.stats.filesChanged,
      insertions: r.stats.insertions,
      deletions: r.stats.deletions,
    }));
  }
  // Single-repo workspace: the top-level stats belong to the leading repo.
  if (!leadingRepoPath) return [];
  return [
    {
      path: leadingRepoPath,
      filesChanged: diff.stats.filesChanged,
      insertions: diff.stats.insertions,
      deletions: diff.stats.deletions,
    },
  ];
}

/** Load every active workspace's per-repo diff footprint + contention for a project, live. */
function useCrossRepoImpactData(
  projectId: string | null,
  leadingRepoPath: string | null,
  columns: StatusWithIssues[],
): { data: CrossRepoImpact | null; loading: boolean; error: string | null; refresh: () => void } {
  const [data, setData] = useState<CrossRepoImpact | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const requestSeqRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (!projectId) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [additionalRepos, allWorkspaces, contention] = await Promise.all([
          apiFetch<ProjectRepoResponse[]>(`/api/projects/${projectId}/repos`),
          apiFetch<SlimWorkspace[]>(
            `/api/workspaces?projectId=${projectId}&status=${NON_CLOSED_WORKSPACE_STATUSES}`,
          ),
          apiFetch<FileContentionResult>(`/api/projects/${projectId}/file-contention`).catch(() => null),
        ]);
        // A diff is not applicable to direct workspaces.
        const active = allWorkspaces.filter((w) => !w.isDirect);

        const diffs = await Promise.all(
          active.map((w) =>
            apiFetch<DiffResponse>(`/api/workspaces/${w.id}/diff`).catch(() => null),
          ),
        );

        // A newer refresh started while we were awaiting — drop this stale result.
        if (seq !== requestSeqRef.current) return;

        const issueById = new Map(columnsRef.current.flatMap((c) => c.issues).map((i) => [i.id, i]));
        const workspaces: ImpactWorkspaceInput[] = active.map((w, i) => {
          const issue = issueById.get(w.issueId);
          return {
            id: w.id,
            issueId: w.issueId,
            issueNumber: issue?.issueNumber ?? null,
            issueTitle: issue?.title ?? null,
            branch: w.branch,
            status: w.status,
            repoDiffs: repoDiffsFromDiff(diffs[i], leadingRepoPath),
          };
        });

        const repoInputs = [
          ...(leadingRepoPath ? [{ name: null, path: leadingRepoPath, isLeading: true }] : []),
          ...additionalRepos.map((r) => ({ name: r.name, path: r.path, isLeading: false })),
        ];

        setData(buildCrossRepoImpact(repoInputs, workspaces, overlapsFromContention(contention)));
        setLoading(false);
      } catch (err) {
        if (seq !== requestSeqRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
  }, [projectId, leadingRepoPath]);

  // Initial load (and reload when the project/leading repo changes).
  useEffect(() => {
    load();
  }, [load]);

  // Coalesced live refresh on relevant board events (no new WebSocket).
  useEffect(() => {
    if (!projectId) return;
    const onBoardEvent = (e: Event) => {
      const detail = (e as CustomEvent<BoardWsEventDetail>).detail;
      if (!detail || detail.projectId !== projectId) return;
      if (!RELEVANT_REASONS.has(detail.reason)) return;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        load();
      }, REFRESH_DEBOUNCE_MS);
    };
    window.addEventListener(BOARD_WS_EVENT, onBoardEvent);
    return () => {
      window.removeEventListener(BOARD_WS_EVENT, onBoardEvent);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [projectId, load]);

  return { data, loading, error, refresh: load };
}

/** One heatmap cell: intensity-coloured, with a contended ring + a title tooltip. */
function ImpactCellBadge({ cell }: { cell: ImpactCell }) {
  const style = BUCKET_STYLES[cell.bucket];
  if (cell.bucket === "none") {
    return (
      <span
        className={`inline-flex items-center justify-center text-[11px] ${style.cell}`}
        data-testid="impact-cell"
        data-bucket="none"
        title="No committed change in this repo"
      >
        ·
      </span>
    );
  }
  const title =
    `${cell.filesChanged} file${cell.filesChanged === 1 ? "" : "s"}, ` +
    `+${cell.insertions}/-${cell.deletions} (${style.label} intensity)` +
    (cell.contended ? " · contended: overlaps another workspace here" : "");
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${style.cell} ${
        cell.contended ? "ring-2 ring-red-500/70 dark:ring-red-400/70" : ""
      }`}
      data-testid="impact-cell"
      data-bucket={cell.bucket}
      data-contended={cell.contended ? "true" : undefined}
      title={title}
    >
      {cell.contended && (
        <span aria-label="contended" title="Overlaps another workspace in this repo">
          ⚠
        </span>
      )}
      {cell.filesChanged}f·{cell.linesChanged}l
    </span>
  );
}

/** The intensity + marker legend. */
function Legend() {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 border-b border-gray-100 dark:border-gray-800 text-[11px] text-gray-500 dark:text-gray-400"
      data-testid="impact-legend"
    >
      <span className="uppercase tracking-wide text-gray-400 dark:text-gray-500">Intensity</span>
      {(["low", "medium", "high", "severe"] as IntensityBucket[]).map((b) => (
        <span key={b} className="inline-flex items-center gap-1">
          <span className={`inline-block h-3 w-3 rounded ${BUCKET_STYLES[b].swatch}`} />
          {BUCKET_STYLES[b].label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded ring-2 ring-red-500/70 bg-transparent" />
        contended (file overlap)
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-1 rounded-sm bg-violet-500" />
        cross-cutting row (≥ 2 repos)
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="text-orange-600 dark:text-orange-400 font-semibold">hot</span> column
      </span>
    </div>
  );
}

/** Pure presentational heatmap — data in, markup out (no fetching/effects). */
export function CrossRepoImpactHeatmapView({
  data,
  loading,
  error,
}: {
  data: CrossRepoImpact | null;
  loading: boolean;
  error: string | null;
}) {
  if (error && !data) {
    return (
      <div className="flex items-center justify-center h-48 text-red-500 dark:text-red-400 text-sm px-6 text-center">
        {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 dark:text-gray-500 text-sm">
        {loading ? "Loading change-impact…" : "No data."}
      </div>
    );
  }

  const { rows, columns, summary } = data;

  // Degrade gracefully: no repos or no active workspaces → guidance, not an empty grid.
  if (columns.length === 0 || rows.length === 0) {
    return (
      <div className="flex flex-col" data-testid="cross-repo-impact-heatmap">
        <div
          className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-500 gap-2 px-6 text-center"
          data-testid="impact-empty"
        >
          <p className="text-sm font-medium">
            {columns.length === 0 ? "No repos to map" : "No active workspaces"}
          </p>
          <p className="text-xs">
            {columns.length === 0
              ? "Register a repo for this project to see cross-repo change impact."
              : "Start a workspace to see where its change lands across repos."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col" data-testid="cross-repo-impact-heatmap">
      {/* Header summary */}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 border-b border-gray-100 dark:border-gray-800 text-xs"
        data-testid="impact-summary"
      >
        <span className="text-gray-700 dark:text-gray-200">
          <span className="font-semibold">{summary.repoCount}</span> repo{summary.repoCount === 1 ? "" : "s"}
        </span>
        <span className="text-gray-700 dark:text-gray-200">
          <span className="font-semibold">{summary.workspaceCount}</span> workspace
          {summary.workspaceCount === 1 ? "" : "s"}
        </span>
        <span className={summary.crossCuttingCount > 0 ? "text-violet-600 dark:text-violet-400" : "text-gray-400 dark:text-gray-500"}>
          <span className="font-semibold" data-testid="impact-crosscutting-count">{summary.crossCuttingCount}</span> cross-cutting
        </span>
        <span className={summary.hotRepoCount > 0 ? "text-orange-600 dark:text-orange-400" : "text-gray-400 dark:text-gray-500"}>
          <span className="font-semibold" data-testid="impact-hot-count">{summary.hotRepoCount}</span> hot repo
          {summary.hotRepoCount === 1 ? "" : "s"}
        </span>
        <span className={summary.contendedRepoCount > 0 ? "text-red-600 dark:text-red-400" : "text-gray-400 dark:text-gray-500"}>
          <span className="font-semibold" data-testid="impact-contended-count">{summary.contendedRepoCount}</span> contended
        </span>
      </div>

      <Legend />

      {/* Matrix */}
      <div className="overflow-auto">
        <table className="text-sm border-collapse min-w-full" data-testid="cross-repo-impact-matrix">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-surface-raised dark:bg-surface-raised-dark text-left text-xs font-semibold text-gray-500 dark:text-gray-400 px-4 py-2 border-b border-gray-200 dark:border-gray-700">
                Workspace
              </th>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`text-left text-xs px-3 py-2 border-b border-gray-200 dark:border-gray-700 align-bottom ${
                    col.hot ? "bg-orange-50 dark:bg-orange-900/20" : ""
                  }`}
                  title={col.path}
                  data-testid="impact-col-header"
                  data-hot={col.hot ? "true" : undefined}
                  data-contended={col.contended ? "true" : undefined}
                >
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-gray-700 dark:text-gray-200 truncate max-w-[120px]">{col.label}</span>
                    {col.isLeading && (
                      <span className="text-[10px] font-medium px-1 py-0.5 rounded bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">
                        leading
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    {col.hot && (
                      <span className="text-[10px] font-semibold text-orange-600 dark:text-orange-400" title={`${col.touchingWorkspaceCount} workspaces · ${col.totalLinesChanged} lines`}>
                        hot
                      </span>
                    )}
                    {col.contended && (
                      <span className="text-[10px] font-medium text-red-600 dark:text-red-400" title="File overlap between workspaces in this repo">
                        contended
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.workspaceId}
                className={`hover:bg-gray-50 dark:hover:bg-gray-800/50 ${
                  row.crossCutting ? "border-l-4 border-l-violet-500 bg-violet-50/30 dark:bg-violet-900/10" : "border-l-4 border-l-transparent"
                }`}
                data-testid="impact-row"
                data-crosscutting={row.crossCutting ? "true" : undefined}
              >
                <td
                  className="sticky left-0 z-10 bg-surface-raised dark:bg-surface-raised-dark px-4 py-2 border-b border-gray-100 dark:border-gray-800 whitespace-nowrap"
                  title={`${row.issueTitle ?? ""}\n${row.branch ?? ""}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-mono text-gray-700 dark:text-gray-200">
                      {row.issueNumber !== null ? `#${row.issueNumber}` : "—"}
                    </span>
                    {row.crossCutting && (
                      <span
                        className="text-[10px] font-medium px-1 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                        title={`Touches ${row.reposTouched} repos`}
                      >
                        cross-cutting
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-gray-400 dark:text-gray-500 font-mono truncate max-w-[160px]">
                    {row.branch ?? ""}
                  </div>
                </td>
                {row.cells.map((cell) => (
                  <td
                    key={cell.repoKey}
                    className="px-3 py-2 border-b border-gray-100 dark:border-gray-800"
                  >
                    <ImpactCellBadge cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface CrossRepoImpactHeatmapProps {
  projectId: string | null;
  /** The project's leading repo path (ProjectResponse.repoPath) — the leading column. */
  leadingRepoPath: string | null;
  columns: StatusWithIssues[];
}

/** Self-fetching, live-updating cross-repo change-impact heatmap for the Multi-Repo Monitor. */
export function CrossRepoImpactHeatmap({ projectId, leadingRepoPath, columns }: CrossRepoImpactHeatmapProps) {
  const { data, loading, error, refresh } = useCrossRepoImpactData(projectId, leadingRepoPath, columns);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 dark:text-gray-500 text-sm">
        No active project selected.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-end px-4 py-1.5 border-b border-gray-100 dark:border-gray-800">
        <button
          onClick={refresh}
          disabled={loading}
          title="Refresh now"
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40 text-sm px-1.5 py-0.5 rounded"
        >
          ↻
        </button>
      </div>
      <CrossRepoImpactHeatmapView data={data} loading={loading} error={error} />
    </div>
  );
}
