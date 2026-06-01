import type { IssueWithStatus, StatusWithIssues, CreateIssueRequest, ProfileSelection } from "@agentic-kanban/shared";
import { BoardErrorBoundary } from "./BoardErrorBoundary.js";
import { BoardColumn } from "./BoardColumn.js";
import { CompletedGrid } from "./CompletedGrid.js";
import { CreateIssueForm } from "./CreateIssueForm.js";
import type { CreateIssueFormState } from "./CreateIssueForm.js";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";

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

  const archiveIssueCount = archiveColumns.reduce((s, c) => s + c.issues.length, 0);

  return (
    <>
      {(activeColumns.length > 1 || archiveIssueCount > 0) && (
        <div className="flex sm:hidden gap-1 overflow-x-auto scrollbar-hide shrink-0">
          {activeColumns.map((col) => (
            <button
              key={col.id}
              onClick={() => {
                document.getElementById(`column-${col.id}`)?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
              }}
              className="shrink-0 px-3 py-1 text-xs rounded-full border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:bg-brand-50 dark:hover:bg-brand-950 hover:border-brand-300 hover:text-brand-700 transition-colors"
            >
              {col.name}
              <span className="ml-1 text-gray-400 dark:text-gray-500">{col.issues.length}</span>
            </button>
          ))}
          {archiveIssueCount > 0 && (
            <button
              onClick={onToggleArchive}
              className={`shrink-0 px-3 py-1 text-xs rounded-full border transition-colors ${
                !collapsedArchive
                  ? "border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-400"
                  : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:bg-green-50 dark:hover:bg-green-950 hover:border-green-300 hover:text-green-700 dark:hover:text-green-400"
              }`}
            >
              ✓ Done
              <span className="ml-1 text-gray-400 dark:text-gray-500">{archiveIssueCount}</span>
            </button>
          )}
        </div>
      )}
      <div className="flex gap-0 flex-1 min-h-0 overflow-x-auto board-columns-scroll">
        {activeColumns.map((col, colIdx) => (
          <BoardErrorBoundary key={col.id} columnName={col.name}>
            <BoardColumn
              column={col}
              style={
                columnWidths[col.id]
                  ? undefined
                  : dynamicColumnScaling
                    ? { flexGrow: Math.max(1, col.issues.length) }
                    : colIdx === activeColumns.length - 1 && Object.keys(columnWidths).length === 0
                      ? { flexGrow: 1 }
                      : undefined
              }
              width={columnWidths[col.id]}
              onResizeStart={colIdx < activeColumns.length - 1 ? (e) => onColumnResizeStart(col.id, e) : undefined}
              onResizeReset={colIdx < activeColumns.length - 1 ? () => onColumnResizeReset(col.id) : undefined}
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
