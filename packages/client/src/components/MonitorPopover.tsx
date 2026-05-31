import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { StatusWithIssues } from "@agentic-kanban/shared";

export type MonitorAction = {
  at: string;
  action: "relaunch" | "merge" | "nudge" | "mark_idle" | "mark_dead" | "auto_start";
  workspaceId: string;
  issueId: string;
};

export type MonitorStatus = {
  enabled: boolean;
  intervalMin: number;
  active: boolean;
  lastRun: {
    at: string;
    relaunched: number;
    merged: number;
    nudged: number;
    resources?: {
      processCount: number;
      listenerCount: number;
      activeWorkspaceCount: number;
      keptCount: number;
      cleanedCount: number;
      cleanupFailedCount: number;
    } | null;
  } | null;
  nextRunAt: string | null;
  recentActions: MonitorAction[];
  resourceSnapshot?: {
    at: string;
    kept: Array<{ rootPid: number; pids: number[]; listenerPorts: number[]; associatedWorkspaceIds: string[]; reason: string }>;
    cleaned: Array<{ rootPid: number; pids: number[]; listenerPorts: number[]; associatedWorkspaceIds: string[]; action: "cleaned" | "cleanup_failed"; reason: string }>;
  } | null;
};

const ACTION_LABELS: Record<MonitorAction["action"], { label: string; color: string }> = {
  relaunch:   { label: "Relaunched agent",   color: "text-blue-600" },
  merge:      { label: "Triggered merge",    color: "text-brand-600 dark:text-brand-400" },
  nudge:      { label: "Nudged agent",       color: "text-amber-600" },
  mark_idle:  { label: "Marked idle",        color: "text-gray-500 dark:text-gray-400" },
  mark_dead:  { label: "Marked dead",        color: "text-red-500" },
  auto_start: { label: "Auto-started issue", color: "text-green-600" },
};

interface MonitorPopoverProps {
  status: MonitorStatus | null;
  onClose: () => void;
  onOpenWorkspace: (workspaceId: string, issueId: string) => void;
  columns: StatusWithIssues[];
  onRunNow: () => Promise<void>;
  autoMonitor: boolean;
  onToggle: () => void;
  interval: string;
  onIntervalChange: (v: string) => void;
  nudgeAutoStart: boolean;
  onNudgeAutoStartChange: (v: boolean) => void;
  nudgeWipLimit: string;
  onNudgeWipLimitChange: (v: string) => void;
}

