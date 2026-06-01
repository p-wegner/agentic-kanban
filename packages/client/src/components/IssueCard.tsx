import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function getLastSessionBadge(triggerType: string | null | undefined): { label: string; className: string } | null {
  if (!triggerType) return null;
  const map: Record<string, { label: string; className: string }> = {
    review: { label: "AI Review", className: "bg-accent-50 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300" },
    merge: { label: "AI Merge", className: "bg-emerald-100 text-emerald-700" },
    "fix-conflicts": { label: "Fix Conflicts", className: "bg-orange-100 text-orange-700" },
    learning: { label: "Learning", className: "bg-teal-100 text-teal-700" },
    "auto-start": { label: "Auto-start", className: "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400" },
  };
  if (map[triggerType]) return map[triggerType];
  if (triggerType.startsWith("skill:")) {
    const name = triggerType.slice(6).replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    return { label: `✨ ${name}`, className: "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300" };
  }
  return null;
}

function coverageClass(pct: number): string {
  if (pct >= 80) return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
  if (pct >= 60) return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300";
  return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
}

function commitCountClass(count: number): string {
  if (count <= 0) return "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400";
  if (count <= 3) return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
  if (count <= 10) return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300";
  return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
}

type WorkflowSnapshot = NonNullable<
  NonNullable<NonNullable<IssueWithStatus["workspaceSummary"]>["main"]>["workflow"]
>;

const workflowStateClasses: Record<WorkflowSnapshot["state"], string> = {
  active: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  waiting: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  terminal: "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300",
};

const workflowDotClasses: Record<WorkflowSnapshot["state"], string> = {
  active: "bg-blue-500",
  waiting: "bg-amber-500",
  terminal: "bg-green-500",
};

function WorkflowMiniIndicator({ workflow }: { workflow: WorkflowSnapshot }) {
  const [open, setOpen] = useState(false);
  const nextLabel = workflow.nextStages.length > 0 ? workflow.nextStages.join(", ") : "None";
  const title = `Workflow: ${workflow.currentNodeName}. Next: ${nextLabel}`;

  return (
    <span
      className="relative inline-flex shrink-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        title={title}
        aria-label={title}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`inline-flex max-w-[8.5rem] items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${workflowStateClasses[workflow.state]}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${workflowDotClasses[workflow.state]} ${workflow.state === "active" ? "animate-pulse" : ""}`} />
        <span className="truncate">{workflow.currentNodeName}</span>
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-20 mt-1 w-52 rounded-md border border-gray-200 bg-white p-2 text-left shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <span className="block text-[11px] font-semibold text-gray-800 dark:text-gray-100">
            {workflow.currentNodeName}
          </span>
          <span className="mt-1 block text-[10px] text-gray-500 dark:text-gray-400">
            Next: {nextLabel}
          </span>
        </span>
      )}
    </span>
  );
}

const issueTypeColors: Record<string, string> = {
  task: "bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200",
  bug: "bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200",
  feature: "bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300",
  chore: "bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200",
};

function CodeMetricsBadges({
  commitCount,
  metrics,
}: {
  commitCount?: number | null;
  metrics: NonNullable<NonNullable<IssueWithStatus["workspaceSummary"]>["main"]>["codeMetrics"] | null | undefined;
}) {
  const coverage = metrics?.coverage;
  const lint = metrics?.lint;
  const complexity = metrics?.complexity;

  return (
    <>
      {commitCount !== undefined && commitCount !== null ? (
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${commitCountClass(commitCount)}`}
          title="Commits ahead of base branch"
        >
          +{commitCount}
        </span>
      ) : (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500"
          title="Commit count unavailable"
        >
          commits -
        </span>
      )}
      {coverage ? (
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${coverageClass(coverage.linesPct)}`}
          title={`Line coverage: ${coverage.linesPct}% from ${coverage.source}`}
        >
          cov {Math.round(coverage.linesPct)}%
        </span>
      ) : (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500"
          title={metrics ? "No coverage summary found" : "Code metrics not collected yet"}
        >
          cov -
        </span>
      )}
      {lint && (
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${
            lint.errors > 0 ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" :
            lint.warnings > 0 ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" :
            "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
          }`}
          title={`${lint.errors} lint error(s), ${lint.warnings} warning(s) from ${lint.source}`}
        >
          lint {lint.violations}
        </span>
      )}
      {complexity && (
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${
            complexity.average <= 20 ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" :
            complexity.average <= 40 ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" :
            "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
          }`}
          title={`Heuristic complexity: average ${complexity.average}, max ${complexity.max} across ${complexity.files} source file(s)`}
        >
          cx {complexity.average}
        </span>
      )}
    </>
  );
}

