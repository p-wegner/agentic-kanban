import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Layout } from "../components/Layout.js";
import { GraphView } from "../components/GraphView.js";
import { TableView } from "../components/TableView.js";
import { BoardColumn } from "../components/BoardColumn.js";
import { CompletedGrid } from "../components/CompletedGrid.js";
import { BoardStats } from "../components/BoardStats.js";
import { CreateIssueForm } from "../components/CreateIssueForm.js";
import { CreateIssuePanel } from "../components/CreateIssuePanel.js";
import type { CreateIssueFormState } from "../components/CreateIssueForm.js";
import { IssueDetailPanel } from "../components/IssueDetailPanel.js";
import { WorkspacePanel } from "../components/WorkspacePanel.js";
import { WorktreeOverview } from "../components/WorktreeOverview.js";
import { AllWorkspacesPanel } from "../components/AllWorkspacesPanel.js";
import { SettingsPanel } from "../components/SettingsPanel.js";
import { SkeletonBoard } from "../components/SkeletonBoard.js";
import { ToastContainer, showToast } from "../components/Toast.js";
import { suggestBranchName } from "../lib/branch.js";
import { CommandPalette } from "../components/CommandPalette.js";
import { ShortcutHelp } from "../components/ShortcutHelp.js";
import { apiFetch } from "../lib/api.js";
import { useBoardEvents, type LiveSessionStats, type TodoItem, type ApprovalRequest } from "../lib/useBoardEvents.js";
import { ApprovalDialog } from "../components/ApprovalDialog.js";
import { MoveToDoneDialog } from "../components/MoveToDoneDialog.js";
import { sendDesktopNotification } from "../lib/desktop.js";
import { registerAction } from "../lib/actions.js";
import { QuickTasksPanel } from "../components/QuickTasksPanel.js";
import { BacklogPanel } from "../components/BacklogPanel.js";
import type {
  CreateIssueRequest,
  IssueWithStatus,
  StatusWithIssues,
  UpdateIssueRequest,
} from "@agentic-kanban/shared";

interface Project {
  id: string;
  name: string;
  repoPath: string;
  repoName: string;
  defaultBranch: string;
  remoteUrl: string | null;
}

const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled"]);
const BACKLOG_STATUS_NAME = "Backlog";

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
type MonitorAction = { at: string; action: "relaunch" | "merge" | "nudge" | "mark_idle" | "mark_dead"; workspaceId: string; issueId: string };
=======
type MonitorAction = { at: string; action: "relaunch" | "merge" | "nudge" | "mark_idle" | "mark_dead"; workspaceId: string };
>>>>>>> 01516bd (feat: add board monitor visualization panel)
=======
type MonitorAction = { at: string; action: "relaunch" | "merge" | "nudge" | "mark_idle" | "mark_dead"; workspaceId: string; issueId: string };
>>>>>>> 47c4344 (feat: make monitor action log entries clickable workspace links)
=======
type MonitorAction = { at: string; action: "relaunch" | "merge" | "nudge" | "mark_idle" | "mark_dead" | "auto_start"; workspaceId: string; issueId: string };
>>>>>>> badbfcc (feat: add nudge auto-start setting to monitor for unblocked Todo items)
type MonitorStatus = { enabled: boolean; intervalMin: number; active: boolean; lastRun: { at: string; relaunched: number; merged: number; nudged: number } | null; nextRunAt: string | null; recentActions: MonitorAction[] };

