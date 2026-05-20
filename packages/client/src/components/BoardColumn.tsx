import { useCallback, useRef, useState } from "react";
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
  style?: React.CSSProperties;
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
  style,
}: BoardColumnProps) {
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState<"top" | "middle" | "bottom" | "none">("none");

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const atTop = scrollTop <= 2;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 2;
    if (scrollHeight <= clientHeight + 4) {
      setScrollState("none");
    } else if (atTop && !atBottom) {
      setScrollState("top");
    } else if (atBottom && !atTop) {
      setScrollState("bottom");
    } else {
      setScrollState("middle");
    }
  }, []);

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
      id={`column-${column.id}`}
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
      className={`w-[calc(100vw-2rem)] sm:w-72 shrink-0 bg-gray-100 rounded-xl p-2 flex flex-col transition-all relative ${
=======
      className={`w-[88vw] sm:w-64 lg:w-72 shrink-0 bg-gray-100 rounded-xl p-2 flex flex-col transition-all relative ${
>>>>>>> 65f7a08 (feat: make kanban board truly responsive for mobile)
=======
      className={`w-72 shrink-0 bg-gray-100 rounded-xl p-2 flex flex-col transition-all relative ${
>>>>>>> 5d43535 (revert: remove table view and revert mobile-responsive board styling)
=======
      className={`w-[calc(100vw-2rem)] sm:w-72 shrink-0 bg-gray-100 rounded-xl p-2 flex flex-col transition-all relative ${
>>>>>>> 2713ec4 (feat: make kanban board truly responsive)
=======
      className={`w-[88vw] sm:w-64 lg:w-72 shrink-0 bg-gray-100 rounded-xl p-2 flex flex-col transition-all relative ${
>>>>>>> e0c9cf4 (feat: make kanban board truly responsive for mobile)
=======
      className={`w-72 shrink-0 bg-gray-100 rounded-xl p-2 flex flex-col transition-all relative ${
>>>>>>> 8f2f90d (revert: remove table view and revert mobile-responsive board styling)
=======
      className={`w-[calc(100vw-2rem)] sm:w-72 shrink-0 bg-gray-100 rounded-xl p-2 flex flex-col transition-all relative ${
>>>>>>> c6d8504 (feat: make kanban board truly responsive)
=======
      className={`w-[88vw] sm:w-64 lg:w-72 shrink-0 bg-gray-100 rounded-xl p-2 flex flex-col transition-all relative ${
>>>>>>> f0547d3 (feat: make kanban board truly responsive for mobile)
        dragOver ? "ring-2 ring-blue-400 ring-offset-1" : ""
      }`}
      style={style}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between mb-2 px-1 shrink-0">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-semibold text-sm text-gray-700 flex items-center gap-2">
            {column.name}
            <span className="text-[11px] text-gray-400 bg-white/80 rounded-full px-2 py-0.5 font-medium shadow-sm">
              {column.issues.length}
            </span>
          </h2>
          {column.name === "AI Reviewed" && (
            <span className="text-[10px] text-purple-500 font-medium">Awaiting manual merge</span>
          )}
        </div>
        {!isCreating && column.name === "Todo" && (
          <button
            onClick={() => onCreateClick(column.id)}
            className="text-gray-400 hover:text-gray-600 hover:bg-white/60 rounded-md w-6 h-6 flex items-center justify-center text-lg leading-none transition-colors"
            title="Add issue"
          >
            +
          </button>
        )}
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden rounded-lg">
        {(scrollState === "top" || scrollState === "middle") && (
          <div className="absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-gray-100 to-transparent z-10 pointer-events-none rounded-t-lg" />
        )}
        <div
          ref={scrollRef}
          onScroll={updateScrollState}
          className="space-y-1.5 h-full overflow-y-auto column-scroll-container pb-6"
        >
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
        {(scrollState === "bottom" || scrollState === "middle") && (
          <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-gray-100 to-transparent z-10 pointer-events-none rounded-b-lg" />
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
