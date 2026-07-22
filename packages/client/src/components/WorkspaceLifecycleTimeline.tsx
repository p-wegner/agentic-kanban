import { useEffect, useState } from "react";
import type { RepoMergeStatusResponse, WorkspaceResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import type { SessionInfo } from "./WorkspaceCard.js";
import {
  deriveWorkspaceLifecycle,
  formatPhaseDuration,
  PHASE_LABELS,
  type LifecyclePhaseKind,
  type RepoMergeMarker,
  type WorkspaceLifecycle,
} from "../lib/workspaceLifecyclePhases.js";

/** Per-phase segment colour (bar fill + text). */
const PHASE_COLORS: Record<LifecyclePhaseKind, string> = {
  created: "bg-gray-300 dark:bg-gray-600",
  setup: "bg-amber-300 dark:bg-amber-500/70",
  building: "bg-blue-400 dark:bg-blue-500/80",
  review: "bg-violet-400 dark:bg-violet-500/80",
};

const TERMINAL_LABEL: Record<WorkspaceLifecycle["terminal"], string> = {
  merged: "merged",
  closed: "closed",
  ongoing: "in flight",
};

/**
 * Presentational horizontal lifecycle timeline (#96): one proportional bar of
 * phase segments (created → setup → building → review) with elapsed durations,
 * plus a terminal marker (merged / closed / in flight). For a multi-repo
 * workspace the per-repo merge markers are overlaid on the merge endpoint so an
 * operator can see, at a glance, where a workspace has spent its time and which
 * repos have actually landed. Pure over its `lifecycle` prop — see
 * {@link deriveWorkspaceLifecycle}.
 */
export function WorkspaceLifecycleTimelineView({ lifecycle }: { lifecycle: WorkspaceLifecycle }) {
  const { phases, totalMs, startMs, terminal, repoMarkers } = lifecycle;
  if (phases.length === 0 || totalMs <= 0) {
    return (
      <div className="text-[11px] text-gray-400 dark:text-gray-500" data-testid="lifecycle-timeline-empty">
        Not enough activity yet to chart a lifecycle.
      </div>
    );
  }

  const pct = (ms: number) => (ms / totalMs) * 100;

  return (
    <div className="space-y-2" data-testid="lifecycle-timeline">
      {/* Proportional segmented bar. */}
      <div
        className="relative flex h-5 w-full overflow-hidden rounded bg-gray-100 dark:bg-gray-800"
        role="img"
        aria-label={`Workspace lifecycle: ${phases
          .map((p) => `${PHASE_LABELS[p.kind]} ${formatPhaseDuration(p.durationMs)}`)
          .join(", ")}; ${TERMINAL_LABEL[terminal]}`}
      >
        {phases.map((p, i) => (
          <div
            key={`${p.kind}-${i}`}
            className={`${PHASE_COLORS[p.kind]} ${p.ongoing ? "cell-flash" : ""} h-full`}
            style={{ width: `${pct(p.durationMs)}%` }}
            title={`${PHASE_LABELS[p.kind]} · ${formatPhaseDuration(p.durationMs)}${p.ongoing ? " (ongoing)" : ""}`}
            data-testid="lifecycle-segment"
            data-phase={p.kind}
            data-ongoing={p.ongoing ? "true" : undefined}
          />
        ))}
      </div>

      {/* Legend: one chip per phase with its duration. */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {phases.map((p, i) => (
          <span key={`${p.kind}-${i}`} className="flex items-center gap-1" data-testid="lifecycle-legend-item">
            <span className={`inline-block h-2 w-2 rounded-sm ${PHASE_COLORS[p.kind]}`} />
            <span className="text-gray-600 dark:text-gray-300">{PHASE_LABELS[p.kind]}</span>
            <span className="font-mono text-gray-400 dark:text-gray-500">{formatPhaseDuration(p.durationMs)}</span>
            {p.ongoing && <span className="text-green-600 dark:text-green-400">•</span>}
          </span>
        ))}
        <span
          className="flex items-center gap-1 text-gray-500 dark:text-gray-400"
          data-testid="lifecycle-terminal"
          data-terminal={terminal}
        >
          <span className="text-gray-300 dark:text-gray-600">→</span>
          {terminal === "merged" && <span className="text-green-600 dark:text-green-400 font-medium">merged</span>}
          {terminal === "closed" && <span className="text-gray-500 dark:text-gray-400 font-medium">closed</span>}
          {terminal === "ongoing" && <span className="text-blue-600 dark:text-blue-400 font-medium">in flight</span>}
          <span className="font-mono text-gray-400 dark:text-gray-500">total {formatPhaseDuration(totalMs)}</span>
        </span>
      </div>

      {/* Per-repo merge markers overlaid on the merge endpoint (multi-repo only). */}
      {repoMarkers.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[10px]" data-testid="lifecycle-repo-markers">
          <span className="text-gray-400 dark:text-gray-500">Repos:</span>
          {repoMarkers.map((m) => (
            <RepoMarkerBadge key={m.name} marker={m} />
          ))}
        </div>
      )}
    </div>
  );
}

function RepoMarkerBadge({ marker }: { marker: RepoMergeMarker }) {
  const cls = marker.merged
    ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
    : marker.stranded
      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
      : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400";
  const state = marker.merged ? "merged" : marker.stranded ? "stranded" : "pending";
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono font-medium ${cls}`}
      data-testid="lifecycle-repo-marker"
      data-repo-state={state}
      title={`${marker.name}: ${state}`}
    >
      {marker.name} {marker.merged ? "✓" : marker.stranded ? "↑" : "·"}
    </span>
  );
}

/**
 * Self-contained lifecycle timeline for a workspace: derives phases from the
 * workspace's own timestamps + its sessions (already in hand in the workspace
 * detail), fetches per-repo merge markers for multi-repo workspaces, and ticks
 * once a second so an in-flight phase's duration stays live.
 */
export function WorkspaceLifecycleTimeline({
  workspace,
  sessions,
}: {
  workspace: WorkspaceResponse;
  sessions: SessionInfo[];
}) {
  // Re-render every second while the workspace is still in flight so the ongoing
  // phase (extended to `now`) keeps growing.
  const [nowTick, setNowTick] = useState(() => Date.now());
  const inFlight = !workspace.mergedAt && !workspace.closedAt && workspace.status !== "closed";
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [inFlight]);

  // Fetch per-repo merge markers for multi-repo (non-direct) workspaces. A 400
  // (direct workspace) or 404 (single-repo / older server) just leaves the
  // markers empty, so the timeline renders single-repo.
  const [repoMarkers, setRepoMarkers] = useState<RepoMergeMarker[] | undefined>(undefined);
  useEffect(() => {
    if (workspace.isDirect) return;
    let cancelled = false;
    apiFetch<RepoMergeStatusResponse>(`/api/workspaces/${workspace.id}/repo-merge-status`)
      .then((s) => {
        if (cancelled) return;
        // Only overlay markers for genuinely multi-repo workspaces.
        if (s.repos.length <= 1) return;
        setRepoMarkers(
          s.repos.map((r) => ({ name: r.name ?? "leading", merged: r.merged, stranded: r.stranded })),
        );
      })
      .catch(() => { /* single-repo / direct / older server — no markers */ });
    return () => { cancelled = true; };
  }, [workspace.id, workspace.isDirect, workspace.mergedAt ?? workspace.status]);

  const lifecycle = deriveWorkspaceLifecycle(
    {
      createdAt: workspace.createdAt,
      mergedAt: workspace.mergedAt,
      closedAt: workspace.closedAt,
      setup: workspace.latestSetup
        ? { startedAt: workspace.latestSetup.startedAt, endedAt: workspace.latestSetup.endedAt }
        : null,
      sessions: sessions.map((s) => ({
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        triggerType: s.triggerType,
      })),
      repoMarkers,
    },
    inFlight ? nowTick : Date.now(),
  );

  return (
    <div
      className="rounded border border-gray-200 dark:border-gray-700 p-2"
      data-testid="workspace-lifecycle-timeline"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1.5 text-[11px] font-semibold text-gray-500 dark:text-gray-400">Lifecycle</div>
      <WorkspaceLifecycleTimelineView lifecycle={lifecycle} />
    </div>
  );
}
