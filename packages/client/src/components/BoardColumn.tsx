import { useCallback, useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "../lib/useBoardEvents.js";
import { IssueCard } from "./IssueCard.js";

type SortMode = "default" | "priority";

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function sortIssues(issues: IssueWithStatus[], mode: SortMode): IssueWithStatus[] {
  if (mode === "default") return issues;
  return [...issues].sort(
    (a, b) =>
      (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99)
  );
}

function loadSortMode(columnId: string): SortMode {
  try {
    return (localStorage.getItem(`col-sort-${columnId}`) as SortMode) ?? "default";
  } catch {
    return "default";
  }
}

interface BoardColumnProps {
  column: StatusWithIssues;
  allColumns?: StatusWithIssues[];
  projectId: string;
  creatingInColumn: string | null;
  onCreateClick: (statusId: string) => void;
  onCreateCancel: () => void;
  onIssueClick: (issue: IssueWithStatus) => void;
  onWorkspaceClick?: (issue: IssueWithStatus, workspaceId?: string) => void;
  onStartWorkspace?: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDrop: (statusId: string, sortOrder?: number) => void;
  onMoveToNext?: (issue: IssueWithStatus, nextStatusId: string) => void;
  searchQuery?: string;
  sessionActivity?: Record<string, string>;
  liveStats?: Record<string, LiveSessionStats>;
  sessionTodos?: Record<string, TodoItem[]>;
  pendingWorkspaceIssueIds?: Set<string>;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  width?: number;
  onResizeStart?: (e: React.MouseEvent) => void;
  onResizeReset?: () => void;
}

const ARCHIVE_STATUS_NAMES = new Set(["Done", "Cancelled"]);

export function BoardColumn({
  column,
  allColumns,
  projectId,
  creatingInColumn,
  onCreateClick,
  onCreateCancel,
  onIssueClick,
  onWorkspaceClick,
  onStartWorkspace,
  onDragStart,
  onDrop,
  onMoveToNext,
  searchQuery,
  sessionActivity,
  liveStats,
  sessionTodos,
  pendingWorkspaceIssueIds,
  children,
  style,
  width,
  onResizeStart,
  onResizeReset,
}: BoardColumnProps) {
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState<"top" | "middle" | "bottom" | "none">("none");
  const [sortMode, setSortMode] = useState<SortMode>(() => loadSortMode(column.id));

  const nextStatus = allColumns && !ARCHIVE_STATUS_NAMES.has(column.name)
    ? (() => {
        const sorted = [...allColumns].sort((a, b) => a.sortOrder - b.sortOrder);
        const idx = sorted.findIndex((c) => c.id === column.id);
        return idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
      })()
    : null;

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
    // Uses displayedIssues so gap positions match visual order
    if (beforeIndex === 0) {
      return displayedIssues[0].sortOrder - 100;
    }
    const before = displayedIssues[beforeIndex - 1].sortOrder;
    const after = displayedIssues[beforeIndex].sortOrder;
    return Math.round((before + after) / 2);
  }

  function toggleSort() {
    const next: SortMode = sortMode === "default" ? "priority" : "default";
    setSortMode(next);
    try {
      localStorage.setItem(`col-sort-${column.id}`, next);
    } catch {
      // ignore
    }
  }

  const isCreating = creatingInColumn === column.id;
  const displayedIssues = sortIssues(column.issues, sortMode);

  const columnStyle: React.CSSProperties = width != null
    ? { width, minWidth: 160, maxWidth: 800, flexShrink: 0, ...style }
    : style ?? {};

  return (
    <div style={{ display: "contents" }}>
    <div
      id={`column-${column.id}`}
      className={`${width != null ? "" : "w-[calc(100vw-2rem)] sm:w-72 shrink-0"} bg-gray-100 rounded-xl p-2 flex flex-col transition-all relative ${
        dragOver ? "ring-2 ring-blue-400 ring-offset-1" : ""
      }`}
      style={columnStyle}
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
        <div className="flex items-center gap-1">
          <button
            onClick={toggleSort}
            className={`text-xs rounded-md px-1.5 py-0.5 transition-colors ${
              sortMode === "priority"
                ? "bg-blue-100 text-blue-600 hover:bg-blue-200"
                : "text-gray-400 hover:text-gray-600 hover:bg-white/60"
            }`}
            title={sortMode === "priority" ? "Sorted by priority — click for default" : "Sort by priority"}
          >
            ↑P
          </button>
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
          {displayedIssues.map((issue: IssueWithStatus, idx: number) => (
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
                onMoveToNext={nextStatus && onMoveToNext ? (iss) => onMoveToNext(iss, nextStatus.id) : undefined}
                nextStatusName={nextStatus?.name}
                searchQuery={searchQuery}
                liveActivity={sessionActivity?.[issue.id]}
                liveStats={liveStats?.[issue.id]}
                todos={sessionTodos?.[issue.id]}
                isPendingWorkspace={pendingWorkspaceIssueIds?.has(issue.id)}
              />
            </div>
          ))}
          {dragOver && displayedIssues.length > 0 && (
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
    {onResizeStart && (
      <div
        className="hidden sm:flex w-2 shrink-0 cursor-col-resize items-center justify-center group self-stretch"
        onMouseDown={onResizeStart}
        onDoubleClick={onResizeReset}
        title="Drag to resize · Double-click to reset"
      >
        <div className="w-0.5 h-8 rounded-full bg-gray-300 group-hover:bg-blue-400 transition-colors" />
      </div>
    )}
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