const ACTION_LABELS: Record<MonitorAction["action"], { label: string; color: string }> = {
  relaunch:   { label: "Relaunched agent",  color: "text-blue-600" },
  merge:      { label: "Triggered merge",   color: "text-purple-600" },
  nudge:      { label: "Nudged agent",      color: "text-amber-600" },
  mark_idle:  { label: "Marked idle",       color: "text-gray-500" },
  mark_dead:  { label: "Marked dead",       color: "text-red-500" },
  auto_start: { label: "Auto-started issue", color: "text-green-600" },
=======
type MonitorAction = { at: string; action: "relaunch" | "merge" | "nudge" | "mark_idle" | "mark_dead" | "auto_start"; workspaceId: string; issueId: string };
type MonitorStatus = { enabled: boolean; intervalMin: number; active: boolean; lastRun: { at: string; relaunched: number; merged: number; nudged: number } | null; nextRunAt: string | null; recentActions: MonitorAction[] };

const ACTION_LABELS: Record<MonitorAction["action"], { label: string; color: string }> = {
  relaunch:   { label: "Relaunched agent", color: "text-blue-600" },
  merge:      { label: "Triggered merge",  color: "text-purple-600" },
  nudge:      { label: "Nudged agent",     color: "text-amber-600" },
  mark_idle:  { label: "Marked idle",      color: "text-gray-500" },
  mark_dead:  { label: "Marked dead",      color: "text-red-500" },
  auto_start: { label: "Auto-started",     color: "text-green-600" },
>>>>>>> 52ef66c (fix: repair pre-existing build errors (smart quotes in cli.ts, truncated TableView/BoardPage from bad merge))
};

<<<<<<< HEAD
<<<<<<< HEAD
function MonitorPopover({ status, onClose, onOpenWorkspace, columns }: { status: MonitorStatus | null; onClose: () => void; onOpenWorkspace: (workspaceId: string, issueId: string) => void; columns: StatusWithIssues[] }) {
  const [now, setNow] = useState(Date.now());
<<<<<<< HEAD
  const issueMap = useMemo(() => {
    const m = new Map<string, IssueWithStatus>();
    for (const col of columns) for (const issue of col.issues) m.set(issue.id, issue);
    return m;
  }, [columns]);
=======
function MonitorPopover({ status, onClose }: { status: MonitorStatus | null; onClose: () => void }) {
  const [now, setNow] = useState(Date.now());
>>>>>>> 01516bd (feat: add board monitor visualization panel)
=======
function MonitorPopover({ status, onClose, onOpenWorkspace, columns }: { status: MonitorStatus | null; onClose: () => void; onOpenWorkspace: (workspaceId: string, issueId: string) => void; columns: StatusWithIssues[] }) {
  const [now, setNow] = useState(Date.now());
  const issueMap = useMemo(() => {
    const m = new Map<string, IssueWithStatus>();
    for (const col of columns) for (const issue of col.issues) m.set(issue.id, issue);
    return m;
  }, [columns]);
>>>>>>> 47c4344 (feat: make monitor action log entries clickable workspace links)
=======
type MonitorAction = { at: string; action: "relaunch" | "merge" | "nudge" | "mark_idle" | "mark_dead"; workspaceId: string };
=======
type MonitorAction = { at: string; action: "relaunch" | "merge" | "nudge" | "mark_idle" | "mark_dead"; workspaceId: string; issueId: string };
>>>>>>> f7a87fc (feat: make monitor action log entries clickable workspace links)
=======
type MonitorAction = { at: string; action: "relaunch" | "merge" | "nudge" | "mark_idle" | "mark_dead"; workspaceId: string };
>>>>>>> bf9db15 (feat: add board monitor visualization panel)
=======
type MonitorAction = { at: string; action: "relaunch" | "merge" | "nudge" | "mark_idle" | "mark_dead" | "auto_start"; workspaceId: string; issueId: string };
>>>>>>> 0c15856 (fix: restore BoardPage.tsx from clean base and re-apply monitor enhancements with issueId/auto_start)
type MonitorStatus = { enabled: boolean; intervalMin: number; active: boolean; lastRun: { at: string; relaunched: number; merged: number; nudged: number } | null; nextRunAt: string | null; recentActions: MonitorAction[] };

const ACTION_LABELS: Record<MonitorAction["action"], { label: string; color: string }> = {
  relaunch:   { label: "Relaunched agent", color: "text-blue-600" },
  merge:      { label: "Triggered merge",  color: "text-purple-600" },
  nudge:      { label: "Nudged agent",     color: "text-amber-600" },
  mark_idle:  { label: "Marked idle",      color: "text-gray-500" },
  mark_dead:  { label: "Marked dead",      color: "text-red-500" },
  auto_start: { label: "Auto-started",     color: "text-green-600" },
};

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
function MonitorPopover({ status, onClose, onOpenWorkspace, columns }: { status: MonitorStatus | null; onClose: () => void; onOpenWorkspace: (workspaceId: string, issueId: string) => void; columns: StatusWithIssues[] }) {
  const [now, setNow] = useState(Date.now());
<<<<<<< HEAD
<<<<<<< HEAD
>>>>>>> 1407a7f (feat: add board monitor visualization panel)
=======
  const issueMap = useMemo(() => {
    const m = new Map<string, IssueWithStatus>();
    for (const col of columns) for (const issue of col.issues) m.set(issue.id, issue);
    return m;
  }, [columns]);
>>>>>>> f7a87fc (feat: make monitor action log entries clickable workspace links)
=======
function MonitorPopover({ status, onClose }: { status: MonitorStatus | null; onClose: () => void }) {
  const [now, setNow] = useState(Date.now());
>>>>>>> bf9db15 (feat: add board monitor visualization panel)
=======
>>>>>>> 0c15856 (fix: restore BoardPage.tsx from clean base and re-apply monitor enhancements with issueId/auto_start)
=======
>>>>>>> 52ef66c (fix: repair pre-existing build errors (smart quotes in cli.ts, truncated TableView/BoardPage from bad merge))
=======
function MonitorPopover({ status, onClose, onOpenWorkspace, columns, onRunNow }: { status: MonitorStatus | null; onClose: () => void; onOpenWorkspace: (workspaceId: string, issueId: string) => void; columns: StatusWithIssues[]; onRunNow: () => Promise<void> }) {
=======
function MonitorPopover({ status, onClose, onOpenWorkspace, columns, onRunNow, autoMonitor, onToggle, interval, onIntervalChange, nudgeAutoStart, onNudgeAutoStartChange, nudgeWipLimit, onNudgeWipLimitChange }: { status: MonitorStatus | null; onClose: () => void; onOpenWorkspace: (workspaceId: string, issueId: string) => void; columns: StatusWithIssues[]; onRunNow: () => Promise<void>; autoMonitor: boolean; onToggle: () => void; interval: string; onIntervalChange: (v: string) => void; nudgeAutoStart: boolean; onNudgeAutoStartChange: (v: boolean) => void; nudgeWipLimit: string; onNudgeWipLimitChange: (v: string) => void }) {
>>>>>>> 693fe5c (feat: move monitor toggle and settings to board view popover)
=======
function MonitorPopover({ status, onClose, onOpenWorkspace, columns, onRunNow, autoMonitor, onToggle, interval, onIntervalChange, nudgeAutoStart, onNudgeAutoStartChange, nudgeWipLimit, onNudgeWipLimitChange, anchorRef }: { status: MonitorStatus | null; onClose: () => void; onOpenWorkspace: (workspaceId: string, issueId: string) => void; columns: StatusWithIssues[]; onRunNow: () => Promise<void>; autoMonitor: boolean; onToggle: () => void; interval: string; onIntervalChange: (v: string) => void; nudgeAutoStart: boolean; onNudgeAutoStartChange: (v: boolean) => void; nudgeWipLimit: string; onNudgeWipLimitChange: (v: string) => void; anchorRef: React.RefObject<HTMLElement | null> }) {
>>>>>>> 7a1bfb9 (fix: board monitor popover stays within viewport, scrollable content)
  const [now, setNow] = useState(Date.now());
  const [running, setRunning] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  async function handleRunNow() {
    setRunning(true);
    try { await onRunNow(); } finally { setRunning(false); }
  }
>>>>>>> 1adff89 (feat: add Run now button to monitor popover (#220))

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    function handler(e: MouseEvent) {
      const popEl = popoverRef.current;
      const anchor = anchorRef.current;
      if (popEl && !popEl.contains(e.target as Node) && anchor && !anchor.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose, anchorRef]);

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
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      {/* Side panel — pinned to right edge, full viewport height */}
      <div
        ref={popoverRef}
        id="monitor-popover"
        className="fixed top-0 right-0 z-50 h-screen w-72 bg-white border-l border-gray-200 shadow-2xl text-xs flex flex-col"
        style={{ maxHeight: "100dvh" }}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0 bg-gray-50">
          <div className="flex items-center gap-2">
            {autoMonitor && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />}
            <span className="font-semibold text-gray-800 text-sm">Board Monitor</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors p-0.5 rounded" title="Close">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 min-h-0">

          {/* Auto-monitor toggle + run */}
          <div className="px-4 py-3 border-b border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="font-medium text-gray-700">Auto-monitor</div>
                {autoMonitor && status?.nextRunAt && (
                  <div className="text-gray-400 mt-0.5">Next run in {formatCountdown(status.nextRunAt)}</div>
                )}
              </div>
              <button
                onClick={onToggle}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-green-400 focus:ring-offset-1 ${autoMonitor ? "bg-green-500" : "bg-gray-300"}`}
                title={autoMonitor ? "Disable auto-monitor" : "Enable auto-monitor"}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${autoMonitor ? "translate-x-[1.125rem]" : "translate-x-0.5"}`} />
              </button>
            </div>
            <button
              onClick={handleRunNow}
              disabled={running}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Run monitor cycle now and reset the timer"
            >
              {running ? (
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
              ) : (
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z"/></svg>
              )}
              {running ? "Running..." : "Run now"}
            </button>
          </div>

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
      {status?.recentActions && status.recentActions.length > 0 ? (
        <div className="px-3 py-2">
          <div className="text-gray-400 font-medium uppercase tracking-wide mb-1.5" style={{ fontSize: "10px" }}>Recent actions</div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {status.recentActions.map((a, i) => {
              const meta = ACTION_LABELS[a.action];
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
              const issue = issueMap.get(a.issueId);
              const label = issue ? `#${issue.issueNumber} ${issue.title}` : a.workspaceId.slice(0, 8);
              return (
                <div key={i} className="flex items-center justify-between gap-2 min-w-0">
                  <span className={`${meta.color} font-medium shrink-0`}>{meta.label}</span>
                  <button
                    className="text-blue-500 hover:text-blue-700 hover:underline truncate text-left min-w-0 flex-1"
                    style={{ fontSize: "11px" }}
                    onClick={() => { onOpenWorkspace(a.workspaceId, a.issueId); onClose(); }}
                    title={issue ? issue.title : a.workspaceId}
                  >{label}</button>
=======
=======
>>>>>>> 1407a7f (feat: add board monitor visualization panel)
=======
>>>>>>> bf9db15 (feat: add board monitor visualization panel)
              return (
                <div key={i} className="flex items-center justify-between gap-2">
                  <span className={`${meta.color} font-medium`}>{meta.label}</span>
                  <span className="text-gray-400 shrink-0 font-mono" style={{ fontSize: "10px" }}>{a.workspaceId.slice(0, 8)}</span>
<<<<<<< HEAD
<<<<<<< HEAD
>>>>>>> 01516bd (feat: add board monitor visualization panel)
=======
              const issue = issueMap.get(a.issueId);
              const label = issue ? `#${issue.issueNumber} ${issue.title}` : a.workspaceId.slice(0, 8);
              return (
=======
              const issue = issueMap.get(a.issueId);
              const label = issue ? `#${issue.issueNumber} ${issue.title}` : a.workspaceId.slice(0, 8);
              return (
>>>>>>> f7a87fc (feat: make monitor action log entries clickable workspace links)
                <div key={i} className="flex items-center justify-between gap-2 min-w-0">
                  <span className={`${meta.color} font-medium shrink-0`}>{meta.label}</span>
                  <button
                    className="text-blue-500 hover:text-blue-700 hover:underline truncate text-left min-w-0 flex-1"
                    style={{ fontSize: "11px" }}
                    onClick={() => { onOpenWorkspace(a.workspaceId, a.issueId); onClose(); }}
                    title={issue ? issue.title : a.workspaceId}
                  >{label}</button>
<<<<<<< HEAD
>>>>>>> 47c4344 (feat: make monitor action log entries clickable workspace links)
=======
>>>>>>> 1407a7f (feat: add board monitor visualization panel)
=======
>>>>>>> f7a87fc (feat: make monitor action log entries clickable workspace links)
=======
>>>>>>> bf9db15 (feat: add board monitor visualization panel)
=======
              const issue = columns.flatMap(c => c.issues).find(iss => iss.id === a.issueId);
              return (
=======
              const issue = columns.flatMap(c => c.issues).find(iss => iss.id === a.issueId);
              return (
>>>>>>> 52ef66c (fix: repair pre-existing build errors (smart quotes in cli.ts, truncated TableView/BoardPage from bad merge))
                <div
                  key={i}
                  className="flex items-center justify-between gap-2 cursor-pointer hover:bg-gray-50 rounded px-1 -mx-1 py-0.5"
                  onClick={() => { onOpenWorkspace(a.workspaceId, a.issueId); onClose(); }}
                >
                  <span className={`${meta.color} font-medium truncate`}>{meta.label}</span>
                  {issue && <span className="text-gray-500 truncate shrink" style={{ fontSize: "10px" }}>#{issue.issueNumber}</span>}
<<<<<<< HEAD
>>>>>>> 0c15856 (fix: restore BoardPage.tsx from clean base and re-apply monitor enhancements with issueId/auto_start)
=======
>>>>>>> 52ef66c (fix: repair pre-existing build errors (smart quotes in cli.ts, truncated TableView/BoardPage from bad merge))
                  <span className="text-gray-400 shrink-0">{formatAge(a.at)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="px-3 py-2 text-gray-400">No actions recorded yet</div>
=======
=======
          {(() => {
            const activeWs = columns.flatMap(c => c.issues).filter(iss =>
              iss.workspaceSummary?.main &&
              (iss.workspaceSummary.main.status === "active" || iss.workspaceSummary.main.status === "reviewing" || iss.workspaceSummary.main.status === "fixing") &&
              iss.workspaceSummary.main.lastAssistantMessage
            );
            if (activeWs.length === 0) return null;
            return (
=======
        {autoMonitor && (
          <>
            {/* Last run summary */}
            <div className="px-3 py-2 border-b border-gray-100 space-y-1.5">
              {status?.lastRun ? (
                <>
                  <div className="flex justify-between text-gray-500">
                    <span>Last run</span>
                    <span className="text-gray-700">{formatAge(status.lastRun.at)}</span>
                  </div>
                  <div className="flex gap-3">
                    {status.lastRun.relaunched > 0 && <span className="text-blue-600">{status.lastRun.relaunched} relaunched</span>}
                    {status.lastRun.merged > 0 && <span className="text-purple-600">{status.lastRun.merged} merged</span>}
                    {status.lastRun.nudged > 0 && <span className="text-amber-600">{status.lastRun.nudged} nudged</span>}
                    {status.lastRun.relaunched === 0 && status.lastRun.merged === 0 && status.lastRun.nudged === 0 && (
                      <span className="text-gray-400">No actions needed</span>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-gray-400">No runs yet this session</div>
              )}
            </div>

            {/* Active agents */}
            {activeWs.length > 0 && (
>>>>>>> 1327c16 (fix: board monitor popover stays within viewport, scrollable content)
              <div className="px-3 py-2 border-b border-gray-100">
                <div className="text-gray-400 font-medium uppercase tracking-wide mb-1.5" style={{ fontSize: "10px" }}>
                  Active agents ({activeWs.length})
                </div>
                <div className="space-y-1.5">
                  {activeWs.map(iss => (
                    <div key={iss.id} className="cursor-pointer hover:bg-gray-50 rounded px-1.5 -mx-1.5 py-1" onClick={() => { onOpenWorkspace(iss.workspaceSummary!.main!.id, iss.id); onClose(); }}>
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                        <span className="font-medium text-gray-600">#{iss.issueNumber}</span>
                        <span className="text-gray-400 truncate" style={{ fontSize: "10px" }}>{iss.title}</span>
                      </div>
                      <p className="text-gray-500 leading-snug line-clamp-2 pl-3" style={{ fontSize: "10px" }}>{iss.workspaceSummary!.main!.lastAssistantMessage}</p>
                    </div>
                  ))}
=======
          {/* Settings */}
          <div className="px-4 py-3 border-b border-gray-100 space-y-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Settings</div>
            <div className="flex items-center gap-2">
              <label className="text-gray-500 flex-1">Check interval</label>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={interval}
                  onChange={(e) => onIntervalChange(e.target.value)}
                  disabled={!autoMonitor}
                  className="w-14 border border-gray-300 rounded-md px-2 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-40 disabled:bg-gray-50"
                />
                <span className="text-gray-500">min</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className={`text-gray-600 ${!autoMonitor ? "opacity-40" : ""}`}>Auto-start unblocked todos</span>
              <button
                onClick={() => onNudgeAutoStartChange(!nudgeAutoStart)}
                disabled={!autoMonitor}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none disabled:opacity-40 ${nudgeAutoStart && autoMonitor ? "bg-green-500" : "bg-gray-300"}`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${nudgeAutoStart ? "translate-x-[1.125rem]" : "translate-x-0.5"}`} />
              </button>
            </div>
            {nudgeAutoStart && autoMonitor && (
              <div className="flex items-center gap-2 pl-3 border-l-2 border-green-200">
                <label className="text-gray-500 flex-1">WIP limit</label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={nudgeWipLimit}
                    onChange={(e) => onNudgeWipLimitChange(e.target.value)}
                    className="w-14 border border-gray-300 rounded-md px-2 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <span className="text-gray-500">in progress</span>
>>>>>>> a8615f5 (fix: redesign board monitor as full-height side panel to prevent viewport overflow)
                </div>
              </div>
            )}
          </div>

<<<<<<< HEAD
<<<<<<< HEAD
>>>>>>> 87bce6d (feat: show last assistant message for active agents in board monitor view)
          {status?.recentActions && status.recentActions.length > 0 ? (
            <div className="px-3 py-2">
              <div className="text-gray-400 font-medium uppercase tracking-wide mb-1.5" style={{ fontSize: "10px" }}>Recent actions</div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {status.recentActions.map((a, i) => {
                  const meta = ACTION_LABELS[a.action];
                  const issue = columns.flatMap(c => c.issues).find(iss => iss.id === a.issueId);
                  return (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-2 cursor-pointer hover:bg-gray-50 rounded px-1 -mx-1 py-0.5"
                      onClick={() => { onOpenWorkspace(a.workspaceId, a.issueId); onClose(); }}
                    >
                      <span className={`${meta.color} font-medium truncate`}>{meta.label}</span>
                      {issue && <span className="text-gray-500 truncate shrink" style={{ fontSize: "10px" }}>#{issue.issueNumber}</span>}
                      <span className="text-gray-400 shrink-0">{formatAge(a.at)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="px-3 py-2 text-gray-400">No actions recorded yet</div>
          )}
        </>
>>>>>>> 693fe5c (feat: move monitor toggle and settings to board view popover)
      )}
=======
            {/* Recent actions */}
            {status?.recentActions && status.recentActions.length > 0 ? (
              <div className="px-3 py-2">
                <div className="text-gray-400 font-medium uppercase tracking-wide mb-1.5" style={{ fontSize: "10px" }}>Recent actions</div>
                <div className="space-y-1">
                  {status.recentActions.map((a, i) => {
                    const meta = ACTION_LABELS[a.action];
                    const issue = columns.flatMap(c => c.issues).find(iss => iss.id === a.issueId);
                    return (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-2 cursor-pointer hover:bg-gray-50 rounded px-1.5 -mx-1.5 py-0.5"
                        onClick={() => { onOpenWorkspace(a.workspaceId, a.issueId); onClose(); }}
                      >
                        <span className={`${meta.color} font-medium truncate`}>{meta.label}</span>
                        {issue && <span className="text-gray-500 truncate shrink" style={{ fontSize: "10px" }}>#{issue.issueNumber}</span>}
                        <span className="text-gray-400 shrink-0">{formatAge(a.at)}</span>
                      </div>
                    );
                  })}
=======
          {/* Last run summary */}
          <div className="px-4 py-3 border-b border-gray-100">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Last run</div>
            {status?.lastRun ? (
              <div className="space-y-1.5">
                <div className="text-gray-400">{formatAge(status.lastRun.at)}</div>
                <div className="flex flex-wrap gap-1.5">
                  {status.lastRun.relaunched > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />{status.lastRun.relaunched} relaunched
                    </span>
                  )}
                  {status.lastRun.merged > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />{status.lastRun.merged} merged
                    </span>
                  )}
                  {status.lastRun.nudged > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />{status.lastRun.nudged} nudged
                    </span>
                  )}
                  {status.lastRun.relaunched === 0 && status.lastRun.merged === 0 && status.lastRun.nudged === 0 && (
                    <span className="text-gray-400">No actions needed</span>
                  )}
>>>>>>> a8615f5 (fix: redesign board monitor as full-height side panel to prevent viewport overflow)
                </div>
              </div>
            ) : (
              <div className="text-gray-400">No runs yet this session</div>
            )}
          </div>

          {/* Active agents */}
          {activeWs.length > 0 && (
            <div className="px-4 py-3 border-b border-gray-100">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
                Active agents <span className="text-green-600">({activeWs.length})</span>
              </div>
              <div className="space-y-2">
                {activeWs.map(iss => (
                  <div
                    key={iss.id}
                    className="cursor-pointer hover:bg-gray-50 rounded-lg p-2 -mx-1 transition-colors border border-transparent hover:border-gray-200"
                    onClick={() => { onOpenWorkspace(iss.workspaceSummary!.main!.id, iss.id); onClose(); }}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0 animate-pulse" />
                      <span className="font-semibold text-gray-700">#{iss.issueNumber}</span>
                      <span className="text-gray-500 truncate">{iss.title}</span>
                    </div>
                    <p className="text-gray-400 leading-snug line-clamp-2 pl-3">{iss.workspaceSummary!.main!.lastAssistantMessage}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent actions */}
          <div className="px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Recent actions</div>
            {status?.recentActions && status.recentActions.length > 0 ? (
              <div className="space-y-1">
                {status.recentActions.map((a, i) => {
                  const meta = ACTION_LABELS[a.action];
                  const issue = columns.flatMap(c => c.issues).find(iss => iss.id === a.issueId);
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded-md px-2 -mx-1 py-1 transition-colors"
                      onClick={() => { onOpenWorkspace(a.workspaceId, a.issueId); onClose(); }}
                    >
                      <span className={`${meta.color} font-medium truncate flex-1`}>{meta.label}</span>
                      {issue && <span className="text-gray-500 shrink-0">#{issue.issueNumber}</span>}
                      <span className="text-gray-400 shrink-0">{formatAge(a.at)}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-gray-400">No actions recorded yet</div>
            )}
          </div>
        </div>
      </div>
<<<<<<< HEAD
<<<<<<< HEAD
>>>>>>> 1327c16 (fix: board monitor popover stays within viewport, scrollable content)
    </div>
=======
    </div>,
=======
    </>,
>>>>>>> a8615f5 (fix: redesign board monitor as full-height side panel to prevent viewport overflow)
    document.body
>>>>>>> 9218c26 (fix: render MonitorPopover via portal to escape overflow-hidden clipping)
  );
}

export function BoardPage() {
  const [columns, setColumns] = useState<StatusWithIssues[]>([]);
  const columnsRef = useRef<StatusWithIssues[]>([]);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [creatingInColumnId, setCreatingInColumnId] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<IssueWithStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [workspaceIssue, setWorkspaceIssue] = useState<IssueWithStatus | null>(null);
  const [workspaceInitial, setWorkspaceInitial] = useState<{ workspaceId: string; sessionId: string } | null>(null);
  const [workspaceOpenCreate, setWorkspaceOpenCreate] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
  const [blockedFilter, setBlockedFilter] = useState(false);
=======
  const [priorityFilter, setPriorityFilter] = useState("");
<<<<<<< HEAD
<<<<<<< HEAD
>>>>>>> 53a9dc5 (feat: remove blocked filter from board main page)
=======
  const [priorityFilter, setPriorityFilter] = useState("");
>>>>>>> 029ede6 (feat: remove blocked filter from board main page)
=======
  const [priorityFilter, setPriorityFilter] = useState("");
<<<<<<< HEAD
=======
  const [blockedFilter, setBlockedFilter] = useState(false);
>>>>>>> 5651f2d (feat: remove priority filter from frontend UI)
<<<<<<< HEAD
>>>>>>> 46e7ac8 (feat: remove priority filter from frontend UI)
=======
=======
>>>>>>> 4f0c0a0 (feat: remove blocked filter from board main page)
>>>>>>> 4a222f1 (feat: remove blocked filter from board main page)
=======
>>>>>>> f903991 (feat: conditionally show AI Reviewed column and fix stats colors)
=======
>>>>>>> 0c15856 (fix: restore BoardPage.tsx from clean base and re-apply monitor enhancements with issueId/auto_start)
=======
>>>>>>> 52ef66c (fix: repair pre-existing build errors (smart quotes in cli.ts, truncated TableView/BoardPage from bad merge))
=======
  const [showBlocked, setShowBlocked] = useState(false);
>>>>>>> 34c67d9 (feat: add E2E tests for board stats bar and Blocked filter)
  const [showSettings, setShowSettings] = useState(false);
  const [showQuickTasks, setShowQuickTasks] = useState(false);
  const [showWorktreeOverview, setShowWorktreeOverview] = useState(false);
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(["archive"]),
  );
  const [sessionActivityRaw, setSessionActivityRaw] = useState<Record<string, Record<string, string>>>({});
  const sessionActivity = useMemo(() => {
    const derived: Record<string, string> = {};
    for (const [issueId, sessions] of Object.entries(sessionActivityRaw)) {
      const values = Object.values(sessions);
      const last = [...values].reverse().find((v: string) => v);
      if (last) derived[issueId] = last;
    }
    return derived;
  }, [sessionActivityRaw]);
  const [liveStats, setLiveStats] = useState<Record<string, LiveSessionStats>>({});
  const [sessionTodos, setSessionTodos] = useState<Record<string, TodoItem[]>>({});
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const pendingBoardRefreshRef = useRef(false);
<<<<<<< HEAD
<<<<<<< HEAD
  const pendingGRef = useRef(false);
  const pendingGTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
=======
>>>>>>> 52ef66c (fix: repair pre-existing build errors (smart quotes in cli.ts, truncated TableView/BoardPage from bad merge))
=======
  const pendingGRef = useRef(false);
  const pendingGTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
>>>>>>> ffa8d96 (fix: restore scheduled-runs feature and keyboard shortcuts lost in bad merge fix)
  const [expandedCreatePanel, setExpandedCreatePanel] = useState<{ statusId: string; statusName: string; state: Partial<CreateIssueFormState> } | null>(null);
  const [viewMode, setViewMode] = useState<"kanban" | "graph" | "table">("kanban");
  const [dynamicColumnScaling, setDynamicColumnScaling] = useState(false);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem("kanban-column-widths") ?? "{}"); } catch { return {}; }
  });
  const resizingRef = useRef<{ colId: string; startX: number; startWidth: number } | null>(null);

  const handleColumnResizeStart = useCallback((colId: string, e: React.MouseEvent) => {
    e.preventDefault();
    const colEl = document.getElementById(`column-${colId}`);
    const startWidth = colEl ? colEl.getBoundingClientRect().width : (columnWidths[colId] ?? 288);
    resizingRef.current = { colId, startX: e.clientX, startWidth };

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = ev.clientX - resizingRef.current.startX;
      const newWidth = Math.max(160, Math.min(800, resizingRef.current.startWidth + delta));
      setColumnWidths((prev) => ({ ...prev, [resizingRef.current!.colId]: newWidth }));
    };
    const onMouseUp = () => {
      setColumnWidths((prev) => {
        try { localStorage.setItem("kanban-column-widths", JSON.stringify(prev)); } catch {}
        return prev;
      });
      resizingRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [columnWidths]);

  const [autoReview, setAutoReview] = useState(true);
  const [autoMerge, setAutoMerge] = useState(true);
  const [autoMonitor, setAutoMonitor] = useState(false);
  const [autoMonitorInterval, setAutoMonitorInterval] = useState("4");
  const [nudgeAutoStart, setNudgeAutoStart] = useState(false);
  const [nudgeWipLimit, setNudgeWipLimit] = useState("5");
  const [monitorStatus, setMonitorStatus] = useState<MonitorStatus | null>(null);
  const [showMonitorPopover, setShowMonitorPopover] = useState(false);
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
  const [autoReview, setAutoReview] = useState(true);
  const [autoMerge, setAutoMerge] = useState(true);
>>>>>>> 6de3bcc (fix: restore autoReview/autoMerge useState declarations lost during conflict resolution)
=======
>>>>>>> 0c15856 (fix: restore BoardPage.tsx from clean base and re-apply monitor enhancements with issueId/auto_start)
=======
>>>>>>> 52ef66c (fix: repair pre-existing build errors (smart quotes in cli.ts, truncated TableView/BoardPage from bad merge))
=======
=======
  const monitorAnchorRef = useRef<HTMLDivElement>(null);
>>>>>>> 7a1bfb9 (fix: board monitor popover stays within viewport, scrollable content)
  const [monitorRunning, setMonitorRunning] = useState(false);
<<<<<<< HEAD
>>>>>>> 77d9d10 (feat: add Run Now button to board toolbar next to Monitor button)
=======
  const [moveToDonePending, setMoveToDonePending] = useState<{ issue: IssueWithStatus; confirm: () => Promise<void> } | null>(null);
>>>>>>> 174c8c9 (feat: show MoveToDoneDialog when moving issue with active workspace to Done/Cancelled)

  const refetchBoard = useCallback(async (projectId?: string) => {
    const pid = projectId || activeProjectId;
    if (!pid) return;
    const board = await apiFetch<StatusWithIssues[]>(
      `/api/projects/${pid}/board`,
    );
    setColumns(board);
    columnsRef.current = board;
    // Clear stale live data for issues whose agent is no longer running
    const inactiveIssueIds = new Set<string>();
    for (const col of board) {
      for (const issue of col.issues) {
        const ws = issue.workspaceSummary?.main;
        if (!ws || (ws.status !== "active" && ws.status !== "fixing")) {
          inactiveIssueIds.add(issue.id);
        }
      }
    }
    if (inactiveIssueIds.size > 0) {
      setLiveStats((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const id of inactiveIssueIds) {
          if (id in next) { delete next[id]; changed = true; }
        }
        return changed ? next : prev;
      });
      setSessionActivityRaw((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const id of inactiveIssueIds) {
          if (id in next) { delete next[id]; changed = true; }
        }
        return changed ? next : prev;
      });
    }
    return board;
  }, [activeProjectId]);

  // Keep selectedIssue in sync with board data (F6 stale data fix)
  useEffect(() => {
    if (!selectedIssue) return;
    for (const col of columns) {
      const found = col.issues.find((i) => i.id === selectedIssue.id);
      if (found) {
        // Only update if data actually changed to avoid unnecessary re-renders
        if (found.title !== selectedIssue.title ||
            found.description !== selectedIssue.description ||
            found.priority !== selectedIssue.priority ||
            found.statusId !== selectedIssue.statusId ||
            found.statusName !== selectedIssue.statusName ||
            found.updatedAt !== selectedIssue.updatedAt ||
            found.workspaceSummary?.main?.contextTokens !== selectedIssue.workspaceSummary?.main?.contextTokens ||
            found.workspaceSummary?.main?.lastTool !== selectedIssue.workspaceSummary?.main?.lastTool ||
            found.workspaceSummary?.main?.status !== selectedIssue.workspaceSummary?.main?.status) {
          setSelectedIssue(found);
        }
        return;
      }
    }
    // Issue was deleted — close panel
    setSelectedIssue(null);
  }, [columns, selectedIssue]);

  // Real-time board updates via WebSocket (debounced while create form is open)
  useBoardEvents(activeProjectId, useCallback((reason: string) => {
    console.log(`[board-events] board changed: ${reason}`);
    // Desktop notification for agent events
    if (reason === "session_completed") {
      sendDesktopNotification("Agentic Kanban", "Agent session completed");
    } else if (reason === "workspace_merged") {
      sendDesktopNotification("Agentic Kanban", "Workspace merged successfully");
    }
    if (creatingInColumnId) {
      // Don't refresh while create form is open — batch the update
      pendingBoardRefreshRef.current = true;
      return;
    }
    refetchBoard();
  }, [refetchBoard, creatingInColumnId]), useCallback((issueId: string, sessionId: string, activity: string) => {
    const isActive = columnsRef.current.some(col =>
      col.issues.some(iss => iss.id === issueId && (iss.workspaceSummary?.main?.status === "active" || iss.workspaceSummary?.main?.status === "fixing"))
    );
    if (!isActive && activity) return;
    setSessionActivityRaw((prev) => {
      const sessions = { ...(prev[issueId] ?? {}) };
      if (!activity) {
        delete sessions[sessionId];
      } else {
        if (sessions[sessionId] === activity) return prev;
        sessions[sessionId] = activity;
      }
      if (Object.keys(sessions).length === 0) {
        const next = { ...prev };
        delete next[issueId];
        // Also clear liveStats since the agent has finished its turn
        setLiveStats((prev) => {
          if (!(issueId in prev)) return prev;
          const next = { ...prev };
          delete next[issueId];
          return next;
        });
        return next;
      }
      return { ...prev, [issueId]: sessions };
    });
  }, []), useCallback((issueId: string, stats: LiveSessionStats) => {
    // Ignore stats for workspaces that are no longer active (agent finished)
    const isActive = columnsRef.current.some(col =>
      col.issues.some(iss => iss.id === issueId && (iss.workspaceSummary?.main?.status === "active" || iss.workspaceSummary?.main?.status === "fixing"))
    );
    if (!isActive) return;
    setLiveStats((prev) => {
      if (prev[issueId]?.model === stats.model && prev[issueId]?.contextTokens === stats.contextTokens && prev[issueId]?.toolUses === stats.toolUses && prev[issueId]?.subagentCount === stats.subagentCount) return prev;
      return { ...prev, [issueId]: stats };
    });
  }, []), useCallback((issueId: string, todos: TodoItem[]) => {
    setSessionTodos((prev) => ({ ...prev, [issueId]: todos }));
  }, []), useCallback((req: ApprovalRequest) => {
    setApprovalRequests((prev) => [...prev, req]);
  }, []));

  // Process pending board refresh when create form closes
  useEffect(() => {
    if (!creatingInColumnId && pendingBoardRefreshRef.current) {
      pendingBoardRefreshRef.current = false;
      refetchBoard();
    }
  }, [creatingInColumnId, refetchBoard]);

  const loadProjects = useCallback(async () => {
    const projs = await apiFetch<Project[]>("/api/projects");
    setProjects(projs);
    if (projs.length === 0) return;

    // Get active project preference
    try {
      const pref = await apiFetch<{ projectId: string | null }>("/api/preferences/active-project");
      if (pref.projectId && projs.some((p) => p.id === pref.projectId)) {
        setActiveProjectId(pref.projectId);
        return pref.projectId;
      }
    } catch {
      // Ignore — fall back to first project
    }

    // Fallback to first project
    const firstId = projs[0].id;
    setActiveProjectId(firstId);
    return firstId;
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const pid = await loadProjects();
        if (pid) {
          const board = await apiFetch<StatusWithIssues[]>(
            `/api/projects/${pid}/board`,
          );
          setColumns(board);
          columnsRef.current = board;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load board");
      }
      // Load preferences independently so they work even if board fails
      try {
        const s = await apiFetch<Record<string, string>>("/api/preferences/settings");
        setDynamicColumnScaling(s.dynamic_column_scaling === "true");
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
        setAutoReview(s.auto_review !== "false");
        setAutoMerge(s.auto_merge !== "false");
=======
>>>>>>> bf9db15 (feat: add board monitor visualization panel)
=======
        setAutoReview(s.auto_review !== "false");
        setAutoMerge(s.auto_merge !== "false");
>>>>>>> f974211 (feat: conditionally show AI Reviewed column and fix stats colors)
=======
        setAutoReview(s.auto_review !== "false");
        setAutoMerge(s.auto_merge !== "false");
>>>>>>> 0c15856 (fix: restore BoardPage.tsx from clean base and re-apply monitor enhancements with issueId/auto_start)
=======
        setAutoReview(s.auto_review !== "false");
        setAutoMerge(s.auto_merge !== "false");
>>>>>>> 52ef66c (fix: repair pre-existing build errors (smart quotes in cli.ts, truncated TableView/BoardPage from bad merge))
        setAutoMonitor(s.auto_monitor === "true");
        setAutoMonitorInterval(s.auto_monitor_interval ?? "4");
        setNudgeAutoStart(s.nudge_auto_start === "true");
        setNudgeWipLimit(s.nudge_wip_limit ?? "5");
        apiFetch<MonitorStatus>("/api/internal/monitor-status")
          .then((r) => setMonitorStatus(r))
          .catch(() => {});
      } catch {
        // ignore
      }
      setLoading(false);
    }
    load();
  }, [loadProjects]);

  useEffect(() => {
    if (!autoMonitor) return;
    const t = setInterval(() => {
      apiFetch<MonitorStatus>("/api/internal/monitor-status")
        .then((r) => setMonitorStatus(r))
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, [autoMonitor]);

  async function toggleAutoMonitor() {
    const next = !autoMonitor;
    setAutoMonitor(next);
    try {
      await apiFetch("/api/preferences/settings", {
        method: "PUT",
        body: JSON.stringify({ auto_monitor: String(next) }),
      });
      const status = await apiFetch<MonitorStatus>("/api/internal/monitor-status");
      setMonitorStatus(status);
    } catch {
      setAutoMonitor(!next);
    }
  }

  async function handleMonitorRunNow() {
    setMonitorRunning(true);
    try {
      await apiFetch("/api/internal/monitor-run", { method: "POST" });
      const s = await apiFetch<MonitorStatus>("/api/internal/monitor-status");
      setMonitorStatus(s);
    } finally {
      setMonitorRunning(false);
    }
  }

  async function handleIntervalChange(v: string) {
    setAutoMonitorInterval(v);
    await apiFetch("/api/preferences/settings", { method: "PUT", body: JSON.stringify({ auto_monitor_interval: v }) }).catch(() => {});
  }

  async function handleNudgeAutoStartChange(v: boolean) {
    setNudgeAutoStart(v);
    await apiFetch("/api/preferences/settings", { method: "PUT", body: JSON.stringify({ nudge_auto_start: String(v) }) }).catch(() => {});
  }

  async function handleNudgeWipLimitChange(v: string) {
    setNudgeWipLimit(v);
    await apiFetch("/api/preferences/settings", { method: "PUT", body: JSON.stringify({ nudge_wip_limit: v }) }).catch(() => {});
  }

  async function handleProjectChange(id: string) {
    setActiveProjectId(id);
    try {
      await apiFetch("/api/preferences/active-project", {
        method: "PUT",
        body: JSON.stringify({ projectId: id }),
      });
      await refetchBoard(id);
    } catch (err) {
      showToast("Failed to switch project", "error");
    }
  }

  async function handleRegisterProject({ repoPath, gitignoreTemplate, generateReadme }: { repoPath: string; gitignoreTemplate: string; generateReadme: boolean }) {
    const result = await apiFetch<{ id: string; name: string; error?: string }>(
      "/api/projects",
      { method: "POST", body: JSON.stringify({ repoPath, gitignoreTemplate: gitignoreTemplate || undefined, generateReadme: generateReadme || undefined }) },
    );
    if (result.error) throw new Error(result.error);
    await loadProjects();
    await handleProjectChange(result.id);
    showToast(`Registered "${result.name}"`, "success");
  }

  async function handleCreateProject(name: string, path: string) {
    const body: Record<string, string> = { name };
    if (path) body.path = path;
    const result = await apiFetch<{ id: string; name: string; error?: string }>(
      "/api/projects/create",
      { method: "POST", body: JSON.stringify(body) },
    );
    if (result.error) throw new Error(result.error);
    await loadProjects();
    await handleProjectChange(result.id);
    showToast(`Created "${result.name}"`, "success");
  }

  async function handleCreateIssue(data: CreateIssueRequest & { startWorkspace?: boolean; planMode?: boolean; claudeProfile?: string; isDirect?: boolean; skillId?: string }) {
    setMutating(true);
    setError(null);
    const { startWorkspace, planMode, claudeProfile, isDirect, skillId, ...issueData } = data;
    try {
      const created = await apiFetch<{ id: string; issueNumber: number; title: string }>(
        "/api/issues",
        { method: "POST", body: JSON.stringify(issueData) },
      );
      setCreatingInColumnId(null);
      setExpandedCreatePanel(null);
      const board = await refetchBoard();
      pendingBoardRefreshRef.current = false;

      if (startWorkspace && activeProject) {
        try {
          const branch = suggestBranchName({
            issueNumber: created.issueNumber,
            title: created.title,
          });
          const ws = await apiFetch<{ id: string; sessionId?: string }>("/api/workspaces", {
            method: "POST",
            body: JSON.stringify({
              issueId: created.id,
              branch: isDirect ? undefined : branch,
              baseBranch: isDirect ? undefined : activeProject.defaultBranch,
              isDirect: isDirect || undefined,
              planMode: planMode || undefined,
              claudeProfile: claudeProfile || undefined,
              skillId: skillId || undefined,
            }),
          });
          for (const col of board ?? columns) {
            const found = col.issues.find((i) => i.id === created.id);
            if (found) {
              setWorkspaceIssue(found);
              if (ws.sessionId) {
                setWorkspaceInitial({ workspaceId: ws.id, sessionId: ws.sessionId });
              }
              break;
            }
          }
          showToast("Issue and workspace created", "success");
        } catch {
          showToast("Issue created, but workspace creation failed", "error");
        }
      } else {
        showToast("Issue created", "success");
      }
    } catch (err) {
      showToast("Failed to create issue", "error");
    } finally {
      setMutating(false);
    }
  }

  async function handleUpdateIssue(id: string, data: UpdateIssueRequest) {
    setMutating(true);
    setError(null);
    try {
      await apiFetch(`/api/issues/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      const board = await refetchBoard();
      // Re-find updated issue in new columns to keep panel open (F1)
      // refetchBoard now returns the board data
      void board; // used below via columns state update
      showToast("Issue updated", "success");
    } catch (err) {
      showToast("Failed to update issue", "error");
    } finally {
      setMutating(false);
    }
  }

  async function handleDeleteIssue(id: string) {
    setMutating(true);
    setError(null);
    try {
      await apiFetch(`/api/issues/${id}`, { method: "DELETE" });
      setSelectedIssue(null);
      await refetchBoard();
      showToast("Issue deleted", "success");
    } catch (err) {
      showToast("Failed to delete issue", "error");
    } finally {
      setMutating(false);
    }
  }

  function handleDragStart(e: React.DragEvent, issue: IssueWithStatus) {
    e.dataTransfer.setData("application/json", JSON.stringify({
      issueId: issue.id,
      sourceStatusId: issue.statusId,
    }));
    e.dataTransfer.effectAllowed = "move";
  }

  async function handleDrop(targetStatusId: string, sortOrder?: number) {
    try {
      const raw = (window as unknown as Record<string, unknown>).__dragData;
      let issueId: string | undefined;
      let sourceStatusId: string | undefined;

      // Read from dataTransfer wasn't stored, so we use a global bridge
      if (raw && typeof raw === "object") {
        const data = raw as { issueId: string; sourceStatusId: string };
        issueId = data.issueId;
        sourceStatusId = data.sourceStatusId;
      }

      if (!issueId) return;
      if (sourceStatusId === targetStatusId && sortOrder === undefined) return;

      const targetColumn = columns.find((col) => col.id === targetStatusId);
      const isArchiveTarget = targetColumn && ARCHIVE_STATUS_NAMES.has(targetColumn.name);

      if (isArchiveTarget) {
        const issue = columns.flatMap((c) => c.issues).find((i) => i.id === issueId);
        const ws = issue?.workspaceSummary?.main;
        if (issue && ws && ws.status !== "closed") {
          setMoveToDonePending({
            issue,
            confirm: async () => {
              const body: UpdateIssueRequest = { statusId: targetStatusId };
              if (sortOrder !== undefined) body.sortOrder = sortOrder;
              await apiFetch(`/api/issues/${issueId}`, { method: "PATCH", body: JSON.stringify(body) });
              await refetchBoard();
              setMoveToDonePending(null);
            },
          });
          return;
        }
      }

      const body: UpdateIssueRequest = { statusId: targetStatusId };
      if (sortOrder !== undefined) body.sortOrder = sortOrder;

      await apiFetch(`/api/issues/${issueId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      await refetchBoard();
    } catch (err) {
      showToast("Failed to move issue", "error");
    }
  }

  function handleIssueClick(issue: IssueWithStatus) {
    setSelectedIssue(issue);
  }

  function handleManageWorkspaces(issue: IssueWithStatus, workspaceId?: string) {
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    setWorkspaceOpenCreate(false);
    if (workspaceId) {
      setWorkspaceInitial({ workspaceId, sessionId: "" });
    }
  }

  function handleStartWorkspace(issue: IssueWithStatus) {
    setSelectedIssue(null);
    setWorkspaceIssue(issue);
    setWorkspaceInitial(null);
    setWorkspaceOpenCreate(true);
  }

  // Filter columns by search query and priority
<<<<<<< HEAD
<<<<<<< HEAD
=======

>>>>>>> 34777de (fix: restore filteredColumns useMemo lost during conflict resolution in BoardPage.tsx)
=======
>>>>>>> 0c15856 (fix: restore BoardPage.tsx from clean base and re-apply monitor enhancements with issueId/auto_start)
=======
>>>>>>> 52ef66c (fix: repair pre-existing build errors (smart quotes in cli.ts, truncated TableView/BoardPage from bad merge))
  const filteredColumns = useMemo(
    () =>
      columns.map((col) => ({
        ...col,
        issues: col.issues.filter((issue) => {
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
          if (blockedFilter && !(issue as IssueWithStatus & { isBlocked?: boolean }).isBlocked) return false;
=======
          if (priorityFilter && issue.priority !== priorityFilter) return false;
>>>>>>> 53a9dc5 (feat: remove blocked filter from board main page)
=======
          if (priorityFilter && issue.priority !== priorityFilter) return false;
>>>>>>> 029ede6 (feat: remove blocked filter from board main page)
=======
          if (priorityFilter && issue.priority !== priorityFilter) return false;
<<<<<<< HEAD
=======
          if (blockedFilter && !(issue as IssueWithStatus & { isBlocked?: boolean }).isBlocked) return false;
>>>>>>> 5651f2d (feat: remove priority filter from frontend UI)
<<<<<<< HEAD
>>>>>>> 46e7ac8 (feat: remove priority filter from frontend UI)
=======
=======
>>>>>>> 4f0c0a0 (feat: remove blocked filter from board main page)
>>>>>>> 4a222f1 (feat: remove blocked filter from board main page)
=======
>>>>>>> f903991 (feat: conditionally show AI Reviewed column and fix stats colors)
=======
          if (priorityFilter && issue.priority !== priorityFilter) return false;
>>>>>>> 34777de (fix: restore filteredColumns useMemo lost during conflict resolution in BoardPage.tsx)
=======
>>>>>>> 0c15856 (fix: restore BoardPage.tsx from clean base and re-apply monitor enhancements with issueId/auto_start)
=======
>>>>>>> 52ef66c (fix: repair pre-existing build errors (smart quotes in cli.ts, truncated TableView/BoardPage from bad merge))
=======
          if (showBlocked && !(issue as IssueWithStatus & { isBlocked?: boolean }).isBlocked) {
            return false;
          }
>>>>>>> 34c67d9 (feat: add E2E tests for board stats bar and Blocked filter)
          if (searchQuery) {
            const q = searchQuery.toLowerCase();
            return (
              issue.title.toLowerCase().includes(q) ||
              (issue.description?.toLowerCase().includes(q) ?? false)
            );
          }
          return true;
        }),
      })),
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
    [columns, searchQuery],
<<<<<<< HEAD
  );

  // "AI Reviewed" = tickets needing human attention (manual merge).
  // Hide the column when no tickets are there AND the workflow won't produce them
  // (auto_review off, or auto_merge on means review goes straight to Done).
  const showAiReviewedColumn = useMemo(
    () =>
      columns.some((col) => col.name === "AI Reviewed" && col.issues.length > 0) ||
      (autoReview && !autoMerge),
    [columns, autoReview, autoMerge],
=======
>>>>>>> 46e7ac8 (feat: remove priority filter from frontend UI)
=======
    [columns, searchQuery, priorityFilter],
>>>>>>> 34777de (fix: restore filteredColumns useMemo lost during conflict resolution in BoardPage.tsx)
=======
    [columns, searchQuery],
>>>>>>> 0c15856 (fix: restore BoardPage.tsx from clean base and re-apply monitor enhancements with issueId/auto_start)
=======
    [columns, searchQuery, showBlocked],
>>>>>>> 34c67d9 (feat: add E2E tests for board stats bar and Blocked filter)
  );

  // "AI Reviewed" = tickets needing human attention (manual merge).
  // Hide the column when no tickets are there AND the workflow won't produce them
  // (auto_review off, or auto_merge on means review goes straight to Done).
  const showAiReviewedColumn = useMemo(
    () =>
      columns.some((col) => col.name === "AI Reviewed" && col.issues.length > 0) ||
      (autoReview && !autoMerge),
    [columns, autoReview, autoMerge],
  );

  const backlogColumn = useMemo(
    () => filteredColumns.find((col) => col.name === BACKLOG_STATUS_NAME),
    [filteredColumns],
  );

  const activeColumns = useMemo(
    () =>
      filteredColumns.filter(
        (col) =>
          !ARCHIVE_STATUS_NAMES.has(col.name) &&
          col.name !== BACKLOG_STATUS_NAME &&
          (col.name !== "AI Reviewed" || showAiReviewedColumn),
      ),
    [filteredColumns, showAiReviewedColumn],
  );
  const archiveColumns = useMemo(
    () => filteredColumns.filter((col) => ARCHIVE_STATUS_NAMES.has(col.name)),
    [filteredColumns],
  );

  function toggleGroup(group: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl+K to open command palette
      if (e.key === "k" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        setShowCommandPalette(true);
        return;
      }
      // "/" to focus search
      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        const input = document.getElementById("search-input") as HTMLInputElement | null;
        if (input) {
          input.focus();
          // Clear any stray "/" that leaked through before focus shift
          requestAnimationFrame(() => {
            if (input.value === "/") {
              input.value = "";
              setSearchQuery("");
            }
          });
        }
      }
      // Escape to close palette / shortcut help / clear search / close panels
      if (e.key === "Escape") {
        if (showCommandPalette) {
          setShowCommandPalette(false);
          return;
        }
        if (showAllWorkspaces) {
          setShowAllWorkspaces(false);
          return;
        }
        if (showWorktreeOverview) {
          setShowWorktreeOverview(false);
          return;
        }
        if (showShortcutHelp) {
          setShowShortcutHelp(false);
          return;
        }
        if (searchQuery) {
          setSearchQuery("");
          document.getElementById("search-input")?.blur();
        }
      }
      // "?" to show keyboard shortcuts
      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        setShowShortcutHelp((prev) => !prev);
      }
      // "g+s" chord to open settings; "g" alone switches to graph view
      if (e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        pendingGRef.current = true;
        if (pendingGTimerRef.current) clearTimeout(pendingGTimerRef.current);
        pendingGTimerRef.current = setTimeout(() => {
          if (pendingGRef.current) {
            pendingGRef.current = false;
            setViewMode("graph");
          }
        }, 400);
        return;
      }
      // complete "g+s" chord or handle standalone "b"/"t" view switches
      if (e.key === "s" && pendingGRef.current && !e.ctrlKey && !e.metaKey && !e.altKey) {
        pendingGRef.current = false;
        if (pendingGTimerRef.current) { clearTimeout(pendingGTimerRef.current); pendingGTimerRef.current = null; }
        e.preventDefault();
        setShowSettings(true);
        return;
      }
      if ((e.key === "b" || e.key === "t") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        if (e.key === "b") setViewMode("kanban");
        else if (e.key === "t") setViewMode("table");
        return;
      }
      // "a" to toggle All Workspaces panel
      if (e.key === "a" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        setShowAllWorkspaces(prev => !prev);
        return;
      }
      // "q" to open Quick Tasks panel
      if (e.key === "q" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        setShowQuickTasks(true);
        return;
      }
      // "c" to create issue, "w" to create issue + workspace
      if ((e.key === "c" || e.key === "w") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
        e.preventDefault();
        const col = filteredColumns[0] ?? columns[0];
        if (!col) return;
        if (e.key === "w") {
          setExpandedCreatePanel({ statusId: col.id, statusName: col.name, state: { startWorkspace: true } });
        } else {
          setCreatingInColumnId(col.id);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchQuery, showCommandPalette, showAllWorkspaces, showWorktreeOverview, showShortcutHelp, filteredColumns, columns, setViewMode, setShowQuickTasks, setShowSettings]);

  // Register command palette actions
  useEffect(() => {
    const unregisters: (() => void)[] = [];

    unregisters.push(registerAction({
      id: "create-issue",
      label: "Create Issue",
      description: "Add a new issue to the board",
      icon: "+",
      shortcut: "c",
      category: "issue",
      handler: () => {
        if (filteredColumns.length > 0) {
          setCreatingInColumnId(filteredColumns[0].id);
        }
      },
    }));

    unregisters.push(registerAction({
      id: "create-issue-with-workspace",
      label: "New Issue + Start Workspace",
      shortcut: "w",
      category: "issue",
      handler: () => {
        const col = filteredColumns[0] ?? columns[0];
        if (col) {
          setExpandedCreatePanel({ statusId: col.id, statusName: col.name, state: { startWorkspace: true } });
        }
      },
    }));

    unregisters.push(registerAction({
      id: "switch-project",
      label: "Switch Project",
      description: "Change the active project",
      icon: "⇄",
      category: "navigation",
      handler: () => {
        document.querySelector<HTMLButtonElement>("[data-project-switcher]")?.click();
      },
    }));

    unregisters.push(registerAction({
      id: "open-settings",
      label: "Open Settings",
      description: "Configure agent, preferences, and project settings",
      icon: "⚙",
      category: "settings",
      handler: () => setShowSettings(true),
    }));

    unregisters.push(registerAction({
      id: "view-all-workspaces",
      label: "All Workspaces",
      description: "View all workspaces with status, diff stats, and session activity",
      icon: "⊞",
      category: "navigation",
      handler: () => setShowAllWorkspaces(true),
    }));

    unregisters.push(registerAction({
      id: "view-worktrees",
      label: "View Worktrees",
      description: "Inspect git worktrees and their diff stats",
      icon: "⎇",
      category: "navigation",
      handler: () => setShowWorktreeOverview(true),
    }));

    unregisters.push(registerAction({
      id: "search-issues",
      label: "Search Issues",
      description: "Filter issues by text or keyword",
      icon: "⌕",
      shortcut: "/",
      category: "board",
      handler: () => document.getElementById("search-input")?.focus(),
    }));

    unregisters.push(registerAction({
      id: "show-shortcuts",
      label: "Keyboard Shortcuts",
      description: "View all available keyboard shortcuts",
      icon: "?",
      shortcut: "?",
      category: "settings",
      handler: () => setShowShortcutHelp(true),
    }));

    unregisters.push(registerAction({
      id: "open-quick-tasks",
      label: "Open Quick Tasks",
      description: "View installed skills and run custom agent tasks",
      icon: "⚡",
      shortcut: "q",
      category: "board",
      handler: () => setShowQuickTasks(true),
    }));

    unregisters.push(registerAction({
      id: "view-board",
      label: "Switch to Board View",
      description: "Show kanban board columns",
      icon: "⊟",
      shortcut: "b",
      category: "navigation",
      handler: () => setViewMode("kanban"),
    }));

    unregisters.push(registerAction({
      id: "view-graph",
      label: "Switch to Graph View",
      description: "Show dependency graph",
      icon: "⬡",
      shortcut: "g",
      category: "navigation",
      handler: () => setViewMode("graph"),
    }));

    unregisters.push(registerAction({
      id: "view-table",
      label: "Switch to Table View",
      description: "Show flat table list",
      icon: "☰",
      shortcut: "t",
      category: "navigation",
      handler: () => setViewMode("table"),
    }));

    // Register "Go to: [column]" for each column
    for (const col of columns) {
      unregisters.push(registerAction({
        id: `goto-${col.id}`,
        label: `Go to: ${col.name}`,
        description: `Scroll to the ${col.name} column`,
        category: "navigation",
        handler: () => {
          const el = document.getElementById(`column-${col.id}`);
          el?.scrollIntoView({ behavior: "smooth", inline: "center" });
        },
      }));
    }

    // Register Review and Merge actions for issues with eligible workspaces
    const allIssues = columns.flatMap((col) => col.issues);
    for (const issue of allIssues) {
      const ws = issue.workspaceSummary?.main;
      if (!ws) continue;

      if (ws.status === "active" || ws.status === "idle" || ws.status === "reviewing") {
        unregisters.push(registerAction({
          id: `review-workspace-${ws.id}`,
          label: `Review: #${issue.issueNumber} ${issue.title}`,
          description: "Trigger AI code review for this workspace",
          icon: "⑃",
          category: "issue",
          handler: async () => {
            try {
              await apiFetch(`/api/workspaces/${ws.id}/review`, { method: "POST" });
              showToast("Review started", "success");
            } catch {
              showToast("Failed to start review", "error");
            }
          },
        }));
      }

      if (ws.status === "reviewing" || ws.status === "idle") {
        unregisters.push(registerAction({
          id: `merge-workspace-${ws.id}`,
          label: `Merge: #${issue.issueNumber} ${issue.title}`,
          description: "Merge this workspace branch into the base branch",
          icon: "⤵",
          category: "issue",
          handler: async () => {
            try {
              await apiFetch(`/api/workspaces/${ws.id}/merge`, { method: "POST" });
              showToast("Merge started", "success");
            } catch {
              showToast("Failed to merge", "error");
            }
          },
        }));
      }
    }

    return () => unregisters.forEach((fn) => fn());
  }, [columns, filteredColumns]);

  if (loading) {
    return (
      <Layout onRegisterProject={handleRegisterProject} onCreateProject={handleCreateProject}>
        <SkeletonBoard />
      </Layout>
    );
  }

  // No projects registered
  if (projects.length === 0 || !activeProjectId) {
    return (
      <Layout onRegisterProject={handleRegisterProject} onCreateProject={handleCreateProject}>
        <div className="flex items-center justify-center h-96 text-gray-500">
          <div className="text-center">
            <p className="text-lg font-medium text-gray-700 mb-2">
              No projects registered
            </p>
            <p className="text-sm text-gray-500">
              Click the <strong>+</strong> button in the header to register a git repo as a project.
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const canStartWorkspace = !!activeProject?.repoPath;

  return (
    <Layout
      projects={projects}
      activeProjectId={activeProjectId}
      onProjectChange={handleProjectChange}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      onRegisterProject={handleRegisterProject}
      onCreateProject={handleCreateProject}
      onSettingsClick={() => setShowSettings(true)}
      onAllWorkspacesClick={() => setShowAllWorkspaces(true)}
      onWorktreeOverviewClick={() => setShowWorktreeOverview(true)}
    >
      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-md flex items-center justify-between">
          <span className="text-sm text-red-700">{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-600 text-sm"
          >
            Dismiss
          </button>
        </div>
      )}
      {mutating && (
        <div className="fixed bottom-4 right-4 z-50">
          <div className="bg-blue-600 text-white rounded-lg px-4 py-2 flex items-center gap-2 shadow-lg">
            <svg
              className="animate-spin h-4 w-4 text-white"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="text-sm font-medium">Saving...</span>
          </div>
        </div>
      )}
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
      <div className="flex flex-col gap-3 p-4 h-full overflow-hidden">
<<<<<<< HEAD
=======
      <div className="flex flex-col gap-2 sm:gap-3 p-2 sm:p-4 h-full overflow-hidden">
>>>>>>> 65f7a08 (feat: make kanban board truly responsive for mobile)
        <div className="flex items-center gap-2 flex-wrap">
=======
      <div className="flex flex-col gap-3 p-4 h-full overflow-hidden">
<<<<<<< HEAD
        <div className="flex items-center gap-3">
>>>>>>> 5d43535 (revert: remove table view and revert mobile-responsive board styling)
=======
        <div className="flex items-center gap-2 flex-wrap">
>>>>>>> e318eb3 (feat: add table view as third board view alongside kanban and graph)
=======
      <div className="flex flex-col gap-2 sm:gap-3 p-2 sm:p-4 h-full overflow-hidden">
        <div className="flex items-center gap-2 flex-wrap">
>>>>>>> e0c9cf4 (feat: make kanban board truly responsive for mobile)
=======
      <div className="flex flex-col gap-3 p-4 h-full overflow-hidden">
<<<<<<< HEAD
        <div className="flex items-center gap-3">
>>>>>>> 8f2f90d (revert: remove table view and revert mobile-responsive board styling)
=======
        <div className="flex items-center gap-2 flex-wrap">
>>>>>>> 9878a53 (feat: add table view as third board view alongside kanban and graph)
=======
      <div className="flex flex-col gap-2 sm:gap-3 p-2 sm:p-4 h-full overflow-hidden">
        <div className="flex items-center gap-2 flex-wrap">
>>>>>>> f0547d3 (feat: make kanban board truly responsive for mobile)
=======
      <div className="flex flex-col gap-3 p-4 h-full overflow-hidden">
<<<<<<< HEAD
        <div className="flex items-center gap-3">
>>>>>>> f2da112 (revert: remove table view and revert mobile-responsive board styling)
=======
        <div className="flex items-center gap-2 flex-wrap">
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
=======
        <div className="flex items-start gap-2 flex-wrap">
>>>>>>> 9dd8920 (feat: redesign BoardStats with pills, progress bar, and status legend)
          <BoardStats
            activeColumns={activeColumns}
            archiveColumns={archiveColumns}
            searchQuery={searchQuery}
            projectId={activeProjectId}
            showBlocked={showBlocked}
            onToggleBlocked={() => setShowBlocked((v) => !v)}
          />
=======
      <div className="flex flex-col gap-2 p-4 h-full overflow-hidden">
        <BoardStats
          activeColumns={activeColumns}
          archiveColumns={archiveColumns}
          searchQuery={searchQuery}
          projectId={activeProjectId}
          showBlocked={showBlocked}
          onToggleBlocked={() => setShowBlocked((v) => !v)}
        />
        <div className="flex items-start gap-2 flex-wrap">
>>>>>>> a52a9fb (feat: move BoardStats to its own row and make progress bar full-width)
          {backlogColumn !== undefined && (
            <BacklogPanel
              backlogColumn={backlogColumn}
              activeColumns={activeColumns}
              searchQuery={searchQuery}
              onIssueClick={handleIssueClick}
              onMoved={() => refetchBoard()}
            />
          )}
          <button
            onClick={() => setShowQuickTasks(true)}
            title="Quick Tasks — run a skill directly on the main branch (t)"
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <polygon points="5,3 19,12 5,21" />
            </svg>
            Tasks
          </button>
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
          {autoMonitor && (
            <div className="relative shrink-0">
              <button
                onClick={() => setShowMonitorPopover(v => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-green-50 border-green-200 text-green-700 hover:bg-green-100"
                title="Board monitor active — click for details"
              >
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                Monitor
              </button>
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 47c4344 (feat: make monitor action log entries clickable workspace links)
=======
>>>>>>> f7a87fc (feat: make monitor action log entries clickable workspace links)
              {showMonitorPopover && <MonitorPopover
                status={monitorStatus}
                onClose={() => setShowMonitorPopover(false)}
                columns={columns}
                onOpenWorkspace={(workspaceId, issueId) => {
                  const issue = columns.flatMap(c => c.issues).find(i => i.id === issueId);
                  if (issue) handleManageWorkspaces(issue, workspaceId);
                }}
              />}
<<<<<<< HEAD
<<<<<<< HEAD
=======
              {showMonitorPopover && <MonitorPopover status={monitorStatus} onClose={() => setShowMonitorPopover(false)} />}
>>>>>>> 01516bd (feat: add board monitor visualization panel)
=======
>>>>>>> 47c4344 (feat: make monitor action log entries clickable workspace links)
=======
              {showMonitorPopover && <MonitorPopover status={monitorStatus} onClose={() => setShowMonitorPopover(false)} />}
>>>>>>> 1407a7f (feat: add board monitor visualization panel)
=======
>>>>>>> f7a87fc (feat: make monitor action log entries clickable workspace links)
=======
              {showMonitorPopover && <MonitorPopover status={monitorStatus} onClose={() => setShowMonitorPopover(false)} />}
>>>>>>> bf9db15 (feat: add board monitor visualization panel)
=======
              {showMonitorPopover && <MonitorPopover status={monitorStatus} onClose={() => setShowMonitorPopover(false)} onOpenWorkspace={(workspaceId, issueId) => { const issue = columns.flatMap(c => c.issues).find(i => i.id === issueId); if (issue) setWorkspaceIssue(issue); setWorkspaceInitial({ workspaceId, sessionId: "" }); }} columns={columns} />}
>>>>>>> 0c15856 (fix: restore BoardPage.tsx from clean base and re-apply monitor enhancements with issueId/auto_start)
=======
              {showMonitorPopover && <MonitorPopover status={monitorStatus} onClose={() => setShowMonitorPopover(false)} onOpenWorkspace={(workspaceId, issueId) => { const issue = columns.flatMap(c => c.issues).find(i => i.id === issueId); if (issue) setWorkspaceIssue(issue); setWorkspaceInitial({ workspaceId, sessionId: "" }); }} columns={columns} />}
>>>>>>> 52ef66c (fix: repair pre-existing build errors (smart quotes in cli.ts, truncated TableView/BoardPage from bad merge))
=======
              {showMonitorPopover && <MonitorPopover status={monitorStatus} onClose={() => setShowMonitorPopover(false)} onOpenWorkspace={(workspaceId, issueId) => { const issue = columns.flatMap(c => c.issues).find(i => i.id === issueId); if (issue) setWorkspaceIssue(issue); setWorkspaceInitial({ workspaceId, sessionId: "" }); }} columns={columns} onRunNow={async () => { await apiFetch("/api/internal/monitor-run", { method: "POST" }); const s = await apiFetch<MonitorStatus>("/api/internal/monitor-status"); setMonitorStatus(s); }} />}
>>>>>>> 1adff89 (feat: add Run now button to monitor popover (#220))
            </div>
          )}
=======
          <div className="relative shrink-0">
=======
          <div className="relative shrink-0 flex items-center gap-0.5">
>>>>>>> 77d9d10 (feat: add Run Now button to board toolbar next to Monitor button)
=======
          <div ref={monitorAnchorRef} className="relative shrink-0 flex items-center gap-0.5">
>>>>>>> 7a1bfb9 (fix: board monitor popover stays within viewport, scrollable content)
            <button
              onClick={() => setShowMonitorPopover(v => !v)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${autoMonitor ? "bg-green-50 border-green-200 text-green-700 hover:bg-green-100" : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"}`}
              title={autoMonitor ? "Board monitor active — click for details" : "Board monitor — click to configure"}
            >
              {autoMonitor && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
              Monitor
            </button>
            <button
              onClick={handleMonitorRunNow}
              disabled={monitorRunning}
              className="flex items-center justify-center w-6 h-6 rounded border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Run monitor now and reset timer"
            >
              {monitorRunning
                ? <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                : <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z"/></svg>
              }
            </button>
            {showMonitorPopover && <MonitorPopover status={monitorStatus} onClose={() => setShowMonitorPopover(false)} onOpenWorkspace={(workspaceId, issueId) => { const issue = columns.flatMap(c => c.issues).find(i => i.id === issueId); if (issue) setWorkspaceIssue(issue); setWorkspaceInitial({ workspaceId, sessionId: "" }); }} columns={columns} onRunNow={handleMonitorRunNow} autoMonitor={autoMonitor} onToggle={toggleAutoMonitor} interval={autoMonitorInterval} onIntervalChange={handleIntervalChange} nudgeAutoStart={nudgeAutoStart} onNudgeAutoStartChange={handleNudgeAutoStartChange} nudgeWipLimit={nudgeWipLimit} onNudgeWipLimitChange={handleNudgeWipLimitChange} anchorRef={monitorAnchorRef} />}
          </div>
>>>>>>> 693fe5c (feat: move monitor toggle and settings to board view popover)
          <div className="flex items-center gap-1 border border-gray-200 rounded-md p-0.5 bg-white shrink-0">
            <button
              onClick={() => setViewMode("kanban")}
              className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "kanban" ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}
              title="Kanban view"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="3" width="5" height="18" rx="1" />
                <rect x="10" y="3" width="5" height="14" rx="1" />
                <rect x="17" y="3" width="5" height="10" rx="1" />
              </svg>
              Board
            </button>
            <button
              onClick={() => setViewMode("graph")}
              className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "graph" ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}
              title="Graph view"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="5" cy="12" r="2" />
                <circle cx="19" cy="5" r="2" />
                <circle cx="19" cy="19" r="2" />
                <path d="M7 12h6M15 6.5l-4 4M15 17.5l-4-4" />
              </svg>
              Graph
            </button>
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> e318eb3 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> 770082f (feat: add table view as third board view alongside board and graph)
=======
>>>>>>> 9878a53 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> b06ea29 (feat: add table view as third board view alongside board and graph)
=======
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
            <button
              onClick={() => setViewMode("table")}
              className={`px-2.5 py-1 text-xs rounded flex items-center gap-1.5 transition-colors ${viewMode === "table" ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}
              title="Table view"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
                <path d="M3 6h18M3 12h18M3 18h18M8 6v12" />
=======
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18M3 15h18M9 3v18" />
>>>>>>> 7c9ead0 (feat: add table view as third board view alongside board and graph)
              </svg>
              Table
            </button>
=======
>>>>>>> 5d43535 (revert: remove table view and revert mobile-responsive board styling)
=======
=======
>>>>>>> 9878a53 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
                <path d="M3 6h18M3 12h18M3 18h18M8 6v12" />
              </svg>
              Table
            </button>
<<<<<<< HEAD
<<<<<<< HEAD
>>>>>>> e318eb3 (feat: add table view as third board view alongside kanban and graph)
=======
=======
>>>>>>> b06ea29 (feat: add table view as third board view alongside board and graph)
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18M3 15h18M9 3v18" />
              </svg>
              Table
            </button>
<<<<<<< HEAD
>>>>>>> 770082f (feat: add table view as third board view alongside board and graph)
=======
>>>>>>> 8f2f90d (revert: remove table view and revert mobile-responsive board styling)
=======
>>>>>>> 9878a53 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> b06ea29 (feat: add table view as third board view alongside board and graph)
=======
>>>>>>> f2da112 (revert: remove table view and revert mobile-responsive board styling)
=======
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
          </div>
        </div>
        {viewMode === "graph" && activeProjectId ? (
          <div className="flex-1 min-h-0">
            <GraphView
              columns={columns}
              projectId={activeProjectId}
              onIssueClick={handleIssueClick}
              searchQuery={searchQuery}
            />
          </div>
        ) : null}
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> e318eb3 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> 770082f (feat: add table view as third board view alongside board and graph)
=======
>>>>>>> 9878a53 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> b06ea29 (feat: add table view as third board view alongside board and graph)
=======
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
        {viewMode === "table" && (
          <TableView
            columns={columns}
            onIssueClick={handleIssueClick}
            searchQuery={searchQuery}
          />
        )}
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> e318eb3 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> 9878a53 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
        {viewMode === "kanban" && activeColumns.length > 1 && (
          <div className="flex sm:hidden gap-1 overflow-x-auto scrollbar-hide shrink-0">
            {activeColumns.map((col) => (
              <button
                key={col.id}
                onClick={() => {
                  document.getElementById(`column-${col.id}`)?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
                }}
                className="shrink-0 px-3 py-1 text-xs rounded-full border border-gray-200 bg-white text-gray-600 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 transition-colors"
              >
                {col.name}
                <span className="ml-1 text-gray-400">{col.issues.length}</span>
              </button>
            ))}
          </div>
        )}
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 7c9ead0 (feat: add table view as third board view alongside board and graph)
=======
>>>>>>> e318eb3 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> 770082f (feat: add table view as third board view alongside board and graph)
=======
>>>>>>> 9878a53 (feat: add table view as third board view alongside kanban and graph)
=======
>>>>>>> b06ea29 (feat: add table view as third board view alongside board and graph)
=======
>>>>>>> ab93bc6 (feat: add table view as third board view alongside kanban and graph)
        {viewMode === "kanban" && <div className="flex gap-4 flex-1 min-h-0 overflow-x-auto board-columns-scroll">
=======
        {viewMode === "kanban" && <div className="flex gap-2 sm:gap-4 flex-1 min-h-0 overflow-x-auto board-columns-scroll">
>>>>>>> 65f7a08 (feat: make kanban board truly responsive for mobile)
=======
        {viewMode === "kanban" && <div className="flex gap-4 flex-1 min-h-0 overflow-x-auto board-columns-scroll">
>>>>>>> 5d43535 (revert: remove table view and revert mobile-responsive board styling)
=======
        {viewMode === "kanban" && <div className="flex gap-2 sm:gap-4 flex-1 min-h-0 overflow-x-auto board-columns-scroll">
>>>>>>> e0c9cf4 (feat: make kanban board truly responsive for mobile)
=======
        {viewMode === "kanban" && <div className="flex gap-4 flex-1 min-h-0 overflow-x-auto board-columns-scroll">
>>>>>>> 8f2f90d (revert: remove table view and revert mobile-responsive board styling)
=======
        {viewMode === "kanban" && <div className="flex gap-2 sm:gap-4 flex-1 min-h-0 overflow-x-auto board-columns-scroll">
>>>>>>> f0547d3 (feat: make kanban board truly responsive for mobile)
=======
        {viewMode === "kanban" && <div className="flex gap-4 flex-1 min-h-0 overflow-x-auto board-columns-scroll">
>>>>>>> f2da112 (revert: remove table view and revert mobile-responsive board styling)
          {activeColumns.map((col) => (
=======
        {viewMode === "kanban" && <div className="flex gap-0 flex-1 min-h-0 overflow-x-auto board-columns-scroll">
          {activeColumns.map((col, colIdx) => (
>>>>>>> 39947f0 (feat: resizable board columns with drag handles and localStorage persistence)
            <BoardColumn
              key={col.id}
              column={col}
              style={dynamicColumnScaling && !columnWidths[col.id] ? { flexGrow: Math.max(1, col.issues.length) } : undefined}
              width={columnWidths[col.id]}
              onResizeStart={colIdx < activeColumns.length - 1 ? (e) => handleColumnResizeStart(col.id, e) : undefined}
              onResizeReset={colIdx < activeColumns.length - 1 ? () => setColumnWidths((prev) => {
                const next = { ...prev };
                delete next[col.id];
                try { localStorage.setItem("kanban-column-widths", JSON.stringify(next)); } catch {}
                return next;
              }) : undefined}
              projectId={activeProjectId}
              creatingInColumn={creatingInColumnId}
              onCreateClick={setCreatingInColumnId}
              onCreateCancel={() => setCreatingInColumnId(null)}
              onIssueClick={handleIssueClick}
              onWorkspaceClick={handleManageWorkspaces}
              onStartWorkspace={handleStartWorkspace}
              onDragStart={(e, issue) => {
                (window as unknown as Record<string, unknown>).__dragData = {
                  issueId: issue.id,
                  sourceStatusId: issue.statusId,
                };
                handleDragStart(e, issue);
              }}
              onDrop={handleDrop}
              searchQuery={searchQuery}
              sessionActivity={sessionActivity}
              liveStats={liveStats}
              sessionTodos={sessionTodos}
            >
              <CreateIssueForm
                projectId={activeProjectId}
                statusId={col.id}
                onSubmit={handleCreateIssue}
                onCancel={() => setCreatingInColumnId(null)}
                canStartWorkspace={canStartWorkspace}
                onExpand={(state) => {
                  setCreatingInColumnId(null);
                  setExpandedCreatePanel({ statusId: col.id, statusName: col.name, state });
                }}
              />
            </BoardColumn>
          ))}
        </div>}
        {viewMode === "kanban" && <CompletedGrid
          columns={archiveColumns}
          collapsed={collapsedGroups.has("archive")}
          onToggle={() => toggleGroup("archive")}
          onIssueClick={handleIssueClick}
          onDragStart={(e, issue) => {
            (window as unknown as Record<string, unknown>).__dragData = {
              issueId: issue.id,
              sourceStatusId: issue.statusId,
            };
            handleDragStart(e, issue);
          }}
          onDrop={handleDrop}
          searchQuery={searchQuery}
        />}
      </div>
      {selectedIssue && (
        <IssueDetailPanel
          issue={selectedIssue}
          statuses={columns.map((col) => ({ id: col.id, name: col.name }))}
          onUpdate={handleUpdateIssue}
          onDelete={handleDeleteIssue}
          onClose={() => setSelectedIssue(null)}
          onManageWorkspaces={handleManageWorkspaces}
          onStartWorkspace={handleStartWorkspace}
          onIssueUpdate={setSelectedIssue}
          onNavigateToIssue={(issueId) => {
            for (const col of columns) {
              const found = col.issues.find((i) => i.id === issueId);
              if (found) {
                setSelectedIssue(found);
                return;
              }
            }
          }}
        />
      )}
      {workspaceIssue && (
        <WorkspacePanel
          issue={workspaceIssue}
          project={activeProject ?? null}
          onClose={() => { setWorkspaceIssue(null); setWorkspaceInitial(null); setWorkspaceOpenCreate(false); }}
          onWorkspaceChange={() => refetchBoard()}
          initialWorkspaceId={workspaceInitial?.workspaceId}
          initialSessionId={workspaceInitial?.sessionId}
          initialShowCreate={workspaceOpenCreate}
        />
      )}
      <ApprovalDialog
        requests={approvalRequests}
        onResolve={(id) => setApprovalRequests((prev) => prev.filter((r) => r.id !== id))}
      />
      {moveToDonePending && (
        <MoveToDoneDialog
          issue={moveToDonePending.issue}
          onConfirm={moveToDonePending.confirm}
          onCancel={() => setMoveToDonePending(null)}
        />
      )}
      <ToastContainer />
      {showSettings && (
        <SettingsPanel onClose={() => {
          setShowSettings(false);
          apiFetch<Record<string, string>>("/api/preferences/settings")
            .then(s => {
<<<<<<< HEAD
<<<<<<< HEAD
              setAutoReview(s.auto_review !== "false");
              setAutoMerge(s.auto_merge !== "false");
=======
>>>>>>> bf9db15 (feat: add board monitor visualization panel)
=======
              setAutoReview(s.auto_review !== "false");
              setAutoMerge(s.auto_merge !== "false");
>>>>>>> f974211 (feat: conditionally show AI Reviewed column and fix stats colors)
              setAutoMonitor(s.auto_monitor === "true");
              setAutoMonitorInterval(s.auto_monitor_interval ?? "4");
              setNudgeAutoStart(s.nudge_auto_start === "true");
              setNudgeWipLimit(s.nudge_wip_limit ?? "5");
              return apiFetch<MonitorStatus>("/api/internal/monitor-status");
            })
            .then(r => setMonitorStatus(r))
            .catch(() => {});
        }} activeProjectId={activeProjectId} />
      )}
      {showQuickTasks && activeProjectId && (
        <QuickTasksPanel
          projectId={activeProjectId}
          onClose={() => setShowQuickTasks(false)}
          onLaunched={() => refetchBoard()}
        />
      )}
      {showAllWorkspaces && (
        <AllWorkspacesPanel
          columns={columns}
          onClose={() => setShowAllWorkspaces(false)}
          onIssueClick={(issue) => {
            setSelectedIssue(issue);
            setShowAllWorkspaces(false);
          }}
          onRefresh={() => refetchBoard()}
        />
      )}
      {showWorktreeOverview && activeProjectId && (
        <WorktreeOverview
          projectId={activeProjectId}
          onClose={() => setShowWorktreeOverview(false)}
          onIssueClick={(issueId: string) => {
            for (const col of columns) {
              const found = col.issues.find((i) => i.id === issueId);
              if (found) {
                setSelectedIssue(found);
                break;
              }
            }
            setShowWorktreeOverview(false);
          }}
          onWorkspaceChange={() => refetchBoard()}
        />
      )}
      {showCommandPalette && (
        <CommandPalette onClose={() => setShowCommandPalette(false)} />
      )}
      {showShortcutHelp && (
        <ShortcutHelp onClose={() => setShowShortcutHelp(false)} />
      )}
      {expandedCreatePanel && activeProjectId && (
        <CreateIssuePanel
          projectId={activeProjectId}
          statusId={expandedCreatePanel.statusId}
          statusName={expandedCreatePanel.statusName}
          initialState={expandedCreatePanel.state}
          onSubmit={handleCreateIssue}
          onClose={() => setExpandedCreatePanel(null)}
          canStartWorkspace={canStartWorkspace}
        />
      )}
    </Layout>
  );
}
