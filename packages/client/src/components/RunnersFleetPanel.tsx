import { useState, useEffect, useMemo, useCallback } from "react";
import { apiFetch, apiDelete } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { formatBuildFreshness, type WorkerBuildFreshness } from "@agentic-kanban/shared/lib/worker-build-freshness";
import { startStaggeredPoll } from "../lib/pollScheduler.js";
import { BOARD_WS_EVENT, type BoardWsEventDetail } from "../lib/useBoardEvents.js";
import { WorkerEventTimeline } from "./WorkerEventTimeline.js";
import { WorkerDispatchPrefs } from "./WorkerDispatchPrefs.js";
import { useActiveProjectPreferenceQuery, useProjectsQuery } from "../hooks/useBoardDataQueries.js";

/** Mirrors one row of the enriched `GET /api/workers` response (#774). */
interface WorkerRow {
  id: string;
  workerId: string;
  name: string;
  os: string | null;
  arch: string | null;
  labels: string[];
  providers: string[];
  maxConcurrency: number;
  status: string;
  effectiveStatus: "online" | "draining" | "offline";
  lastHeartbeatAt: string | null;
  connected: boolean;
  load: number;
  freeSlots: number;
  eligible: boolean;
  ineligibleReason: string | null;
  sharesFilesystem: boolean;
  assignedSessionIds: string[];
  protocolVersion?: number;
  workerVersion?: string;
  buildFreshness?: WorkerBuildFreshness;
}

interface FleetSummary {
  registered: number;
  online: number;
  connected: number;
  eligible: number;
  freeSlots: number;
  provider: string;
  requiredLabels: string[];
  boardWorkerVersion?: string | null;
}

/** One recent placement, from `GET /api/workers/placements` — used here only for the
 *  "current work" line on a worker card. */
interface PlacementRow {
  workspaceId: string;
  branch: string | null;
  issueNumber: number | null;
  issueTitle: string | null;
  status: string;
  workerId: string | null;
  startedAt: string;
  endedAt: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  online: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  draining: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  offline: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
};

interface RunnersFleetPanelProps {
  projectId: string | null;
}

/**
 * The Runners tab (#1089, follow-up to #1087): per-worker identity, status, capabilities,
 * load, and "current work" — what `WorkerFleetPanel` used to show, minus the pairing/mint
 * flow (moved to the Connect tab) and the held-refs list (moved to the Git Transport tab).
 */
