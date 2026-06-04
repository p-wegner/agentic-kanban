import { useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues, CreateIssueRequest, ProfileSelection } from "@agentic-kanban/shared";
import { BoardErrorBoundary } from "./BoardErrorBoundary.js";
import { BoardColumn } from "./BoardColumn.js";
import type { SwimlaneDimension } from "./BoardColumn.js";
import type { ProjectTag, QuickUpdateCallbacks } from "./IssueCard.js";
import { CompletedGrid } from "./CompletedGrid.js";
import { CreateIssueForm } from "./CreateIssueForm.js";
import type { CreateIssueFormState } from "./CreateIssueForm.js";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { useIsNarrow } from "../hooks/useMediaQuery.js";
import type { CardDensity } from "../hooks/useBoardPreferences.js";

export type { SwimlaneDimension };

interface PinnedStripProps {
  issues: IssueWithStatus[];
  onIssueClick: (issue: IssueWithStatus, event: React.MouseEvent) => void;
  onUnpin: (issueId: string) => void;
}

function PinnedStrip({ issues, onIssueClick, onUnpin }: PinnedStripProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (issues.length === 0) return null;

  return (
    <div className="border-b border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-1.5 shrink-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:text-amber-800 dark:hover:text-amber-200 transition-colors"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand pinned issues" : "Collapse pinned issues"}
        >
          <svg
            className={`w-3 h-3 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
            fill="currentColor" viewBox="0 0 16 16"
          >
            <path d="M6 12l4-4-4-4v8z" />
          </svg>
          <svg className="w-3.5 h-3.5 shrink-0 text-amber-400" fill="currentColor" viewBox="0 0 24 24">
            <path d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.562.562 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
          </svg>
          Pinned
          <span className="ml-0.5 text-amber-500 dark:text-amber-400 font-normal">({issues.length})</span>
        </button>
      </div>
      {!collapsed && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {issues.map((issue) => (
            <button
              key={issue.id}
              type="button"
              onClick={(e) => onIssueClick(issue, e)}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 dark:border-amber-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-800 dark:text-gray-200 hover:border-amber-400 dark:hover:border-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/40 transition-colors max-w-[16rem]"
              title={`${issue.issueNumber != null ? `#${issue.issueNumber} ` : ""}${issue.title} — ${issue.statusName}`}
            >
              {issue.issueNumber != null && (
                <span className="font-mono text-gray-400 dark:text-gray-500 shrink-0">#{issue.issueNumber}</span>
              )}
              <span className="truncate">{issue.title}</span>
              <span className="shrink-0 text-[10px] text-gray-400 dark:text-gray-500 font-medium">{issue.statusName}</span>
              <span
                role="button"
                tabIndex={0}
                aria-label={`Unpin ${issue.title}`}
                onClick={(e) => { e.stopPropagation(); onUnpin(issue.id); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onUnpin(issue.id); } }}
                className="shrink-0 ml-0.5 text-amber-300 dark:text-amber-600 hover:text-amber-500 dark:hover:text-amber-400 transition-colors"
                title="Unpin"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface BoardKanbanViewProps {
  activeColumns: StatusWithIssues[];
  archiveColumns: StatusWithIssues[];
  allColumns: StatusWithIssues[];
  focusMode?: boolean;
  projectId: string;
  columnWidths: Record<string, number>;
  dynamicColumnScaling: boolean;
  creatingInColumnId: string | null;
  searchQuery: string;
  sessionActivity: Record<string, string>;
  liveStats: Record<string, LiveSessionStats>;
  sessionTodos: Record<string, TodoItem[]>;
  pendingIssueIds: Set<string>;
  pendingWorkspaceIssueIds: Set<string>;
  collapsedArchive: boolean;
  canStartWorkspace: boolean;
  onToggleArchive: () => void;
  onCreateClick: (statusId: string) => void;
  onCreateCancel: () => void;
  onIssueClick: (issue: IssueWithStatus, event: React.MouseEvent) => void;
  onWorkspaceClick: (issue: IssueWithStatus, workspaceId?: string) => void;
  onOpenDiff?: (issue: IssueWithStatus, workspaceId: string) => void;
  onStartWorkspace: (issue: IssueWithStatus) => void;
  onDryRun?: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDrop: (statusId: string, sortOrder?: number) => void;
  onDuplicate?: (issue: IssueWithStatus) => void;
  onMoveToNext: (issue: IssueWithStatus, nextStatusId: string) => void;
  onDeleteIssue?: (issueId: string) => void;
  onColumnResizeStart: (colId: string, e: React.MouseEvent) => void;
  onColumnResizeReset: (colId: string) => void;
  onCreateIssue: (data: CreateIssueRequest & { startWorkspace?: boolean; planMode?: boolean; skipAutoReview?: boolean; profile?: ProfileSelection; model?: string; isDirect?: boolean; skillId?: string }) => Promise<void>;
  onExpandCreate: (statusId: string, statusName: string, state: Partial<CreateIssueFormState>) => void;
  selectedIssueIds?: Set<string>;
  keyboardCursorIssueId?: string | null;
  allProjectTags?: ProjectTag[];
  quickUpdate?: QuickUpdateCallbacks;
  wipLimits?: Record<string, number | null>;
  onSetWipLimit?: (statusId: string, limit: number | null) => void;
  cardDensity?: CardDensity;
  onColumnReorder?: (draggedColumnId: string, targetSortOrder: number) => void;
  swimlaneDimension?: SwimlaneDimension;
  onDropWithLane?: (statusId: string, laneKey: string, sortOrder?: number) => void;
  showAgingHeatmap?: boolean;
  agingWarmDays?: number;
  agingHotDays?: number;
}

export function BoardKanbanView({
  activeColumns,
  archiveColumns,
  allColumns,
  focusMode = false,
  projectId,
  columnWidths,
  dynamicColumnScaling,
  creatingInColumnId,
  searchQuery,
  sessionActivity,
  liveStats,
  sessionTodos,
  pendingIssueIds,
  pendingWorkspaceIssueIds,
  collapsedArchive,
  canStartWorkspace,
  onToggleArchive,
  onCreateClick,
  onCreateCancel,
  onIssueClick,
  onWorkspaceClick,
  onOpenDiff,
  onStartWorkspace,
  onDryRun,
  onDragStart,
  onDrop,
  onDuplicate,
  onMoveToNext,
  onDeleteIssue,
  onColumnResizeStart,
  onColumnResizeReset,
  onCreateIssue,
  onExpandCreate,
  selectedIssueIds,
  keyboardCursorIssueId,
  allProjectTags,
  quickUpdate,
  wipLimits,
  onSetWipLimit,
  cardDensity = "comfortable",
  onColumnReorder,
  swimlaneDimension = "none",
  onDropWithLane,
  showAgingHeatmap = false,
  agingWarmDays = 3,
  agingHotDays = 7,
}: BoardKanbanViewProps) {
  // Below sm, columns stack vertically and the board scrolls down through them
  // (instead of a horizontal one-column-at-a-time swipe, where an empty column
  // wastes the whole screen). Stacked columns are full-width and auto-height.
  const isNarrow = useIsNarrow();

  const draggedColumnId = useRef<string | null>(null);
  const [columnDragOverId, setColumnDragOverId] = useState<string | null>(null);

  function handleColumnDragStart(e: React.DragEvent, columnId: string) {
    draggedColumnId.current = columnId;
    e.dataTransfer.effectAllowed = "move";
  }

  function handleColumnDragOver(e: React.DragEvent, columnId: string) {
    if (!draggedColumnId.current || draggedColumnId.current === columnId) return;
    e.preventDefault();
    e.stopPropagation();
    setColumnDragOverId(columnId);
  }

  function handleColumnDragLeave(columnId: string) {
    setColumnDragOverId((prev) => (prev === columnId ? null : prev));
  }

  function handleColumnDrop(e: React.DragEvent, targetColumnId: string) {
    e.preventDefault();
    e.stopPropagation();
    setColumnDragOverId(null);
    const sourceId = draggedColumnId.current;
    draggedColumnId.current = null;
    if (!sourceId || sourceId === targetColumnId || !onColumnReorder) return;

    const sorted = [...activeColumns].sort((a, b) => a.sortOrder - b.sortOrder);
    const targetIdx = sorted.findIndex((c) => c.id === targetColumnId);
    if (targetIdx < 0) return;

    const sortOrders = sorted.map((c) => c.sortOrder);
    const sourceIdx = sorted.findIndex((c) => c.id === sourceId);

    let newSortOrder: number;
    if (sourceIdx > targetIdx) {
      // moving left: place before targetIdx
      newSortOrder = targetIdx === 0 ? sortOrders[0] - 100 : Math.round((sortOrders[targetIdx - 1] + sortOrders[targetIdx]) / 2);
    } else {
      // moving right: place after targetIdx
      newSortOrder = targetIdx === sortOrders.length - 1 ? sortOrders[sortOrders.length - 1] + 100 : Math.round((sortOrders[targetIdx] + sortOrders[targetIdx + 1]) / 2);
    }

    onColumnReorder(sourceId, newSortOrder);
  }

  function handleColumnDragEnd() {
    draggedColumnId.current = null;
    setColumnDragOverId(null);
  }

  const pinnedIssues = allColumns.flatMap((c) => c.issues).filter((i) => i.pinned);

  function handleMobileCreateClick(statusId: string) {
    if (typeof window !== "undefined" && window.innerWidth < 640) {
      const col = activeColumns.find((c) => c.id === statusId);
      if (col) {
        onExpandCreate(statusId, col.name, {});
        return;
      }
    }
    onCreateClick(statusId);
  }

  return (
    <>
      <PinnedStrip
        issues={pinnedIssues}
        onIssueClick={onIssueClick}
        onUnpin={(issueId) => quickUpdate?.onTogglePinned?.(issueId, false)}
      />
      {/* The mobile column quick-jump strip was removed: with columns stacked
          vertically each header is visible inline and the pulse shows live counts,
          so the strip was redundant chrome eating a row. */}
      <div className={`flex flex-1 min-h-0 board-columns-scroll ${isNarrow ? "flex-col gap-2 overflow-y-auto" : "gap-0 overflow-x-auto"}`}>
        {activeColumns.map((col, colIdx) => {
          if (focusMode && col.issues.length === 0) {
            return (
              <BoardErrorBoundary key={col.id} columnName={col.name}>
                <div
                  className={`shrink-0 ${isNarrow ? "w-full" : "w-8"} bg-surface-sunken dark:bg-surface-sunken-dark rounded-xl flex ${isNarrow ? "flex-row items-center gap-2 px-3 py-2" : "flex-col items-center py-3 gap-1"} opacity-40`}
                  title={`${col.name} — no in-flight issues`}
                >
                  <span className={`font-semibold text-[10px] text-ink-faint dark:text-gray-500 tracking-tight ${isNarrow ? "" : "[writing-mode:vertical-rl] rotate-180"}`}>{col.name}</span>
                  <span className="text-[10px] text-ink-faint dark:text-gray-500 font-medium">0</span>
                </div>
              </BoardErrorBoundary>
            );
          }
          return (
          <BoardErrorBoundary key={col.id} columnName={col.name}>
            <BoardColumn
              column={col}
              stacked={isNarrow}
              style={
                isNarrow
                  ? undefined
                  : columnWidths[col.id]
                    ? undefined
                    : dynamicColumnScaling
                      ? { flexGrow: Math.max(1, col.issues.length) }
                      : colIdx === activeColumns.length - 1 && Object.keys(columnWidths).length === 0
                        ? { flexGrow: 1 }
                        : undefined
              }
              width={isNarrow ? undefined : columnWidths[col.id]}
              onResizeStart={!isNarrow && colIdx < activeColumns.length - 1 ? (e) => onColumnResizeStart(col.id, e) : undefined}
              onResizeReset={!isNarrow && colIdx < activeColumns.length - 1 ? () => onColumnResizeReset(col.id) : undefined}
              projectId={projectId}
              creatingInColumn={creatingInColumnId}
              onCreateClick={handleMobileCreateClick}
              onCreateCancel={onCreateCancel}
              onIssueClick={onIssueClick}
              onWorkspaceClick={onWorkspaceClick}
              onOpenDiff={onOpenDiff}
              onStartWorkspace={onStartWorkspace}
              onDryRun={onDryRun}
              onDragStart={onDragStart}
              onDrop={onDrop}
              onDuplicate={onDuplicate}
              onMoveToNext={onMoveToNext}
              onDeleteIssue={onDeleteIssue}
              allColumns={allColumns}
              searchQuery={searchQuery}
              sessionActivity={sessionActivity}
              liveStats={liveStats}
              sessionTodos={sessionTodos}
              pendingIssueIds={pendingIssueIds}
              pendingWorkspaceIssueIds={pendingWorkspaceIssueIds}
              selectedIssueIds={selectedIssueIds}
              keyboardCursorIssueId={keyboardCursorIssueId}
              allProjectTags={allProjectTags}
              quickUpdate={quickUpdate}
              wipLimit={wipLimits?.[col.id]}
              onSetWipLimit={onSetWipLimit}
              cardDensity={cardDensity}
              onColumnDragStart={onColumnReorder && !isNarrow ? (e) => handleColumnDragStart(e, col.id) : undefined}
              onColumnDragOver={onColumnReorder && !isNarrow ? (e) => handleColumnDragOver(e, col.id) : undefined}
              onColumnDragLeave={onColumnReorder && !isNarrow ? () => handleColumnDragLeave(col.id) : undefined}
              onColumnDrop={onColumnReorder && !isNarrow ? (e) => handleColumnDrop(e, col.id) : undefined}
              onColumnDragEnd={onColumnReorder && !isNarrow ? handleColumnDragEnd : undefined}
              isColumnDragOver={columnDragOverId === col.id}
              swimlaneDimension={swimlaneDimension}
              onDropWithLane={onDropWithLane}
              showAgingHeatmap={showAgingHeatmap}
              agingWarmDays={agingWarmDays}
              agingHotDays={agingHotDays}
            >
              <CreateIssueForm
                projectId={projectId}
                statusId={col.id}
                onSubmit={onCreateIssue}
                onCancel={onCreateCancel}
                canStartWorkspace={canStartWorkspace}
                onExpand={(state) => {
                  onCreateCancel();
                  onExpandCreate(col.id, col.name, state);
                }}
              />
            </BoardColumn>
          </BoardErrorBoundary>
          );
        })}
      </div>
      <BoardErrorBoundary columnName="Archive">
        <CompletedGrid
          columns={archiveColumns}
          collapsed={collapsedArchive}
          onToggle={onToggleArchive}
          onIssueClick={onIssueClick}
          onDragStart={onDragStart}
          onDrop={onDrop}
          searchQuery={searchQuery}
          selectedIssueIds={selectedIssueIds}
        />
      </BoardErrorBoundary>
    </>
  );
}
