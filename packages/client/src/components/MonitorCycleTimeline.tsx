import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import type { OrchestratorStatus } from "../hooks/useOrchestrator.js";

export interface MonitorCycleSummary {
  cycleId: string;
  startedAt: string;
  endedAt: string | null;
  healthState: "healthy" | "warning" | "error";
  mergedCount: number;
  startedCount: number;
  refillCount: number;
  needsAttentionCount: number;
  apiRestarted: boolean;
  smokeCheckFailed: boolean;
  issueNumbers: number[];
  label: string;
}

type TimelineTab = "in-app" | "orchestrator";

interface MonitorCycleTimelineProps {
  projectId: string | null;
  onSelectIssue?: (issueNumber: number) => void;
  onSwitchToEvents?: () => void;
}

const HEALTH_STATE_CONFIG = {
  healthy: {
    dot: "bg-emerald-500",
    row: "",
    badge: "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300",
    label: "Healthy",
  },
  warning: {
    dot: "bg-amber-500",
    row: "bg-amber-50/30 dark:bg-amber-950/10",
    badge: "bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300",
    label: "Warning",
  },
  error: {
    dot: "bg-red-500 animate-pulse",
    row: "bg-red-50/40 dark:bg-red-950/20",
    badge: "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300",
    label: "Error",
  },
};

