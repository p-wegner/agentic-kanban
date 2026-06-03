import type { IssueWithStatus, StatusWithIssues, CreateIssueRequest, ProfileSelection } from "@agentic-kanban/shared";
import { BoardErrorBoundary } from "./BoardErrorBoundary.js";
import { BoardColumn } from "./BoardColumn.js";
import { CompletedGrid } from "./CompletedGrid.js";
import { CreateIssueForm } from "./CreateIssueForm.js";
import type { CreateIssueFormState } from "./CreateIssueForm.js";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { useIsNarrow } from "../hooks/useMediaQuery.js";

export interface BoardKanbanViewProps {
  activeColumns: StatusWithIssues[];
  archiveColumns: StatusWithIssues[];
  allColumns: StatusWithIssues[];
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
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDrop: (statusId: string, sortOrder?: number) => void;
  onMoveToNext: (issue: IssueWithStatus, nextStatusId: string) => void;
  onColumnResizeStart: (colId: string, e: React.MouseEvent) => void;
  onColumnResizeReset: (colId: string) => void;
  onCreateIssue: (data: CreateIssueRequest & { startWorkspace?: boolean; planMode?: boolean; skipAutoReview?: boolean; profile?: ProfileSelection; model?: string; isDirect?: boolean; skillId?: string }) => Promise<void>;
  onExpandCreate: (statusId: string, statusName: string, state: Partial<CreateIssueFormState>) => void;
  selectedIssueIds?: Set<string>;
}

export function BoardKanbanView({
  activeColumns,
  archiveColumns,
  allColumns,
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
  onDragStart,
  onDrop,
  onMoveToNext,
  onColumnResizeStart,
  onColumnResizeReset,
  onCreateIssue,
  onExpandCreate,
  selectedIssueIds,
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
        {activeColumns.map((col, colIdx) => (
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
        ))}
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