export function RunnersFleetPanel({ projectId }: RunnersFleetPanelProps) {
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null);
  const [fleet, setFleet] = useState<FleetSummary | null>(null);
  const [placements, setPlacements] = useState<PlacementRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: activePreference } = useActiveProjectPreferenceQuery();
  const { data: allProjects } = useProjectsQuery();
  const project = useMemo(() => {
    const activeId = projectId ?? activePreference?.projectId;
    if (!activeId) return null;
    const match = allProjects?.find((p) => p.id === activeId);
    return match ? { id: match.id, name: match.name } : null;
  }, [projectId, activePreference?.projectId, allProjects]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch<{ workers: WorkerRow[]; fleet: FleetSummary }>("/api/workers")
      .then((result) => {
        setWorkers(result.workers);
        setFleet(result.fleet);
        setLoading(false);
      })
      .catch((err) => {
        setError(errorMessage(err));
        setLoading(false);
      });
    // Remote-only, running sessions: enough to answer "what is this worker doing right now"
    // without pulling the whole placement history.
    apiFetch<{ placements: PlacementRow[] }>("/api/workers/placements?remoteOnly=true&limit=200")
      .then((r) => setPlacements(r.placements))
      .catch(() => setPlacements(null));
  }, []);

  useEffect(() => {
    load();
    const poll = startStaggeredPoll(load, 15000);
    return () => poll.stop();
  }, [load]);

  // Live updates (#1089): refetch immediately on the fleet-wide WS reason instead of waiting
  // for the next poll tick. The 15s poll above stays as the fallback for a missed/late socket.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<BoardWsEventDetail>).detail;
      if (detail?.reason === "workers_changed") load();
    };
    window.addEventListener(BOARD_WS_EVENT, handler);
    return () => window.removeEventListener(BOARD_WS_EVENT, handler);
  }, [load]);

  const revoke = async (worker: WorkerRow) => {
    if (!confirm(`Revoke worker "${worker.name}"? Its token stops working immediately, and its event timeline is deleted.`)) return;
    setBusyId(worker.id);
    try {
      await apiDelete(`/api/workers/${worker.id}`);
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const currentWorkFor = (workerId: string): PlacementRow[] => {
    if (!placements) return [];
    return placements.filter((p) => p.workerId === workerId && p.status === "running" && !p.endedAt);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          {!loading && fleet && (
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {fleet.registered === 0
                ? "No workers paired"
                : `${fleet.connected}/${fleet.registered} connected · ${fleet.freeSlots} free slot${fleet.freeSlots === 1 ? "" : "s"}`}
            </span>
          )}
          {loading && <span className="text-sm text-gray-400 dark:text-gray-500">Loading…</span>}
        </div>
        <button
          onClick={load}
          disabled={loading}
          title="Refresh"
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40 text-sm px-1.5 py-0.5 rounded"
        >
          ↻
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {fleet && fleet.registered > 0 && (
        <div className="rounded border border-gray-200 dark:border-gray-700 p-3 text-xs text-gray-600 dark:text-gray-300">
          <span className="font-medium text-ink dark:text-stone-100">Eligibility</span> for{" "}
          <code>{fleet.provider}</code>
          {fleet.requiredLabels.length > 0 && <> with labels [{fleet.requiredLabels.join(",")}]</>}:{" "}
          {fleet.eligible} of {fleet.registered} worker{fleet.registered === 1 ? "" : "s"},{" "}
          {fleet.freeSlots} free slot{fleet.freeSlots === 1 ? "" : "s"}. See the Dispatch Log tab's
          "Explain" box for why a specific ticket did not dispatch.
        </div>
      )}

      {project && <WorkerDispatchPrefs projectId={project.id} projectName={project.name} onSaved={load} />}

      {workers && workers.length === 0 && !loading && (
        <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">
          No workers are paired with this board yet — see the Connect tab.
        </div>
      )}

      {workers?.map((worker) => {
        const expanded = expandedId === worker.id;
        const currentWork = currentWorkFor(worker.id);
        return (
          <div key={worker.id} className="rounded border border-gray-200 dark:border-gray-700 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink dark:text-stone-100 truncate">{worker.name}</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_COLORS[worker.effectiveStatus] ?? STATUS_COLORS.offline}`}>
                    {worker.effectiveStatus}
                  </span>
                  {!worker.connected && (
                    <span className="rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-xs text-gray-500 dark:text-gray-400">
                      no socket
                    </span>
                  )}
                  {worker.eligible && (
                    <span className="rounded bg-green-100 dark:bg-green-900/40 px-1.5 py-0.5 text-xs text-green-700 dark:text-green-300">
                      eligible
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {worker.os ?? "unknown OS"}
                  {worker.arch ? ` · ${worker.arch}` : ""} · {worker.load}/{worker.maxConcurrency} in use (
                  {worker.freeSlots} free) ·{" "}
                  {worker.lastHeartbeatAt ? `heartbeat ${formatRelativeTime(worker.lastHeartbeatAt)}` : "never seen"}
                </div>
                <div className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                  id <code>{worker.id}</code> · protocol {worker.protocolVersion ?? "?"} · build{" "}
                  {worker.workerVersion ?? "?"}
                  {(() => {
                    const label = formatBuildFreshness(worker.buildFreshness, fleet?.boardWorkerVersion);
                    if (!label) return null;
                    const tone =
                      worker.buildFreshness === "behind-board"
                        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                        : "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400";
                    return <span className={`ml-1.5 rounded px-1.5 py-0.5 text-xs ${tone}`}>{label}</span>;
                  })()}
                </div>
                {!worker.eligible && worker.ineligibleReason && (
                  <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                    Not a candidate: {worker.ineligibleReason}
                  </div>
                )}
                {currentWork.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    {currentWork.map((p) => (
                      <div key={p.workspaceId} className="text-xs text-accent-700 dark:text-accent-300">
                        {p.issueNumber ? `#${p.issueNumber} ${p.issueTitle ?? ""}` : (p.branch ?? p.workspaceId)} — started{" "}
                        {formatRelativeTime(p.startedAt)}
                      </div>
                    ))}
                  </div>
                ) : (
                  worker.load === 0 && (
                    <div className="mt-2 text-xs text-gray-400 dark:text-gray-500">idle</div>
                  )
                )}
                {(worker.labels.length > 0 || worker.providers.length > 0) && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {worker.providers.map((p) => (
                      <span key={`p-${p}`} className="rounded bg-accent-50 dark:bg-accent-900/40 px-1.5 py-0.5 text-xs text-accent-700 dark:text-accent-300">
                        {p}
                      </span>
                    ))}
                    {worker.labels.map((l) => (
                      <span key={`l-${l}`} className="rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-300">
                        {l}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <button
                  onClick={() => setExpandedId(expanded ? null : worker.id)}
                  className="rounded border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  {expanded ? "Hide history" : "History"}
                </button>
                <button
                  onClick={() => revoke(worker)}
                  disabled={busyId === worker.id}
                  className="rounded border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40"
                >
                  Revoke
                </button>
              </div>
            </div>
            {expanded && <WorkerEventTimeline workerId={worker.id} />}
          </div>
        );
      })}
    </div>
  );
}
