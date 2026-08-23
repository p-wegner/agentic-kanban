import { useState, useEffect, useMemo, useCallback } from "react";
import { apiFetch, apiPost, apiDelete } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { startStaggeredPoll } from "../lib/pollScheduler.js";
import { WorkerEventTimeline } from "./WorkerEventTimeline.js";
import { WorkerDispatchPrefs } from "./WorkerDispatchPrefs.js";
import { useActiveProjectPreferenceQuery, useProjectsQuery } from "../hooks/useBoardDataQueries.js";

/**
 * Mirrors one row of the enriched `GET /api/workers` response (#774).
 *
 * The route used to answer the raw `workers` DB row, so this panel had no `connected` and
 * no `load`, and derived "capacity" as the sum of `maxConcurrency` over heartbeat-online
 * workers — TOTAL capacity rendered as free capacity, counting a worker whose heartbeat was
 * fresh but whose WebSocket the board did not hold. The route now serves the same
 * `describeFleet` computation the placement explanation uses, so this panel and
 * `worker explain` cannot give different answers.
 */
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
}

interface FleetSummary {
  registered: number;
  online: number;
  connected: number;
  eligible: number;
  freeSlots: number;
  provider: string;
  requiredLabels: string[];
}

/** One held incoming ref, from the existing `GET /api/workers/incoming` (#752). */
interface IncomingRefRow {
  projectId: string;
  projectName: string;
  branch: string;
  sha: string;
  heldReason: string | null;
  ageMs: number;
  stale: boolean;
}

interface WorkerFleetPanelProps {
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  online: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  draining: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  offline: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
};

function FleetIcon() {
  return (
    <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="3" width="20" height="6" rx="1" />
      <rect x="2" y="15" width="20" height="6" rx="1" />
      <path d="M6 6h.01M6 18h.01" />
    </svg>
  );
}

