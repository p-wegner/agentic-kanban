import { memo, useRef, useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { apiFetch, apiPost } from "../lib/api.js";
import { getBoardDragData } from "../lib/dragData.js";
import { prefetchBundle } from "../lib/issueDetailBundleCache.js";
import { IssueWorkLogBadge } from "./IssueWorkLogBadge.js";
import { showToast } from "./Toast.js";
import { formatRelativeTime, formatAbsoluteTime } from "../lib/formatRelativeTime.js";
import type { CardDensity } from "../hooks/useBoardPreferences.js";
import { useIssueDisplayData } from "../hooks/useIssueDisplayData.js";
import { PRIORITY_META } from "../lib/chartColors.js";
import { priorityColors } from "../lib/issueCardColorMap.js";
import { getActiveAgentState, type ActiveAgentState } from "../lib/sessionBadgeHelpers.js";
import { deriveAgingBucket, deriveIssueCardActions } from "../lib/issueCardDisplay.js";
import { HighlightedText, TodoProgress } from "./IssueBadges.js";
import { InlineTagEditor, PriorityDropdown } from "./BadgeEditors.js";
import { IssueCardContextMenu } from "./IssueCardContextMenu.js";
import { WorkspaceSummarySection } from "./WorkspaceSummarySection.js";

export interface ProjectTag {
  id: string;
  name: string;
  color: string | null;
}

export interface QuickUpdateCallbacks {
  onPriorityChange: (issueId: string, priority: string) => Promise<void>;
  onAddTag: (issueId: string, tagId: string) => Promise<void>;
  onRemoveTag: (issueId: string, tagId: string) => Promise<void>;
  onTogglePinned?: (issueId: string, pinned: boolean) => Promise<void>;
}

export interface TagBadge {
  id: string;
  name: string;
  color: string | null;
}

export interface StatusOption {
  id: string;
  name: string;
}

interface IssueCardProps {
  issue: IssueWithStatus;
  onClick: (issue: IssueWithStatus, event: React.MouseEvent) => void;
  onWorkspaceClick?: (issue: IssueWithStatus, workspaceId?: string) => void;
  onOpenDiff?: (issue: IssueWithStatus, workspaceId: string) => void;
  onStartWorkspace?: (issue: IssueWithStatus) => void;
  onDryRun?: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDuplicate?: (issue: IssueWithStatus) => void;
  onMoveToNext?: (issue: IssueWithStatus) => void;
  nextStatusName?: string;
  tags?: TagBadge[];
  allProjectTags?: ProjectTag[];
  quickUpdate?: QuickUpdateCallbacks;
  allStatuses?: StatusOption[];
  onDeleteIssue?: (issueId: string) => void;
  searchQuery?: string;
  liveActivity?: string;
  liveStats?: LiveSessionStats;
  todos?: TodoItem[];
  isPendingIssue?: boolean;
  isPendingWorkspace?: boolean;
  isSelected?: boolean;
  isKeyboardFocused?: boolean;
  cardDensity?: CardDensity;
  showAgingHeatmap?: boolean;
  agingWarmDays?: number;
  agingHotDays?: number;
}

// --- useIssueCardDrag ---

function useIssueCardDrag(
  issue: IssueWithStatus,
  isPendingIssue: boolean | undefined,
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void,
) {
  const [isDragging, setIsDragging] = useState(false);
  const [depDragOver, setDepDragOver] = useState(false);

  function handleDragStart(e: React.DragEvent) {
    if (isPendingIssue) { e.preventDefault(); return; }
    setIsDragging(true);
    onDragStart(e, issue);
  }

  function handleDragEnd() { setIsDragging(false); }

  function handleDragOver(e: React.DragEvent) {
    const dragData = getBoardDragData();
    if (dragData?.issueId && dragData.issueId !== issue.id && e.shiftKey) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "link";
      setDepDragOver(true);
    }
  }

  function handleDragLeave() { setDepDragOver(false); }

  async function handleDrop(e: React.DragEvent) {
    setDepDragOver(false);
    if (!e.shiftKey) return;
    const dragData = getBoardDragData();
    if (!dragData?.issueId || dragData.issueId === issue.id) return;
    e.stopPropagation();
    try {
      await apiPost(`/api/issues/${dragData.issueId}/dependencies`, { dependsOnId: issue.id, type: "depends_on" });
      showToast("Dependency added", "success");
    } catch {
      showToast("Failed to add dependency", "error");
    }
  }

  return { isDragging, depDragOver, handleDragStart, handleDragEnd, handleDragOver, handleDragLeave, handleDrop };
}