export function MonitorPopover({
  status,
  onClose,
  onOpenWorkspace,
  columns,
  onRunNow,
  autoMonitor,
  onToggle,
  interval,
  onIntervalChange,
  nudgeAutoStart,
  onNudgeAutoStartChange,
  nudgeWipLimit,
  onNudgeWipLimitChange,
}: MonitorPopoverProps) {
  const [now, setNow] = useState(Date.now());
  const [running, setRunning] = useState(false);

  async function handleRunNow() {
    setRunning(true);
    try { await onRunNow(); } finally { setRunning(false); }
  }

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    function handler(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  function formatCountdown(isoStr: string) {
    const ms = new Date(isoStr).getTime() - now;
    if (ms <= 0) return "now";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
  }

  function formatAge(isoStr: string) {
    const s = Math.floor((now - new Date(isoStr).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  }

  const activeWs = columns.flatMap(c => c.issues).filter(iss =>
    iss.workspaceSummary?.main &&
    (iss.workspaceSummary.main.status === "active" || iss.workspaceSummary.main.status === "reviewing" || iss.workspaceSummary.main.status === "fixing") &&
    iss.workspaceSummary.main.lastAssistantMessage
  );

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        id="monitor-popover"
        className="fixed z-50 left-0 top-0 bottom-0 w-72 bg-surface-raised dark:bg-surface-raised-dark border-r border-gray-200 dark:border-gray-700 shadow-xl text-xs flex flex-col"
      >
        {/* Header */}
        <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between shrink-0 rounded-t-xl bg-gray-50 dark:bg-gray-950">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full shrink-0 ${autoMonitor ? "bg-green-500 animate-pulse" : "bg-gray-300 dark:bg-gray-600"}`} />
            <span className="font-semibold text-gray-800 dark:text-gray-200 text-[13px]">Board Monitor</span>
            {autoMonitor && status?.nextRunAt && (
              <span className="text-gray-400 dark:text-gray-500 text-[10px] font-mono">in {formatCountdown(status.nextRunAt)}</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleRunNow}
              disabled={running}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Run monitor cycle now"
            >
              {running ? (
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
              ) : (
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z"/></svg>
              )}
              {running ? "Running" : "Run now"}
            </button>
            <button onClick={onClose} className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700" title="Close">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 min-h-0">

          {/* Auto-monitor toggle row */}
          <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium text-gray-700 dark:text-gray-300">Auto-monitor</span>
              {autoMonitor && status?.active && (
                <span className="px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-medium">running</span>
              )}
            </div>
            <button
              onClick={onToggle}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-1 ${autoMonitor ? "bg-emerald-500" : "bg-gray-200 dark:bg-gray-600"}`}
              title={autoMonitor ? "Disable auto-monitor" : "Enable auto-monitor"}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${autoMonitor ? "translate-x-[1.125rem]" : "translate-x-0.5"}`} />
            </button>
          </div>

          {/* Active agents */}
          {activeWs.length > 0 && (
            <div className="border-b border-gray-100 dark:border-gray-800">
              <div className="px-3 pt-2.5 pb-1 flex items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Active agents</span>
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">{activeWs.length}</span>
              </div>
              <div className="overflow-y-auto" style={{ maxHeight: "11rem" }}>
                {activeWs.map(iss => (
                  <div
                    key={iss.id}
                    className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 px-3 py-2 transition-colors border-t border-gray-50 dark:border-gray-800/50 first:border-t-0 group"
                    onClick={() => { onOpenWorkspace(iss.workspaceSummary!.main!.id, iss.id); onClose(); }}
                  >
                    <div className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 animate-pulse mt-1.5" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1 mb-0.5">
                          <span className="font-semibold text-gray-600 dark:text-gray-400 shrink-0 text-[11px]">#{iss.issueNumber}</span>
                          <span className="text-gray-700 dark:text-gray-300 truncate text-[11px] font-medium">{iss.title}</span>
                        </div>
                        <p className="text-gray-400 dark:text-gray-500 leading-snug line-clamp-1 text-[10px]">{iss.workspaceSummary!.main!.lastAssistantMessage}</p>
                      </div>
                      <svg className="w-3 h-3 text-gray-300 dark:text-gray-600 group-hover:text-gray-500 dark:group-hover:text-gray-400 shrink-0 mt-1 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/></svg>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Last run summary */}
          <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-800">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">Last run</div>
            {status?.lastRun ? (
              <div className="space-y-1.5">
                <div className="text-gray-400 dark:text-gray-500 text-[11px]">{formatAge(status.lastRun.at)}</div>
                <div className="flex flex-wrap gap-1">
                  {status.lastRun.relaunched > 0 && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950 text-blue-700 font-medium text-[11px]">
                      <span className="w-1 h-1 rounded-full bg-blue-400 shrink-0" />{status.lastRun.relaunched} relaunched
                    </span>
                  )}
                  {status.lastRun.merged > 0 && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 font-medium text-[11px]">
                      <span className="w-1 h-1 rounded-full bg-brand-400 shrink-0" />{status.lastRun.merged} merged
                    </span>
                  )}
                  {status.lastRun.nudged > 0 && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950 text-amber-700 font-medium text-[11px]">
                      <span className="w-1 h-1 rounded-full bg-amber-400 shrink-0" />{status.lastRun.nudged} nudged
                    </span>
                  )}
                  {status.lastRun.relaunched === 0 && status.lastRun.merged === 0 && status.lastRun.nudged === 0 && (
                    <span className="text-gray-400 dark:text-gray-500 text-[11px]">No actions needed</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-gray-400 dark:text-gray-500 text-[11px]">No runs yet this session</div>
            )}
          </div>

          {/* Resource audit */}
          {status?.lastRun?.resources && (
            <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-800">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Resource audit</div>
              <div className="grid grid-cols-3 gap-1.5 mb-2">
                <div className="rounded-md bg-gray-50 dark:bg-gray-800 px-2 py-1">
                  <div className="text-[10px] text-gray-400 dark:text-gray-500">Processes</div>
                  <div className="font-semibold text-gray-700 dark:text-gray-300">{status.lastRun.resources.processCount}</div>
                </div>
                <div className="rounded-md bg-gray-50 dark:bg-gray-800 px-2 py-1">
                  <div className="text-[10px] text-gray-400 dark:text-gray-500">Kept</div>
                  <div className="font-semibold text-gray-700 dark:text-gray-300">{status.lastRun.resources.keptCount}</div>
                </div>
                <div className="rounded-md bg-gray-50 dark:bg-gray-800 px-2 py-1">
                  <div className="text-[10px] text-gray-400 dark:text-gray-500">Cleaned</div>
                  <div className={`font-semibold ${status.lastRun.resources.cleanupFailedCount > 0 ? "text-red-600" : "text-gray-700 dark:text-gray-300"}`}>
                    {status.lastRun.resources.cleanedCount}
                  </div>
                </div>
              </div>
              {status.resourceSnapshot && (
                <div className="space-y-1">
                  {status.resourceSnapshot.cleaned.slice(0, 3).map((item) => (
                    <div key={`cleaned-${item.rootPid}`} className="flex items-center gap-1.5 text-[11px]">
                      <span className={item.action === "cleanup_failed" ? "text-red-600" : "text-emerald-600"}>{item.action === "cleanup_failed" ? "Failed" : "Cleaned"}</span>
                      <span className="font-mono text-gray-500 dark:text-gray-400">PID {item.rootPid}</span>
                      <span className="truncate text-gray-400 dark:text-gray-500">{item.reason}</span>
                    </div>
                  ))}
                  {status.resourceSnapshot.kept.slice(0, 3).map((item) => (
                    <div key={`kept-${item.rootPid}`} className="flex items-center gap-1.5 text-[11px]">
                      <span className="text-gray-500 dark:text-gray-400">Kept</span>
                      <span className="font-mono text-gray-500 dark:text-gray-400">PID {item.rootPid}</span>
                      <span className="truncate text-gray-400 dark:text-gray-500">{item.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Recent actions */}
          {status?.recentActions && status.recentActions.length > 0 && (
            <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-800">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Recent actions</div>
              <div className="space-y-0.5">
                {status.recentActions.map((a, i) => {
                  const meta = ACTION_LABELS[a.action];
                  const issue = columns.flatMap(c => c.issues).find(iss => iss.id === a.issueId);
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded-md px-1.5 -mx-1.5 py-1 transition-colors"
                      onClick={() => { onOpenWorkspace(a.workspaceId, a.issueId); onClose(); }}
                    >
                      <span className={`${meta.color} font-medium truncate flex-1 text-[11px]`}>{meta.label}</span>
                      {issue && <span className="text-gray-500 dark:text-gray-400 shrink-0 text-[11px]">#{issue.issueNumber}</span>}
                      <span className="text-gray-400 dark:text-gray-500 shrink-0 text-[10px] font-mono">{formatAge(a.at)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Settings */}
          <div className="px-3 py-2.5 space-y-2.5 rounded-b-xl">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Settings</div>
            <div className="flex items-center gap-2">
              <label className="text-gray-500 dark:text-gray-400 flex-1 text-[11px]">Check interval</label>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={interval}
                  onChange={(e) => onIntervalChange(e.target.value)}
                  disabled={!autoMonitor}
                  className="w-12 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 text-center text-[11px] focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:opacity-40 disabled:bg-gray-50 dark:disabled:bg-gray-800"
                />
                <span className="text-gray-500 dark:text-gray-400 text-[11px]">min</span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className={`text-gray-600 dark:text-gray-400 text-[11px] ${!autoMonitor ? "opacity-40" : ""}`}>Auto-start unblocked todos</span>
              <button
                onClick={() => onNudgeAutoStartChange(!nudgeAutoStart)}
                disabled={!autoMonitor}
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none disabled:opacity-40 ${nudgeAutoStart && autoMonitor ? "bg-emerald-500" : "bg-gray-200 dark:bg-gray-600"}`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${nudgeAutoStart ? "translate-x-[1.125rem]" : "translate-x-0.5"}`} />
              </button>
            </div>
            {nudgeAutoStart && autoMonitor && (
              <div className="flex items-center gap-2 pl-2.5 border-l-2 border-emerald-200 dark:border-green-800 ml-0.5">
                <label className="text-gray-500 dark:text-gray-400 flex-1 text-[11px]">WIP limit</label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={nudgeWipLimit}
                    onChange={(e) => onNudgeWipLimitChange(e.target.value)}
                    className="w-12 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 text-center text-[11px] focus:outline-none focus:ring-1 focus:ring-emerald-400"
                  />
                  <span className="text-gray-500 dark:text-gray-400 text-[11px]">in progress</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
