import type { IssueWithStatus, StatusWithIssues, CreateIssueRequest, ProfileSelection } from "@agentic-kanban/shared";
import { BoardErrorBoundary } from "./BoardErrorBoundary.js";
import { BoardColumn } from "./BoardColumn.js";
import type { ProjectTag, QuickUpdateCallbacks } from "./IssueCard.js";
import { CompletedGrid } from "./CompletedGrid.js";
import { CreateIssueForm } from "./CreateIssueForm.js";
import type { CreateIssueFormState } from "./CreateIssueForm.js";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { useIsNarrow } from "../hooks/useMediaQuery.js";

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
  onStartWorkspace: (issue: IssueWithStatus) => void;
  onDryRun?: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDrop: (statusId: string, sortOrder?: number) => void;
  onMoveToNext: (issue: IssueWithStatus, nextStatusId: string) => void;
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
  onStartWorkspace,
  onDryRun,
  onDragStart,
  onDrop,
  onMoveToNext,
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
}: BoardKanbanViewProps) {
  // Below sm, columns stack vertically and the board scrolls down through them
  // (instead of a horizontal one-column-at-a-time swipe, where an empty column
  // wastes the whole screen). Stacked columns are full-width and auto-height.
  const isNarrow = useIsNarrow();

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
              onStartWorkspace={onStartWorkspace}
              onDryRun={onDryRun}
              onDragStart={onDragStart}
              onDrop={onDrop}
              onMoveToNext={onMoveToNext}
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
