import { useState, useEffect, useCallback } from "react";
import { apiFetch, apiPost, apiDelete } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { startStaggeredPoll } from "../lib/pollScheduler.js";

/** Mirrors the WorkerView the /api/workers list route returns. */
interface WorkerRow {
  id: string;
  name: string;
  os: string | null;
  arch: string | null;
  labels: string | null;
  providers: string | null;
  maxConcurrency: number;
  status: string;
  effectiveStatus: "online" | "draining" | "offline";
  lastHeartbeatAt: string | null;
  createdAt: string;
}

interface WorkerFleetPanelProps {
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  online: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  draining: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  offline: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
};

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ pairingToken: string; expiresAt: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch<{ workers: WorkerRow[] }>("/api/workers")
      .then((result) => {
        setWorkers(result.workers);
        setLoading(false);
      })
      .catch((err) => {
        setError(errorMessage(err));
        setLoading(false);
      });
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
    if (!confirm(`Revoke worker "${worker.name}"? Its token stops working immediately.`)) return;
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

  const online = workers?.filter((w) => w.effectiveStatus === "online") ?? [];
  const capacity = online.reduce((sum, w) => sum + w.maxConcurrency, 0);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-[min(620px,100vw)] bg-surface-raised dark:bg-surface-raised-dark shadow-xl flex flex-col animate-slide-in-right">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <FleetIcon />
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 heading-serif">Worker Fleet</h2>
            {!loading && workers && (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {workers.length === 0
                  ? "No workers paired"
                  : `${online.length}/${workers.length} online · ${capacity} slot${capacity === 1 ? "" : "s"}`}
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
              </div>
            )}
          </div>

          {workers && workers.length === 0 && !loading && (
            <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">
              No workers are paired with this board yet.
            </div>
          )}

          {workers?.map((worker) => {
            const labels = parseList(worker.labels);
            const providers = parseList(worker.providers);
            return (
              <div key={worker.id} className="rounded border border-gray-200 dark:border-gray-700 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink dark:text-stone-100 truncate">{worker.name}</span>
                      <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_COLORS[worker.effectiveStatus] ?? STATUS_COLORS.offline}`}>
                        {worker.effectiveStatus}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {worker.os ?? "unknown OS"}
                      {worker.arch ? ` · ${worker.arch}` : ""} · up to {worker.maxConcurrency} session
                      {worker.maxConcurrency === 1 ? "" : "s"} ·{" "}
                      {worker.lastHeartbeatAt ? `heartbeat ${formatRelativeTime(worker.lastHeartbeatAt)}` : "never seen"}
                    </div>
                    {(labels.length > 0 || providers.length > 0) && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {providers.map((p) => (
                          <span key={`p-${p}`} className="rounded bg-accent-50 dark:bg-accent-900/40 px-1.5 py-0.5 text-xs text-accent-700 dark:text-accent-300">
                            {p}
                          </span>
                        ))}
                        {labels.map((l) => (
                          <span key={`l-${l}`} className="rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-300">
                            {l}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => revoke(worker)}
                    disabled={busyId === worker.id}
                    className="shrink-0 rounded border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