const priorityColors: Record<string, string> = {
  critical: "bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300",
  high: "bg-orange-100 dark:bg-orange-900/50 text-orange-700 dark:text-orange-300",
  medium: "bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300",
  low: "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400",
};

interface TagBadge {
  id: string;
  name: string;
  color: string | null;
}

interface IssueCardProps {
  issue: IssueWithStatus;
  onClick: (issue: IssueWithStatus, event: React.MouseEvent) => void;
  onWorkspaceClick?: (issue: IssueWithStatus, workspaceId?: string) => void;
  onStartWorkspace?: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onMoveToNext?: (issue: IssueWithStatus) => void;
  nextStatusName?: string;
  tags?: TagBadge[];
  searchQuery?: string;
  liveActivity?: string;
  liveStats?: LiveSessionStats;
  todos?: TodoItem[];
  isPendingWorkspace?: boolean;
  isSelected?: boolean;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return <>{text}</>;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);

  return (
    <>
      {before}
      <mark className="bg-yellow-200 rounded px-0.5">{match}</mark>
      {after}
    </>
  );
}

export function IssueCard({ issue, onClick, onWorkspaceClick, onStartWorkspace, onDragStart, onMoveToNext, nextStatusName, tags, searchQuery, liveActivity, liveStats, todos, isPendingWorkspace, isSelected }: IssueCardProps) {
  const typeBadgeColor = issue.issueType ? (issueTypeColors[issue.issueType] ?? null) : null;
  const priorityBadgeColor = issue.priority && issue.priority !== "medium" ? (priorityColors[issue.priority] ?? null) : null;
  const ws = issue.workspaceSummary;
  const hasActiveWorkspace = ws?.main && ws.main.status !== "closed";
  const [depDragOver, setDepDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Determine which action buttons to show in the action row
  const showActionRow = issue.statusName !== "Done" && issue.statusName !== "Cancelled";
  const showResume = showActionRow && hasActiveWorkspace && !!onWorkspaceClick;
  const showStartWorkspace = showActionRow && !hasActiveWorkspace && !!onStartWorkspace;
  const showMoveToNext = showActionRow && !!onMoveToNext && !!nextStatusName;
  const hasAnyAction = showResume || showStartWorkspace || showMoveToNext;

  useEffect(() => {
    if (!contextMenu) return;

    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    firstItem?.focus();

    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setContextMenu(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setContextMenu(null);
        cardRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  function openContextMenu(x: number, y: number) {
    setContextMenu({
      x: Math.min(x, window.innerWidth - 220),
      y: Math.min(y, window.innerHeight - 190),
    });
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY);
  }

  function handleCardKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
    e.preventDefault();
    const rect = cardRef.current?.getBoundingClientRect();
    openContextMenu((rect?.left ?? 0) + 12, (rect?.top ?? 0) + 12);
  }

  function handleMenuKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = e.key === "ArrowDown"
      ? (currentIndex + 1) % items.length
      : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex].focus();
  }

  async function copyIssueReference() {
    const prefix = issue.issueNumber != null ? `#${issue.issueNumber}` : issue.id;
    try {
      await navigator.clipboard.writeText(`${prefix} ${issue.title}`);
      showToast("Issue reference copied", "success");
    } catch {
      showToast("Failed to copy issue reference", "error");
    } finally {
      setContextMenu(null);
    }
  }

  function runContextAction(action: () => void) {
    action();
    setContextMenu(null);
  }

  function handleDragOver(e: React.DragEvent) {
    const dragData = (window as unknown as Record<string, unknown>).__dragData as { issueId?: string; sourceStatusId?: string } | undefined;
    if (dragData?.issueId && dragData.issueId !== issue.id && e.shiftKey) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "link";
      setDepDragOver(true);
    }
  }

  async function handleDrop(e: React.DragEvent) {
    setDepDragOver(false);
    if (!e.shiftKey) return;
    const dragData = (window as unknown as Record<string, unknown>).__dragData as { issueId?: string } | undefined;
    if (!dragData?.issueId || dragData.issueId === issue.id) return;
    e.stopPropagation();
    try {
      await apiFetch(`/api/issues/${dragData.issueId}/dependencies`, {
        method: "POST",
        body: JSON.stringify({ dependsOnId: issue.id, type: "depends_on" }),
      });
      showToast("Dependency added", "success");
    } catch {
      showToast("Failed to add dependency", "error");
    }
  }

  return (
    <div
      ref={cardRef}
      draggable
      tabIndex={0}
      onDragStart={(e) => { setIsDragging(true); onDragStart(e, issue); }}
      onDragEnd={() => setIsDragging(false)}
      onDragOver={handleDragOver}
      onDragLeave={() => setDepDragOver(false)}
      onDrop={handleDrop}
      onClick={(e) => onClick(issue, e)}
      onContextMenu={handleContextMenu}
      onKeyDown={handleCardKeyDown}
      aria-selected={isSelected ? "true" : undefined}
      className={`group bg-surface-raised dark:bg-surface-raised-dark rounded-lg shadow-sm p-2.5 border cursor-pointer hover:shadow-md hover:-translate-y-px transition-all duration-150 relative isolate ${
        isSelected
          ? "border-brand-500 ring-2 ring-brand-400/70 shadow-brand-100 dark:shadow-brand-950"
          : depDragOver ? "border-brand-400 bg-brand-50 shadow-brand-200" : isPendingWorkspace ? "border-brand-300 shadow-brand-100 shadow-md" : "border-black/[0.07] dark:border-white/10 hover:border-brand-200 dark:hover:border-gray-600"
      }`}
    >
      {isSelected && (
        <span className="absolute right-2 top-2 z-10 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[10px] font-semibold text-white shadow-sm">
          ✓
        </span>
      )}
      {contextMenu && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Issue actions for ${issue.title}`}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={handleMenuKeyDown}
          className="fixed z-50 w-52 rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={copyIssueReference}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
          >
            <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <span className="truncate">Copy issue reference</span>
          </button>
          {hasAnyAction && <div className="my-1 border-t border-gray-100 dark:border-gray-800" />}
          {showResume && (
            <button
              type="button"
              role="menuitem"
              onClick={() => runContextAction(() => onWorkspaceClick!(issue, ws?.main?.id))}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
            >
              <svg className="h-3.5 w-3.5 shrink-0 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
              </svg>
              <span className="truncate">Resume</span>
            </button>
          )}
          {showStartWorkspace && (
            <button
              type="button"
              role="menuitem"
              onClick={() => runContextAction(() => onStartWorkspace!(issue))}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
            >
              <svg className="h-3.5 w-3.5 shrink-0 text-brand-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              <span className="truncate">Start Workspace</span>
            </button>
          )}
          {showMoveToNext && (
            <button
              type="button"
              role="menuitem"
              onClick={() => runContextAction(() => onMoveToNext!(issue))}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none dark:text-gray-200 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
            >
              <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
              <span className="truncate">Move to {nextStatusName}</span>
            </button>
          )}
        </div>,
        document.body,
      )}
      <div className="flex min-w-0 items-start justify-between gap-2">
        <p className="min-w-0 text-sm text-ink dark:text-stone-100 break-words">
          {issue.issueNumber != null && (
            <span className="text-gray-400 dark:text-gray-500 font-mono mr-1">#{issue.issueNumber}</span>
          )}
          <HighlightedText text={issue.title} query={searchQuery ?? ""} />
        </p>
        {isPendingWorkspace && (
          <svg className="w-3.5 h-3.5 shrink-0 text-brand-500 animate-spin mt-0.5" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
      </div>
      {issue.description && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
          <HighlightedText text={issue.description} query={searchQuery ?? ""} />
        </p>
      )}
      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
        {issue.isBlocked && (
          <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path d="M8 1a2 2 0 0 1 2 2v4H6V3a2 2 0 0 1 2-2zm3 6V3a3 3 0 0 0-6 0v4a2 2 0 0 0 2 2v2.5a.5.5 0 0 0 1 0V9a2 2 0 0 0 2-2z"/></svg>
            blocked
          </span>
        )}
        {!issue.isBlocked && (issue as IssueWithStatus & { dependencyCount?: number }).dependencyCount ? (
          <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-brand-50 text-brand-600 dark:bg-brand-900/40 dark:text-brand-400" title={`${(issue as IssueWithStatus & { dependencyCount?: number }).dependencyCount} dependencies`}>
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            {(issue as IssueWithStatus & { dependencyCount?: number }).dependencyCount}
          </span>
        ) : null}
        {typeBadgeColor && (
          <span className={`inline-block max-w-full truncate text-xs font-medium px-1.5 py-0.5 rounded capitalize ${typeBadgeColor}`}>
            {issue.issueType}
          </span>
        )}
        {priorityBadgeColor && (
          <span className={`inline-block max-w-full truncate text-xs font-medium px-1.5 py-0.5 rounded capitalize ${priorityBadgeColor}`}>
            {issue.priority}
          </span>
        )}
        {issue.estimate && (
          <span className="inline-block text-xs font-medium px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">
            {issue.estimate}
          </span>
        )}
        {issue.dueDate && (() => {
          const overdue = new Date(issue.dueDate) < new Date(new Date().toDateString()) &&
            issue.statusName !== "Done" && issue.statusName !== "Cancelled";
          return overdue ? (
            <span className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-600" title={`Overdue: ${new Date(issue.dueDate).toLocaleDateString('en-US')}`}>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              overdue
            </span>
          ) : (
            <span className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400" title={`Due: ${new Date(issue.dueDate).toLocaleDateString('en-US')}`}>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              {new Date(issue.dueDate).toLocaleDateString('en-US', { month: "short", day: "numeric" })}
            </span>
          );
        })()}
        {tags?.map((tag) =>
          tag.name === "needs-visual-verification" ? (
            <span
              key={tag.id}
              className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded"
              style={{ backgroundColor: "#F59E0B22", color: "#F59E0B" }}
              title="Needs visual verification"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              verify
            </span>
          ) : (
            <span
              key={tag.id}
              className="inline-block max-w-full truncate text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
              style={tag.color ? { backgroundColor: tag.color + "22", color: tag.color } : undefined}
              title={tag.name}
            >
              {tag.name}
            </span>
          )
        )}
        {ws?.showdown && (
          <span
            className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded ${
              ws.showdown.status === "decided"
                ? "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300"
                : ws.showdown.doneCount === ws.showdown.total
                ? "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"
                : "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300"
            }`}
            title={`Showdown: ${ws.showdown.doneCount}/${ws.showdown.total} done`}
          >
            ⚔️
            {ws.showdown.status === "decided"
              ? "Decided"
              : `${ws.showdown.doneCount}/${ws.showdown.total} done`}
          </span>
        )}
      </div>
      {ws && ws.main && (
        <div
          className={`group/ws flex min-w-0 flex-wrap items-center gap-1.5 mt-1.5 text-xs cursor-pointer rounded px-1 py-1 -mx-1 border-t transition-colors overflow-hidden ${
            ws.main.status === "reviewing" ? "border-accent-200 bg-accent-50 hover:bg-accent-100 dark:border-accent-700 dark:bg-accent-900/40" :
            ws.main.status === "fixing" ? "border-orange-100 bg-orange-50 hover:bg-orange-100" :
            ws.main.status === "awaiting-plan-approval" ? "border-amber-200 bg-amber-50 hover:bg-amber-100" :
            ws.main.conflicts?.hasConflicts ? "border-red-100 bg-red-50 hover:bg-red-100" :
            "border-brand-100 bg-brand-50 hover:bg-brand-100 hover:border-brand-200"
          }`}
          title="Open workspace"
          onClick={(e) => { e.stopPropagation(); onWorkspaceClick?.(issue, ws.main?.id); }}
        >
          {ws.main.status === "reviewing" ? (
            <>
              <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-accent-500 animate-pulse" />
              <span className="min-w-0 truncate font-medium text-accent-700 dark:text-accent-300">AI Reviewing</span>
              {ws.main.workflow && <WorkflowMiniIndicator workflow={ws.main.workflow} />}
            </>
          ) : ws.main.status === "fixing" ? (
            <>
              <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-orange-500 animate-pulse" />
              <span className="min-w-0 truncate font-medium text-orange-700">AI Fixing Conflicts</span>
              {ws.main.workflow && <WorkflowMiniIndicator workflow={ws.main.workflow} />}
            </>
          ) : ws.main.status === "awaiting-plan-approval" ? (
            <>
              <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-amber-500" />
              <span className="min-w-0 truncate font-medium text-amber-700">Plan Awaiting Approval</span>
              {ws.main.workflow && <WorkflowMiniIndicator workflow={ws.main.workflow} />}
            </>
          ) : ws.main.conflicts?.hasConflicts ? (
            <>
              <span className="inline-block w-2 h-2 rounded-full shrink-0 bg-red-500" />
              <span className="min-w-0 truncate font-medium text-red-700">Merge Conflicts</span>
              {ws.main.workflow && <WorkflowMiniIndicator workflow={ws.main.workflow} />}
            </>
          ) : (
            <>
              <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                ws.main.status === "active" ? "bg-green-500" :
                ws.main.status === "idle" ? "bg-amber-500" :
                "bg-gray-400"
              }`} />
              <span className="min-w-0 flex-1 basis-24 font-mono text-gray-600 dark:text-gray-400 truncate">{ws.main.branch}</span>
              {ws.main.workflow && <WorkflowMiniIndicator workflow={ws.main.workflow} />}
              {ws.main.status === "idle" && liveActivity && (() => {
                const badge = getLastSessionBadge(ws.main.lastSessionTriggerType);
                return badge ? <span className={`order-last text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${badge.className}`}>{badge.label}</span> : null;
              })()}
            </>
          )}
          {ws.main.status === "closed" && (
            ws.main.lastSessionTriggerType === "fix-conflicts" ? (
              <span className="order-last inline-flex items-center gap-1 font-medium shrink-0 text-orange-700"><span className="inline-block w-2 h-2 rounded-full shrink-0 bg-orange-400" />merged conflicts</span>
            ) : ws.main.mergedAt ? (
              <span className="order-last text-green-600 font-medium shrink-0">merged</span>
            ) : (
              <span className="order-last text-gray-500 font-medium shrink-0">closed</span>
            )
          )}
          <span className="order-last inline-flex basis-full min-w-0 flex-wrap items-center gap-1 pt-0.5 text-[10px] font-mono">
            {ws.main.scorecard && (
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${
                  ws.main.scorecard.score >= 80 ? "bg-green-100 text-green-700" :
                  ws.main.scorecard.score >= 60 ? "bg-yellow-100 text-yellow-700" :
                  "bg-red-100 text-red-700"
                }`}
                title={`PR Quality Score: ${ws.main.scorecard.score}/100`}
              >
            {ws.main.scorecard.score}
          </span>
        )}
            <CodeMetricsBadges commitCount={ws.main.commitCount} metrics={ws.main.codeMetrics} />
            {ws.main.diffStats && liveActivity && (
              <>
                <span className="text-green-600">+{ws.main.diffStats.insertions}</span>
                <span className="text-red-500">-{ws.main.diffStats.deletions}</span>
                <span className="text-gray-400 dark:text-gray-500">{ws.main.diffStats.filesChanged}f</span>
              </>
            )}
            {ws.main.lastSessionAt && ws.main.status !== "active" && ws.main.status !== "reviewing" && ws.main.status !== "fixing" && (
              <span className="text-gray-400 dark:text-gray-500">{ws.main.diffStats ? "· " : ""}{relativeTime(ws.main.lastSessionAt)}</span>
            )}
          </span>
          {ws.main.conflicts?.hasConflicts && ws.main.status !== "fixing" && (
            <span className="order-last inline-flex items-center px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-medium shrink-0">
              {ws.main.conflicts.conflictingFiles.length} file{ws.main.conflicts.conflictingFiles.length !== 1 ? "s" : ""}
            </span>
          )}
          {ws.main.planMode && (
            <span className="order-last inline-flex items-center px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300 text-[10px] font-medium shrink-0">
              Plan Mode
            </span>
          )}
          {ws.main.planOnlyWarning && (
            <span className="order-last inline-flex items-center px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-400 text-[10px] font-medium shrink-0" title="Session completed but produced no file changes">
              No changes
            </span>
          )}
          {ws.main.profile?.provider && ws.main.profile.provider !== "claude" && (
            <span className={`order-last inline-flex items-center px-1 rounded font-medium text-[10px] shrink-0 ${
              ws.main.profile.provider === "copilot" ? "bg-emerald-50 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400" :
              ws.main.profile.provider === "codex" ? "bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-400" :
              "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
            }`}>{ws.main.profile.provider === "copilot" ? "Copilot" : ws.main.profile.provider === "codex" ? "Codex" : ws.main.profile.provider}</span>
          )}
          {(ws.main.profile?.name ?? ws.main.claudeProfile) && (
            <span className="order-last inline-flex max-w-full items-center truncate px-1 rounded bg-brand-50 dark:bg-brand-900/40 text-brand-600 dark:text-brand-400 font-medium shrink">{ws.main.profile?.name ?? ws.main.claudeProfile}</span>
          )}
          {!ws.main.profile?.name && !ws.main.claudeProfile && ws.main.agentCommand && ws.main.agentCommand !== "claude" && (
            <span className="order-last inline-flex max-w-full items-center truncate px-1 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-mono text-[10px] shrink">{ws.main.agentCommand}</span>
          )}
          {ws.total > 1 && (
            <span className="order-last text-gray-400 dark:text-gray-500 shrink-0">+{ws.total - 1} more</span>
          )}
          <svg className="w-3 h-3 shrink-0 text-gray-300 dark:text-gray-600 group-hover/ws:text-brand-400 transition-colors ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
          </svg>
        </div>
      )}
      {(ws?.main?.status === "active" || ws?.main?.status === "fixing") && liveActivity && liveActivity !== "Delegating to agent" && (
        <div className="flex items-center gap-1.5 mt-1 text-xs text-gray-400 dark:text-gray-500 px-1">
          <span className={`inline-block w-1.5 h-1.5 rounded-full animate-pulse shrink-0 ${ws.main.status === "fixing" ? "bg-orange-400" : "bg-green-400"}`} />
          <span className="truncate">{liveActivity}</span>
        </div>
      )}
      {(ws?.main?.status === "active" || ws?.main?.status === "fixing") && liveActivity && liveStats && (
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-400 dark:text-gray-500 px-1">
          {liveStats.model && <span className="font-mono">{liveStats.model}</span>}
          {liveStats.contextTokens > 0 && (
            <span>{Math.round(liveStats.contextTokens / 1000)}k ctx</span>
          )}
          {liveStats.toolUses > 0 && liveStats.contextTokens === 0 && (
            <span>{liveStats.toolUses} tools</span>
          )}
          {liveStats.subagentCount > 0 && (
            <span className="inline-flex items-center gap-0.5 px-1 rounded bg-brand-50 text-brand-600 dark:bg-brand-900/40 dark:text-brand-400 font-medium">
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {liveStats.subagentCount}
            </span>
          )}
        </div>
      )}
      {!(ws?.main?.status === "active" || ws?.main?.status === "fixing") && ws?.main && (ws.main.contextTokens || ws.main.lastTool) && (
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-400 dark:text-gray-500 px-1">
          {ws.main.contextTokens != null && ws.main.contextTokens > 0 && (
            <span>{Math.round(ws.main.contextTokens / 1000)}k ctx</span>
          )}
          {ws.main.lastTool && (
            <span className="font-mono truncate">{ws.main.lastTool}</span>
          )}
        </div>
      )}
      {todos && todos.length > 0 && <TodoProgress todos={todos} />}

      {/* Action row: appears on hover, contains all card-level actions in one place */}
      {hasAnyAction && !isDragging && (
        <div className="mt-1.5 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {showResume && (
            <button
              onClick={(e) => { e.stopPropagation(); onWorkspaceClick!(issue, ws?.main?.id); }}
              className="flex-1 flex items-center justify-center gap-1 text-xs text-green-700 hover:text-white hover:bg-green-600 border border-green-200 hover:border-green-600 rounded px-2 py-1 transition-colors"
              title="Resume the active workspace"
            >
              <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
              </svg>
              Resume
            </button>
          )}
          {showStartWorkspace && (
            <button
              onClick={(e) => { e.stopPropagation(); onStartWorkspace!(issue); }}
              className="flex-1 flex items-center justify-center gap-1 text-xs text-brand-600 hover:text-white hover:bg-brand-600 border border-brand-200 hover:border-brand-600 rounded px-2 py-1 transition-colors"
              title="Start a new workspace for this issue"
            >
              <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Start Workspace
            </button>
          )}
          {showMoveToNext && (
            <button
              onClick={(e) => { e.stopPropagation(); onMoveToNext!(issue); }}
              className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-white hover:bg-brand-600 border border-gray-200 dark:border-gray-700 hover:border-brand-600 rounded px-2 py-1 transition-colors"
              title={`Move to ${nextStatusName}`}
            >
              <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
              {nextStatusName}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TodoProgress({ todos }: { todos: TodoItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const total = todos.length;
  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;

  return (
    <div className="mt-1.5 px-1">
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        className="w-full text-left"
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          <svg
            className={`w-2.5 h-2.5 text-gray-400 dark:text-gray-500 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="currentColor" viewBox="0 0 16 16"
          >
            <path d="M6 12l4-4-4-4v8z" />
          </svg>
          <span className="text-[10px] text-gray-400 dark:text-gray-500">{completed}/{total} tasks</span>
          {inProgress > 0 && (
            <span className="text-[10px] text-blue-500 font-medium">{inProgress} active</span>
          )}
        </div>
      </button>
      <div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden flex ml-3">
        <div
          className="h-full bg-green-500 transition-all duration-300"
          style={{ width: `${(completed / total) * 100}%` }}
        />
        <div
          className="h-full bg-blue-400 transition-all duration-300"
          style={{ width: `${(inProgress / total) * 100}%` }}
        />
      </div>
      {expanded && (
        <div className="mt-1 ml-3 space-y-0.5">
          {todos.map((t, i) => (
            <div key={i} className="flex items-start gap-1 text-[10px]">
              <span className="shrink-0 mt-0.5">
                {t.status === "completed" ? (
                  <svg className="w-2.5 h-2.5 text-green-500" fill="currentColor" viewBox="0 0 16 16"><path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z"/></svg>
                ) : t.status === "in_progress" ? (
                  <svg className="w-2.5 h-2.5 text-blue-500" fill="currentColor" viewBox="0 0 16 16"><path d="M8 1a2 2 0 012 2v4H6V3a2 2 0 012-2zm3 6V3a3 3 0 00-6 0v4a2 2 0 002 2v2.5a.5.5 0 001 0V9a2 2 0 002-2z"/></svg>
                ) : (
                  <svg className="w-2.5 h-2.5 text-gray-300 dark:text-gray-600" fill="currentColor" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>
                )}
              </span>
              <span className={t.status === "completed" ? "text-gray-400 dark:text-gray-500 line-through" : "text-gray-600 dark:text-gray-400"}>
                {t.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