export function WorkerFleetPanel({ onClose }: WorkerFleetPanelProps) {
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null);
  const [fleet, setFleet] = useState<FleetSummary | null>(null);
  const [incoming, setIncoming] = useState<IncomingRefRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ pairingToken: string; expiresAt: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /**
   * Which project the dispatch preferences below apply to. Read here rather than taken as a
   * prop: the overlay that renders this panel is not #774's file to change. It goes through the
   * shared active-project query rather than a raw preference fetch (#811) — one cache key
   * for the preference, so a project switch elsewhere on the board reaches this panel
   * instead of leaving it on a stale answer for as long as it stays open.
   */
  const { data: activePreference } = useActiveProjectPreferenceQuery();
  const { data: allProjects } = useProjectsQuery();
  const project = useMemo(() => {
    const activeId = activePreference?.projectId;
    if (!activeId) return null;
    const match = allProjects?.find((p) => p.id === activeId);
    return match ? { id: match.id, name: match.name } : null;
  }, [activePreference?.projectId, allProjects]);

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
    // The held-ref inventory comes from #752's endpoint rather than being recomputed here:
    // a ref sitting in the staging namespace is a fleet problem an operator must SEE, and
    // it was previously visible only via curl.
    apiFetch<{ refs: IncomingRefRow[] }>("/api/workers/incoming")
      .then((r) => setIncoming(r.refs))
      .catch(() => setIncoming(null));
  }, []);

  useEffect(() => {
    load();
    // Heartbeat staleness is time-derived, so refresh while the panel is open.
    // #518: staggered + visibility-gated like the other background pollers.
    const poll = startStaggeredPoll(load, 15000);
    return () => poll.stop();
  }, [load]);

  const mintPairingToken = async () => {
    try {
      setPairing(await apiPost<{ pairingToken: string; expiresAt: string }>("/api/workers/pairing-token"));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

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

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-[min(620px,100vw)] bg-surface-raised dark:bg-surface-raised-dark shadow-xl flex flex-col animate-slide-in-right">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <FleetIcon />
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 heading-serif">Worker Fleet</h2>
            {!loading && fleet && (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {fleet.registered === 0
                  ? "No workers paired"
                  // FREE slots, not the sum of maxConcurrency: the old line read as spare
                  // capacity even when every slot was busy.
                  : `${fleet.connected}/${fleet.registered} connected · ${fleet.freeSlots} free slot${fleet.freeSlots === 1 ? "" : "s"}`}
              </span>
            )}
            {loading && <span className="text-sm text-gray-400 dark:text-gray-500">Loading…</span>}
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

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
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
              {fleet.freeSlots} free slot{fleet.freeSlots === 1 ? "" : "s"}. Ask{" "}
              <code>worker explain &lt;issue&gt;</code> why a specific ticket did not dispatch.
            </div>
          )}

          <div className="rounded border border-gray-200 dark:border-gray-700 p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-ink dark:text-stone-100">Pair a new worker</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Mint a single-use token, then run the worker on the other machine.
                </div>
              </div>
              <button
                onClick={mintPairingToken}
                className="shrink-0 rounded bg-accent-600 px-3 py-1.5 text-sm text-white hover:bg-accent-700"
              >
                Mint token
              </button>
            </div>
            {pairing && (
              <div className="mt-3 space-y-1">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Expires {formatRelativeTime(pairing.expiresAt)} — single use.
                </div>
                <code className="block break-all rounded bg-gray-100 dark:bg-gray-800 px-2 py-1.5 text-xs text-ink dark:text-stone-100">
                  agentic-kanban worker start --board &lt;board-url&gt; --token {pairing.pairingToken}
                </code>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  Then, on that machine:{" "}
                  <code>agentic-kanban worker doctor --board &lt;board-url&gt;</code> — checks the
                  fleet port, the WebSocket upgrade, the git transport and the provider login.
                </div>
              </div>
            )}
          </div>

          {/* #774 item 5 — pairing a worker is only half of opting a project in. */}
          {project && <WorkerDispatchPrefs projectId={project.id} projectName={project.name} onSaved={load} />}

          {incoming && incoming.length > 0 && (
            <div className="rounded border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/20 p-3">
              <div className="text-sm font-medium text-amber-800 dark:text-amber-200">
                {incoming.length} held incoming ref{incoming.length === 1 ? "" : "s"}
              </div>
              <div className="text-xs text-amber-700 dark:text-amber-300 mb-2">
                A worker pushed these but the board has not fast-forwarded them. Never forced — land
                or discard each one deliberately.
              </div>
              <ul className="space-y-1">
                {incoming.map((ref) => (
                  <li key={`${ref.projectId}:${ref.branch}`} className="text-xs text-amber-800 dark:text-amber-200">
                    <code>{ref.branch}</code> in {ref.projectName} — {ref.heldReason ?? "landable"}
                    {ref.stale && " · stale"}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {workers && workers.length === 0 && !loading && (
            <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">
              No workers are paired with this board yet.
            </div>
          )}

          {workers?.map((worker) => {
            const expanded = expandedId === worker.id;
            return (
              <div key={worker.id} className="rounded border border-gray-200 dark:border-gray-700 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink dark:text-stone-100 truncate">{worker.name}</span>
                      <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_COLORS[worker.effectiveStatus] ?? STATUS_COLORS.offline}`}>
                        {worker.effectiveStatus}
                      </span>
                      {/* "heartbeat fresh but no WebSocket" is one of the five eligibility
                          failures that all printed the same "no eligible worker" before. */}
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
                      {/* Needed to revoke by id from the CLI, and to correlate with
                          `sessions.worker_id` in a placement listing. */}
                      id <code>{worker.id}</code> · protocol {worker.protocolVersion ?? "?"} · build{" "}
                      {worker.workerVersion ?? "?"}
                    </div>
                    {!worker.eligible && worker.ineligibleReason && (
                      <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                        Not a candidate: {worker.ineligibleReason}
                      </div>
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
      </div>
    </div>
  );
}