// --- IssueCardHeader ---

function IssueCardHeader({
  issue,
  searchQuery,
  isPendingWorkspace,
  activeAgent,
}: {
  issue: IssueWithStatus;
  searchQuery?: string;
  isPendingWorkspace?: boolean;
  activeAgent?: ActiveAgentState | null;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-2">
      <p className="min-w-0 text-sm text-ink dark:text-stone-100 break-words">
        {issue.issueNumber != null && (
          <span className="text-gray-400 dark:text-gray-500 font-mono mr-1">#{issue.issueNumber}</span>
        )}
        <HighlightedText text={issue.title} query={searchQuery ?? ""} />
      </p>
      {activeAgent && (
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold mt-0.5 ${activeAgent.badge}`}
          title={activeAgent.label}
        >
          <span className={`inline-block h-1.5 w-1.5 rounded-full animate-pulse ${activeAgent.dot}`} />
          {activeAgent.label}
        </span>
      )}
      {isPendingWorkspace && (
        <svg className="w-3.5 h-3.5 shrink-0 text-brand-500 animate-spin mt-0.5" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
    </div>
  );
}

// --- IssueCardBody ---

function IssueCardBody({
  issue,
  compact,
  liveActivity,
  liveStats,
  todos,
  isPendingIssue,
  tags,
  allProjectTags,
  quickUpdate,
  searchQuery,
  onWorkspaceClick,
}: {
  issue: IssueWithStatus;
  compact: boolean;
  liveActivity?: string;
  liveStats?: LiveSessionStats;
  todos?: TodoItem[];
  isPendingIssue?: boolean;
  tags?: TagBadge[];
  allProjectTags?: ProjectTag[];
  quickUpdate?: QuickUpdateCallbacks;
  searchQuery?: string;
  onWorkspaceClick?: (issue: IssueWithStatus, workspaceId?: string) => void;
}) {
  const { issueType, issueTypeClassName: typeBadgeColor } = useIssueDisplayData(issue);
  const priorityBadgeColor = issue.priority && issue.priority !== "medium" ? (priorityColors[issue.priority] ?? null) : null;
  const ws = issue.workspaceSummary;

  return (
    <>
      {!compact && issue.description && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
          <HighlightedText text={issue.description} query={searchQuery ?? ""} />
        </p>
      )}
      <div className={`flex items-center gap-1.5 flex-wrap ${compact ? "mt-0.5" : "mt-1"}`}>
        {isPendingIssue && (
          <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand-500 animate-pulse" />
            Creating issue
          </span>
        )}
        {issue.isBlocked && (
          <span className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 16 16"><path d="M8 1a2 2 0 0 1 2 2v4H6V3a2 2 0 0 1 2-2zm3 6V3a3 3 0 0 0-6 0v4a2 2 0 0 0 2 2v2.5a.5.5 0 0 0 1 0V9a2 2 0 0 0 2-2z"/></svg>
            blocked
          </span>
        )}
        {issue.isStale && (
          <span
            className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
            title={`No activity for ${issue.staleDays} day${issue.staleDays === 1 ? "" : "s"}`}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Stale
          </span>
        )}
        {issue.columnAgeDays != null && issue.columnAgeDays > 0 && (
          <span
            className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded ${
              issue.isColumnStale
                ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"
            }`}
            title={`In this column for ${issue.columnAgeDays} day${issue.columnAgeDays === 1 ? "" : "s"}${issue.isColumnStale ? " — past threshold" : ""}`}
          >
            <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {issue.columnAgeDays}d
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
            {issueType}
          </span>
        )}
        {quickUpdate ? (
          <PriorityDropdown
            priority={issue.priority ?? "medium"}
            onChange={(p) => quickUpdate.onPriorityChange(issue.id, p)}
          />
        ) : (
          priorityBadgeColor && (
            <span className={`inline-block max-w-full truncate text-xs font-medium px-1.5 py-0.5 rounded capitalize ${priorityBadgeColor}`}>
              {issue.priority}
            </span>
          )
        )}
        {issue.estimate && (
          <span className="inline-block text-xs font-medium px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">
            {issue.estimate}
          </span>
        )}
        {issue.externalUrl && (
          <a
            href={issue.externalUrl}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            title={`Open in external tracker${issue.externalKey ? `: ${issue.externalKey}` : ""}`}
            className="inline-flex items-center gap-0.5 max-w-full truncate text-xs font-medium px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300 dark:hover:bg-indigo-900/70"
          >
            <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4m-4-6l6-6m0 0v4m0-4h-4" />
            </svg>
            {issue.externalKey || "link"}
          </a>
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
        {issue.checklist && issue.checklist.length > 0 && (() => {
          const total = issue.checklist.length;
          const done = issue.checklist.filter((i) => i.completed).length;
          const allDone = done === total;
          const pct = Math.round((done / total) * 100);
          return (
            <span
              className={`inline-flex flex-col gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded ${
                allDone
                  ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
              }`}
              title={`Acceptance criteria: ${done}/${total} done`}
            >
              <span className="inline-flex items-center gap-1">
                <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
                {done}/{total}
              </span>
              <span className="w-full h-1 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                <span
                  className={`block h-full rounded-full ${allDone ? "bg-green-500" : "bg-blue-500"}`}
                  style={{ width: `${pct}%` }}
                />
              </span>
            </span>
          );
        })()}
        {quickUpdate && allProjectTags ? (
          <InlineTagEditor
            tags={tags ?? []}
            allProjectTags={allProjectTags}
            onAdd={(tagId) => quickUpdate.onAddTag(issue.id, tagId)}
            onRemove={(tagId) => quickUpdate.onRemoveTag(issue.id, tagId)}
          />
        ) : (
          tags?.map((tag) =>
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
          )
        )}
        {!isPendingIssue && <IssueWorkLogBadge issueId={issue.id} />}
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
      <WorkspaceSummarySection
        issue={issue}
        ws={ws}
        compact={compact}
        liveActivity={liveActivity}
        liveStats={liveStats}
        onWorkspaceClick={onWorkspaceClick}
      />
      {!compact && todos && todos.length > 0 && <TodoProgress todos={todos} />}
      <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400 dark:text-gray-500 px-0.5">
        <span title={formatAbsoluteTime(issue.createdAt)}>{formatRelativeTime(issue.createdAt)}</span>
      </div>
    </>
  );
}

// --- IssueCardActions ---

function IssueCardActions({
  issue,
  ws,
  isDragging,
  compact,
  showResume,
  showDiff,
  showStartWorkspace,
  showDryRun,
  showMoveToNext,
  hasAnyAction,
  nextStatusName,
  onWorkspaceClick,
  onOpenDiff,
  onStartWorkspace,
  onDryRun,
  onMoveToNext,
}: {
  issue: IssueWithStatus;
  ws: IssueWithStatus["workspaceSummary"];
  isDragging: boolean;
  compact: boolean;
  showResume: boolean;
  showDiff: boolean;
  showStartWorkspace: boolean;
  showDryRun: boolean;
  showMoveToNext: boolean;
  hasAnyAction: boolean;
  nextStatusName?: string;
  onWorkspaceClick?: (issue: IssueWithStatus, workspaceId?: string) => void;
  onOpenDiff?: (issue: IssueWithStatus, workspaceId: string) => void;
  onStartWorkspace?: (issue: IssueWithStatus) => void;
  onDryRun?: (issue: IssueWithStatus) => void;
  onMoveToNext?: (issue: IssueWithStatus) => void;
}) {
  if (!hasAnyAction || isDragging) return null;

  // Comfortable: keep the row in flow (opacity fade) so hovering never shifts
  // surrounding cards. Compact: collapse it entirely until hover so dense lists
  // don't pay ~26px of reserved blank space per card.
  return (
    <div className={`flex items-center gap-1.5 transition-opacity ${compact ? "mt-1 hidden group-hover:flex" : "mt-1.5 opacity-0 group-hover:opacity-100"}`}>
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
      {showDiff && (
        <button
          onClick={(e) => { e.stopPropagation(); onOpenDiff!(issue, ws!.main!.id!); }}
          className="flex items-center justify-center gap-1 text-xs text-brand-600 dark:text-brand-400 hover:text-white hover:bg-brand-600 border border-brand-200 dark:border-brand-800 hover:border-brand-600 rounded px-2 py-1 transition-colors"
          title="Open live diff for this workspace"
          aria-label="Open live diff"
        >
          <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" />
          </svg>
          Diff
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
      {showDryRun && (
        <button
          onClick={(e) => { e.stopPropagation(); onDryRun!(issue); }}
          className="flex items-center justify-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-brand-600 dark:hover:text-brand-400 border border-gray-200 dark:border-gray-700 hover:border-brand-300 rounded px-2 py-1 transition-colors"
          title="Preview launch without creating a workspace"
        >
          <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7Z" />
          </svg>
          Dry Run
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
  );
}

// --- IssueCardImpl ---

function IssueCardImpl({ issue, onClick, onWorkspaceClick, onOpenDiff, onStartWorkspace, onDryRun, onDragStart, onDuplicate, onMoveToNext, nextStatusName, tags, allProjectTags, quickUpdate, allStatuses, onDeleteIssue, searchQuery, liveActivity, liveStats, todos, isPendingIssue, isPendingWorkspace, isSelected, isKeyboardFocused, cardDensity = "comfortable", showAgingHeatmap = false, agingWarmDays = 3, agingHotDays = 7 }: IssueCardProps) {
  const compact = cardDensity === "compact";
  const agingDays = issue.columnAgeDays ?? 0;
  const agingBucket = deriveAgingBucket(agingDays, { showAgingHeatmap, agingWarmDays, agingHotDays });
  const priorityAccentColor = issue.priority ? (PRIORITY_META.find((p) => p.key === issue.priority)?.color ?? null) : null;
  const ws = issue.workspaceSummary;
  const hasActiveWorkspace = !!(ws?.main && ws.main.status !== "closed");
  const activeAgent = getActiveAgentState(issue);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const { isDragging, depDragOver, handleDragStart, handleDragEnd, handleDragOver, handleDragLeave, handleDrop } = useIssueCardDrag(issue, isPendingIssue, onDragStart);

  const { showResume, showDiff, showStartWorkspace, showDryRun, showMoveToNext, hasAnyAction } =
    deriveIssueCardActions({
      statusName: issue.statusName,
      isPendingIssue: !!isPendingIssue,
      hasActiveWorkspace,
      hasMainWorkspaceId: !!ws?.main?.id,
      nextStatusName,
      canResume: !!onWorkspaceClick,
      canOpenDiff: !!onOpenDiff,
      canStartWorkspace: !!onStartWorkspace,
      canDryRun: !!onDryRun,
      canMoveToNext: !!onMoveToNext,
    });

  function openContextMenu(x: number, y: number) {
    setContextMenu({
      x: Math.min(x, window.innerWidth - 220),
      y: Math.min(y, window.innerHeight - 380),
    });
  }

  function closeContextMenu() { setContextMenu(null); }

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

  return (
    <div
      ref={cardRef}
      draggable={!isPendingIssue}
      tabIndex={0}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={(e) => onClick(issue, e)}
      onMouseEnter={() => prefetchBundle(issue.id)}
      onFocus={() => prefetchBundle(issue.id)}
      onContextMenu={handleContextMenu}
      onKeyDown={handleCardKeyDown}
      aria-selected={isSelected ? "true" : undefined}
      aria-current={isKeyboardFocused ? "true" : undefined}
      aria-label={`Open issue ${issue.title}`}
      className={`group bg-surface-raised dark:bg-surface-raised-dark rounded-lg shadow-sm border cursor-pointer hover:shadow-md hover:-translate-y-px transition-all duration-150 relative isolate overflow-hidden ${compact ? "p-1.5" : "p-2.5"} ${
        isPendingIssue
          ? "border-brand-300 bg-brand-50/70 shadow-brand-100 shadow-md dark:border-brand-700 dark:bg-brand-950/40"
          : isKeyboardFocused
          ? "border-sky-500 ring-2 ring-sky-400/70 shadow-sky-100 dark:shadow-sky-950"
          : isSelected
          ? "border-brand-500 ring-2 ring-brand-400/70 shadow-brand-100 dark:shadow-brand-950"
          : activeAgent
          ? `border-transparent ${activeAgent.ring}`
          : depDragOver ? "border-brand-400 bg-brand-50 shadow-brand-200" : isPendingWorkspace ? "border-brand-300 shadow-brand-100 shadow-md" : "border-black/[0.07] dark:border-white/10 hover:border-brand-200 dark:hover:border-gray-600"
      }`}
    >
      {priorityAccentColor && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg"
          style={{ backgroundColor: priorityAccentColor }}
        />
      )}
      {agingBucket !== "fresh" && (
        <span
          aria-hidden="true"
          className={`absolute inset-0 rounded-lg pointer-events-none ${
            agingBucket === "hot"
              ? "bg-red-500/[0.09] dark:bg-red-500/[0.13]"
              : "bg-amber-400/[0.09] dark:bg-amber-400/[0.13]"
          }`}
        />
      )}
      {isSelected && (
        <span className="absolute right-2 top-2 z-10 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[10px] font-semibold text-white shadow-sm">
          ✓
        </span>
      )}
      {contextMenu && (
        <IssueCardContextMenu
          issue={issue}
          position={contextMenu}
          menuRef={menuRef}
          cardRef={cardRef}
          onClose={closeContextMenu}
          showResume={!!showResume}
          showDiff={!!showDiff}
          showStartWorkspace={!!showStartWorkspace}
          showDryRun={!!showDryRun}
          showMoveToNext={!!showMoveToNext}
          hasAnyAction={hasAnyAction}
          nextStatusName={nextStatusName}
          ws={ws}
          quickUpdate={quickUpdate}
          allStatuses={allStatuses}
          onDeleteIssue={onDeleteIssue}
          onDuplicate={onDuplicate}
          onWorkspaceClick={onWorkspaceClick}
          onOpenDiff={onOpenDiff}
          onStartWorkspace={onStartWorkspace}
          onDryRun={onDryRun}
          onMoveToNext={onMoveToNext}
        />
      )}
      <IssueCardHeader issue={issue} searchQuery={searchQuery} isPendingWorkspace={isPendingWorkspace} activeAgent={activeAgent} />
      <IssueCardBody
        issue={issue}
        compact={compact}
        liveActivity={liveActivity}
        liveStats={liveStats}
        todos={todos}
        isPendingIssue={isPendingIssue}
        tags={tags}
        allProjectTags={allProjectTags}
        quickUpdate={quickUpdate}
        searchQuery={searchQuery}
        onWorkspaceClick={onWorkspaceClick}
      />
      <IssueCardActions
        issue={issue}
        ws={ws}
        isDragging={isDragging}
        compact={compact}
        showResume={!!showResume}
        showDiff={!!showDiff}
        showStartWorkspace={!!showStartWorkspace}
        showDryRun={!!showDryRun}
        showMoveToNext={!!showMoveToNext}
        hasAnyAction={hasAnyAction}
        nextStatusName={nextStatusName}
        onWorkspaceClick={onWorkspaceClick}
        onOpenDiff={onOpenDiff}
        onStartWorkspace={onStartWorkspace}
        onDryRun={onDryRun}
        onMoveToNext={onMoveToNext}
      />
    </div>
  );
}

// Handler props are excluded from the memo comparison: they take the issue/value as an
// argument and don't capture per-card mutable state, so the parent recreating them on a
// live-session tick should NOT force every card to re-render. This is safe because the
// only time a retained (older) handler is kept is when no compared data prop changed —
// i.e. board data is unchanged, so the handler's captured state is identical. Whenever
// board data actually changes (issue edit, project switch) the data props differ and the
// card re-renders with fresh handlers. Every non-handler prop is compared by identity,
// so new data props are covered automatically.
const ISSUE_CARD_HANDLER_PROPS = new Set<keyof IssueCardProps>([
  "onClick", "onWorkspaceClick", "onOpenDiff", "onStartWorkspace", "onDryRun",
  "onDragStart", "onDuplicate", "onMoveToNext", "onDeleteIssue", "quickUpdate",
]);

function areIssueCardPropsEqual(prev: IssueCardProps, next: IssueCardProps): boolean {
  const keys = new Set<keyof IssueCardProps>([
    ...(Object.keys(prev) as (keyof IssueCardProps)[]),
    ...(Object.keys(next) as (keyof IssueCardProps)[]),
  ]);
  for (const key of keys) {
    if (ISSUE_CARD_HANDLER_PROPS.has(key)) continue;
    if (!Object.is(prev[key], next[key])) return false;
  }
  return true;
}

/**
 * Memoized so a board re-render (e.g. a live-session WebSocket tick that updates the
 * liveStats/activity/todos maps without touching `columns`) only re-renders the cards
 * whose own data changed, not every card on the board. See areIssueCardPropsEqual.
 */
export const IssueCard = memo(IssueCardImpl, areIssueCardPropsEqual);
