import { BoardColumn } from "./BoardColumn.js";
import { CreateIssueForm } from "./CreateIssueForm.js";
import type { CreateIssueRequest, IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";

interface ColumnGroupProps {
  label: string;
  columns: StatusWithIssues[];
  collapsed: boolean;
  onToggle: () => void;
  projectId: string;
  creatingInColumn: string | null;
  onCreateClick: (statusId: string) => void;
  onCreateCancel: () => void;
  onCreateSubmit: (data: CreateIssueRequest & { startWorkspace?: boolean; planMode?: boolean }) => Promise<void>;
  onIssueClick: (issue: IssueWithStatus) => void;
  onWorkspaceClick?: (issue: IssueWithStatus, workspaceId?: string) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDrop: (statusId: string, sortOrder?: number) => void;
  searchQuery: string;
  sessionActivity?: Record<string, string>;
  canStartWorkspace?: boolean;
}

export function ColumnGroup({
  label,
  columns,
  collapsed,
  onToggle,
  projectId,
  creatingInColumn,
  onCreateClick,
  onCreateCancel,
  onCreateSubmit,
  onIssueClick,
  onWorkspaceClick,
  onDragStart,
  onDrop,
  searchQuery,
  sessionActivity,
  canStartWorkspace = false,
}: ColumnGroupProps) {
  if (columns.length === 0) return null;

  if (collapsed) {
    return (
      <button
        onClick={onToggle}
        className="w-full bg-gray-50 border border-gray-200 rounded-lg px-4 py-2 flex items-center gap-3 hover:bg-gray-100 transition-colors text-left"
      >
        <svg
          className="w-4 h-4 text-gray-400 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-sm font-medium text-gray-600">{label}</span>
        <span className="flex items-center gap-2 text-xs text-gray-400">
          {columns.map((col, i) => (
            <span key={col.id} className="flex items-center gap-2">
              {i > 0 && <span className="text-gray-300">&middot;</span>}
              <span>
                {col.name}{" "}
                <span className="bg-gray-200 rounded-full px-1.5 py-0.5">
                  {col.issues.length}
                </span>
              </span>
            </span>
          ))}
        </span>
      </button>
    );
  }

  return (
    <div>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-2 transition-colors"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        <span className="font-medium">{label}</span>
      </button>
      <div className="flex flex-col gap-4 sm:flex-row sm:overflow-x-auto">
        {columns.map((col) => (
          <BoardColumn
            key={col.id}
            column={col}
            projectId={projectId}
            creatingInColumn={creatingInColumn}
            onCreateClick={onCreateClick}
            onCreateCancel={onCreateCancel}
            onIssueClick={onIssueClick}
            onWorkspaceClick={onWorkspaceClick}
            onDragStart={onDragStart}
            onDrop={onDrop}
            searchQuery={searchQuery}
            sessionActivity={sessionActivity}
          >
            <CreateIssueForm
              projectId={projectId}
              statusId={col.id}
              onSubmit={onCreateSubmit}
              onCancel={onCreateCancel}
              canStartWorkspace={canStartWorkspace}
            />
          </BoardColumn>
        ))}
      </div>
    </div>
  );
}
