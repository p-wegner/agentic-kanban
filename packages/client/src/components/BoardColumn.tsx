import { useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { IssueCard } from "./IssueCard.js";

interface BoardColumnProps {
  column: StatusWithIssues;
  projectId: string;
  creatingInColumn: string | null;
  onCreateClick: (statusId: string) => void;
  onCreateCancel: () => void;
  onIssueClick: (issue: IssueWithStatus) => void;
  onWorkspaceClick?: (issue: IssueWithStatus, workspaceId?: string) => void;
  onStartWorkspace?: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDrop: (statusId: string, sortOrder?: number) => void;
  searchQuery?: string;
  sessionActivity?: Record<string, string>;
  liveStats?: Record<string, LiveSessionStats>;
  sessionTodos?: Record<string, TodoItem[]>;
  children?: React.ReactNode;
}

export function BoardColumn({
  column,
  projectId,
  creatingInColumn,
  onCreateClick,
  onCreateCancel,
  onIssueClick,
  onWorkspaceClick,
  onStartWorkspace,
  onDragStart,
  onDrop,
  searchQuery,
  sessionActivity,
  liveStats,
  sessionTodos,
  children,
}: BoardColumnProps) {
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current++;
    setDragOver(true);
  }

  function handleDragLeave() {
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setDragOver(false);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOver(false);
    onDrop(column.id);
  }

  function handleDropGap(e: React.DragEvent, sortOrder: number) {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setDragOver(false);
    onDrop(column.id, sortOrder);
  }

  function computeGapSortOrder(beforeIndex: number): number {
    const issues = column.issues;
    if (beforeIndex === 0) {
      // Before first item
      const first = issues[0].sortOrder;
      return first - 100;
    }
    const before = issues[beforeIndex - 1].sortOrder;
    const after = issues[beforeIndex].sortOrder;
    return Math.round((before + after) / 2);
  }

  const isCreating = creatingInColumn === column.id;

  return (
    <div
      className={`w-72 shrink-0 bg-gray-100 rounded-lg p-3 flex flex-col transition-all ${
        dragOver ? "ring-2 ring-blue-400 ring-offset-1" : ""
      }`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="font-medium text-sm text-gray-700">
          {column.name}
          <span className="ml-2 text-xs text-gray-400 bg-gray-200 rounded-full px-1.5 py-0.5">{column.issues.length}</span>
        </h2>
        {!isCreating && (
          <button
            onClick={() => onCreateClick(column.id)}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
            title="Add issue"
          >
            +
          </button>
        )}
      </div>

      <div className="space-y-2 flex-1 min-h-0 overflow-y-auto scrollbar-hide">
        {column.issues.map((issue: IssueWithStatus, idx: number) => (
          <div key={issue.id}>
            <DropGap
              visible={dragOver}
              onDrop={(e) => handleDropGap(e, computeGapSortOrder(idx))}
            />
            <IssueCard
              issue={issue}
              onClick={onIssueClick}
              onWorkspaceClick={onWorkspaceClick}
              onStartWorkspace={onStartWorkspace}
              onDragStart={onDragStart}
              searchQuery={searchQuery}
              liveActivity={sessionActivity?.[issue.id]}
              liveStats={liveStats?.[issue.id]}
              todos={sessionTodos?.[issue.id]}
            />
          </div>
        ))}
        {dragOver && column.issues.length > 0 && (
          <DropGap
            visible={true}
            onDrop={(e) => {
              const lastSort = column.issues[column.issues.length - 1].sortOrder;
              handleDropGap(e, lastSort + 100);
            }}
          />
        )}
        {isCreating && children}
        {column.issues.length === 0 && !isCreating && !dragOver && (
          <p className="text-xs text-gray-400 text-center py-4">No issues</p>
        )}
      </div>
    </div>
  );
}

function DropGap({
  visible,
  onDrop,
}: {
  visible: boolean;
  onDrop: (e: React.DragEvent) => void;
}) {
  if (!visible) return null;
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className="h-1 rounded bg-blue-400/50 my-1"
    />
  );
}