function formatAge(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function CountPill({ value, label, color }: { value: number; label: string; color: string }) {
  if (value === 0) return null;
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] font-medium ${color}`}
      title={`${value} ${label}`}
    >
      {value} {label}
    </span>
  );
}

function parseCycleLine(line: string): { age: string | null; text: string } {
  const m = line.match(/^(\S+)\s*\|\s*(.*)/s);
  if (!m) return { age: null, text: line };
  const candidate = m[1];
  const d = new Date(candidate);
  if (Number.isNaN(d.getTime())) return { age: null, text: line };
  return { age: candidate, text: m[2].trim() };
}

export function MonitorCycleTimeline({ projectId, onSelectIssue, onSwitchToEvents }: MonitorCycleTimelineProps) {
  const [tab, setTab] = useState<TimelineTab>("in-app");
  const [cycles, setCycles] = useState<MonitorCycleSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(15);
  const [expandedCycle, setExpandedCycle] = useState<string | null>(null);

  const [orchestrator, setOrchestrator] = useState<OrchestratorStatus | null>(null);
  const [orchLoading, setOrchLoading] = useState(false);
  const [orchError, setOrchError] = useState<string | null>(null);

  const fetchCycles = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<MonitorCycleSummary[]>(
        `/api/projects/${projectId}/monitor-cycles?limit=${limit}`,
      );
      setCycles(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load cycle timeline");
    } finally {
      setLoading(false);
    }
  }, [projectId, limit]);

  const fetchOrchestrator = useCallback(async () => {
    if (!projectId) return;
    setOrchLoading(true);
    setOrchError(null);
    try {
      const data = await apiFetch<OrchestratorStatus>(`/api/projects/${projectId}/orchestrator`);
      setOrchestrator(data);
    } catch (e) {
      setOrchError(e instanceof Error ? e.message : "Failed to load orchestrator status");
    } finally {
      setOrchLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchCycles();
  }, [fetchCycles]);

  useEffect(() => {
    if (tab === "orchestrator") {
      void fetchOrchestrator();
    }
  }, [tab, fetchOrchestrator]);

  if (!projectId) return null;

  const isOrchestratorTab = tab === "orchestrator";
  const currentLoading = isOrchestratorTab ? orchLoading : loading;
  const currentRefresh = isOrchestratorTab ? fetchOrchestrator : fetchCycles;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-gray-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-indigo-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
          </svg>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Cycle Health Timeline</h2>
          {!isOrchestratorTab && cycles.length > 0 && (
            <span className="text-xs bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 px-2 py-0.5 rounded-full font-medium">
              {cycles.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Tab switcher: In-App / Orchestrator */}
          <div className="flex items-center gap-1 border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
            <button
              className={`px-2 py-1 text-xs ${tab === "in-app" ? "bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 font-medium" : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
              onClick={() => setTab("in-app")}
              title="In-app monitor cycles (database-backed)"
            >
              In-app
            </button>
            <button
              className={`px-2 py-1 text-xs ${tab === "orchestrator" ? "bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 font-medium" : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
              onClick={() => setTab("orchestrator")}
              title="Out-of-process orchestrator loop (state.md)"
            >
              Orchestrator
            </button>
          </div>
          {onSwitchToEvents && (
            <div className="flex items-center gap-1">
              <button
                className="px-2 py-1 text-xs rounded bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 font-medium"
                disabled
              >
                Timeline
              </button>
              <button
                className="px-2 py-1 text-xs rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                onClick={onSwitchToEvents}
              >
                Events
              </button>
            </div>
          )}
          {!isOrchestratorTab && (
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300"
            >
              <option value={10}>Last 10</option>
              <option value={15}>Last 15</option>
              <option value={25}>Last 25</option>
            </select>
          )}
          <button
            onClick={() => void currentRefresh()}
            disabled={currentLoading}
            className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 disabled:opacity-40"
            title="Refresh"
          >
            <svg className={`w-3.5 h-3.5 ${currentLoading ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {/* Orchestrator tab */}
        {isOrchestratorTab && (
          <OrchestratorCycleList
            orchestrator={orchestrator}
            loading={orchLoading}
            error={orchError}
          />
        )}

        {/* In-app tab */}
        {!isOrchestratorTab && error && (
          <div className="m-4 p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {!isOrchestratorTab && !loading && !error && cycles.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-600 text-sm gap-2">
            <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
            </svg>
            <p>No monitor cycles recorded yet</p>
            <p className="text-xs text-center max-w-xs">
              Cycles appear here once the monitor runs. Enable auto-monitor in the Monitor sidebar to start recording.
            </p>
          </div>
        )}

        {!isOrchestratorTab && cycles.length > 0 && (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {cycles.map((cycle) => {
              const cfg = HEALTH_STATE_CONFIG[cycle.healthState];
              const isExpanded = expandedCycle === cycle.cycleId;
              const hasHighlights = cycle.apiRestarted || cycle.smokeCheckFailed;

              return (
                <div key={cycle.cycleId}>
                  <div
                    className={`px-4 py-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900 ${cfg.row}`}
                    onClick={() => setExpandedCycle(isExpanded ? null : cycle.cycleId)}
                  >
                    <div className="flex items-center gap-3">
                      {/* Health dot */}
                      <span className={`shrink-0 w-2 h-2 rounded-full ${cfg.dot}`} title={cfg.label} />

                      {/* Timestamp */}
                      <span className="text-[11px] font-mono text-gray-500 dark:text-gray-400 whitespace-nowrap shrink-0">
                        {formatTime(cycle.startedAt)}
                      </span>

                      {/* Counts */}
                      <div className="flex items-center gap-1 flex-wrap min-w-0">
                        <CountPill
                          value={cycle.mergedCount}
                          label="merged"
                          color="bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300"
                        />
                        <CountPill
                          value={cycle.startedCount}
                          label="started"
                          color="bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300"
                        />
                        <CountPill
                          value={cycle.refillCount}
                          label="refilled"
                          color="bg-violet-100 dark:bg-violet-900/50 text-violet-700 dark:text-violet-300"
                        />
                        <CountPill
                          value={cycle.needsAttentionCount}
                          label="need attention"
                          color="bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300"
                        />
                        {/* Highlight badges for API restart / smoke check failure */}
                        {cycle.apiRestarted && (
                          <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-300">
                            API restart
                          </span>
                        )}
                        {cycle.smokeCheckFailed && (
                          <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-orange-100 dark:bg-orange-900/60 text-orange-700 dark:text-orange-300">
                            smoke timeout
                          </span>
                        )}
                        {!cycle.mergedCount && !cycle.startedCount && !cycle.refillCount && !cycle.needsAttentionCount && !hasHighlights && (
                          <span className="text-[11px] text-gray-400 dark:text-gray-600 italic">no actions</span>
                        )}
                      </div>

                      {/* Age (push right) */}
                      <span className="ml-auto text-[11px] font-mono text-gray-400 dark:text-gray-600 shrink-0">
                        {formatAge(cycle.startedAt)}
                      </span>

                      {/* Expand chevron */}
                      <svg
                        className={`w-3 h-3 text-gray-400 shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </div>

                  {/* Expanded detail row */}
                  {isExpanded && (
                    <div className="px-4 py-3 bg-gray-50 dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800">
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        <div>
                          <p className="text-gray-500 dark:text-gray-400 mb-1">Cycle ID</p>
                          <p className="font-mono text-gray-700 dark:text-gray-300 break-all">{cycle.cycleId}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 dark:text-gray-400 mb-1">Health state</p>
                          <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${cfg.badge}`}>{cfg.label}</span>
                        </div>
                        <div>
                          <p className="text-gray-500 dark:text-gray-400 mb-1">Started</p>
                          <p className="text-gray-700 dark:text-gray-300">{formatTime(cycle.startedAt)}</p>
                        </div>
                        {cycle.endedAt && (
                          <div>
                            <p className="text-gray-500 dark:text-gray-400 mb-1">Ended</p>
                            <p className="text-gray-700 dark:text-gray-300">{formatTime(cycle.endedAt)}</p>
                          </div>
                        )}
                        {cycle.issueNumbers.length > 0 && (
                          <div className="col-span-2">
                            <p className="text-gray-500 dark:text-gray-400 mb-1">Related issues</p>
                            <div className="flex flex-wrap gap-1">
                              {cycle.issueNumbers.map((n) => (
                                <button
                                  key={n}
                                  className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-blue-100 dark:hover:bg-blue-900 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onSelectIssue?.(n);
                                  }}
                                  title={`Go to issue #${n}`}
                                >
                                  #{n}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-800 shrink-0">
        {isOrchestratorTab ? (
          <p className="text-xs text-gray-400 dark:text-gray-600">
            {orchestrator?.available
              ? `${orchestrator.recentCycles.length} cycle${orchestrator.recentCycles.length !== 1 ? "s" : ""} · state.md (last 40)`
              : "Out-of-process orchestrator not available for this project"}
            {" · "}
            <code className="font-mono">/api/projects/:id/orchestrator</code>
          </p>
        ) : (
          <p className="text-xs text-gray-400 dark:text-gray-600">
            {cycles.length} cycle{cycles.length !== 1 ? "s" : ""}
            {" · "}
            <code className="font-mono">/api/projects/:id/monitor-cycles</code>
          </p>
        )}
      </div>
    </div>
  );
}

function OrchestratorCycleList({
  orchestrator,
  loading,
  error,
}: {
  orchestrator: OrchestratorStatus | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-24 text-gray-400 dark:text-gray-600 text-sm">
        Loading orchestrator status…
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-4 p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">
        {error}
      </div>
    );
  }

  if (!orchestrator || !orchestrator.available) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-600 text-sm gap-2">
        <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z" />
        </svg>
        <p>No orchestrator loop detected</p>
        <p className="text-xs text-center max-w-xs">
          The out-of-process board monitor (scripts/board-monitor/loop.sh) is not present for this project. Only projects with this dogfooding setup show orchestrator cycles here.
        </p>
      </div>
    );
  }

  const cycles = [...orchestrator.recentCycles].reverse();
  const dead = !orchestrator.alive;

  return (
    <div>
      {/* Orchestrator status bar */}
      <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 bg-indigo-50/40 dark:bg-indigo-950/20 flex items-center gap-2.5">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${dead ? "bg-red-500" : orchestrator.phase === "running" ? "bg-green-500 animate-pulse" : "bg-emerald-400"}`}
          title={dead ? "Loop not running" : orchestrator.phase === "running" ? "Cycle in progress" : "Idle between cycles"}
        />
        <span className={`text-xs font-medium ${dead ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}`}>
          {dead
            ? "Not running"
            : orchestrator.phase === "running"
              ? `Cycle ${orchestrator.iteration ?? "?"} running`
              : `Idle (after cycle ${orchestrator.iteration ?? "?"})`}
        </span>
        {orchestrator.lastLogAt && (
          <span className="text-gray-400 dark:text-gray-500 font-mono text-[11px]">
            · {formatAge(orchestrator.lastLogAt)}
          </span>
        )}
        {orchestrator.lastExit === 124 && (
          <span className="ml-auto px-1.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 text-[10px] font-medium" title="Last cycle hit the 30-minute cap">
            hit 30m cap
          </span>
        )}
      </div>

      {/* Cycle lines from state.md */}
      {cycles.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-32 text-gray-400 dark:text-gray-600 text-sm gap-1">
          <p>No cycles recorded yet</p>
          <p className="text-xs">state.md is empty or has no content lines</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {cycles.map((line, i) => {
            const { age, text } = parseCycleLine(line);
            return (
              <div key={i} className="px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-900 flex items-start gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-indigo-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-gray-800 dark:text-gray-200 leading-snug">{text}</div>
                  {age && (
                    <div className="text-[11px] font-mono text-gray-400 dark:text-gray-500 mt-0.5">
                      {formatAge(age)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
