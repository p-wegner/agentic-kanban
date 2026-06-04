import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { CompletedCard } from "./CompletedCard.js";
import { ColumnMinimap } from "./ColumnMinimap.js";
import { useIsNarrow } from "../hooks/useMediaQuery.js";

const MINIMAP_THRESHOLD = 20;

const CARD_MIN_WIDTH = 220;
const CARD_GAP = 8;
const ESTIMATED_ROW_HEIGHT = 90;

interface CompletedGridProps {
  columns: StatusWithIssues[];
  collapsed: boolean;
  onToggle: () => void;
  onIssueClick: (issue: IssueWithStatus, event: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDrop: (statusId: string, sortOrder?: number) => void;
  searchQuery?: string;
  selectedIssueIds?: Set<string>;
}

export function CompletedGrid({
  columns,
  collapsed,
  onToggle,
  onIssueClick,
  onDragStart,
  onDrop,
  searchQuery,
  selectedIssueIds,
}: CompletedGridProps) {
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const isNarrow = useIsNarrow();

  const totalIssues = useMemo(
    () => columns.reduce((sum, col) => sum + col.issues.length, 0),
    [columns],
  );

  const breakdown = useMemo(() => {
    const done = columns.find((c) => c.name === "Done")?.issues.length ?? 0;
    const cancelled = columns.find((c) => c.name === "Cancelled")?.issues.length ?? 0;
    return { done, cancelled };
  }, [columns]);

  const allIssues = useMemo(() => {
    return columns
      .flatMap((col) => col.issues)
      .sort((a, b) => {
        const aTime = a.statusChangedAt ? new Date(a.statusChangedAt).getTime() : 0;
        const bTime = b.statusChangedAt ? new Date(b.statusChangedAt).getTime() : 0;
        return bTime - aTime;
      });
  }, [columns]);

  const doneStatusId = columns.find((c) => c.name === "Done")?.id ?? columns[0]?.id;

  if (columns.length === 0 || totalIssues === 0) return null;

  const collapsedBar = (
      <button
        onClick={onToggle}
        className="shrink-0 w-full bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-3 flex items-center gap-3 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-left"
      >
        <svg
          className="w-4 h-4 text-gray-400 dark:text-gray-500 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Completed</span>
        <span className="text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1.5 min-w-0">
          <span className="bg-gray-200 dark:bg-gray-700 rounded-full px-1.5 py-0.5 shrink-0">{totalIssues}</span>
          {breakdown.done > 0 && breakdown.cancelled > 0 && (
            <span className="truncate">
              ({breakdown.done} done · {breakdown.cancelled} cancelled)
            </span>
          )}
          {breakdown.done > 0 && breakdown.cancelled === 0 && (
            <span className="truncate">(all done)</span>
          )}
          {breakdown.cancelled > 0 && breakdown.done === 0 && (
            <span className="truncate">(all cancelled)</span>
          )}
        </span>
      </button>
  );

  if (collapsed) return collapsedBar;

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current++;
    setDragOver(true);
  }

  function handleDragLeave() {
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setDragOver(false);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOver(false);
    if (doneStatusId) onDrop(doneStatusId);
  }

  // On phones the completed list opens as a bottom-sheet overlay rather than an
  // inline block, so it never competes with the board for vertical room: the
  // thin collapsed bar stays in-flow, and the sheet floats above when expanded.
  if (isNarrow) {
    const cardsGrid = (
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(220px, 100%), 1fr))" }}
      >
        {allIssues.map((issue) => (
          <CompletedCard
            key={issue.id}
            issue={issue}
            onClick={onIssueClick}
            onDragStart={onDragStart}
            searchQuery={searchQuery}
            isSelected={selectedIssueIds?.has(issue.id)}
          />
        ))}
      </div>
    );

    return (
      <>
        {collapsedBar}
        <div className="fixed inset-0 z-40 bg-black/40" onClick={onToggle}>
          <div
            className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-2xl border-t border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">Completed</span>
                <span className="rounded-full bg-gray-200 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400 shrink-0">{totalIssues}</span>
                {breakdown.done > 0 && breakdown.cancelled > 0 && (
                  <span className="truncate text-xs text-gray-400 dark:text-gray-500">{breakdown.done} done · {breakdown.cancelled} cancelled</span>
                )}
              </div>
              <button
                onClick={onToggle}
                aria-label="Close completed"
                className="shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto p-3">{cardsGrid}</div>
          </div>
        </div>
      </>
    );
  }

  return (
    <VirtualizedCompletedGrid
      allIssues={allIssues}
      dragOver={dragOver}
      onToggle={onToggle}
      onIssueClick={onIssueClick}
      onDragStart={onDragStart}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      searchQuery={searchQuery}
      selectedIssueIds={selectedIssueIds}
      totalIssues={totalIssues}
    />
  );
}

interface VirtualizedGridProps {
  allIssues: IssueWithStatus[];
  dragOver: boolean;
  totalIssues: number;
  onToggle: () => void;
  onIssueClick: (issue: IssueWithStatus, event: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  searchQuery?: string;
  selectedIssueIds?: Set<string>;
}

function VirtualizedCompletedGrid({
  allIssues,
  dragOver,
  totalIssues,
  onToggle,
  onIssueClick,
  onDragStart,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  searchQuery,
  selectedIssueIds,
}: VirtualizedGridProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const columnsPerRow = containerWidth > 0
    ? Math.max(1, Math.floor((containerWidth + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)))
    : 1;

  const rows = useMemo(() => {
    const result: IssueWithStatus[][] = [];
    for (let i = 0; i < allIssues.length; i += columnsPerRow) {
      result.push(allIssues.slice(i, i + columnsPerRow));
    }
    return result;
  }, [allIssues, columnsPerRow]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: useCallback(() => ESTIMATED_ROW_HEIGHT + CARD_GAP, []),
    overscan: 3,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();

  const showMinimap = allIssues.length >= MINIMAP_THRESHOLD;

  return (
    <div className="shrink-0 max-h-[50vh] sm:max-h-[40vh] overflow-hidden flex flex-col">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mb-2 transition-colors shrink-0"
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
        <span className="font-medium">Completed</span>
        <span className="text-xs text-gray-400 dark:text-gray-500">{totalIssues}</span>
      </button>

      <div className="flex flex-1 min-h-0">
        <div
          id="completed-grid-scroll"
          ref={scrollContainerRef}
          className={`rounded-lg p-3 flex-1 min-w-0 overflow-y-auto scrollbar-hide transition-all ${
            dragOver ? "ring-2 ring-brand-400 ring-offset-1 bg-brand-50/30" : "bg-gray-50/50 dark:bg-gray-950/50"
          }`}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {allIssues.length === 0 && !dragOver && (
            <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">No completed issues</p>
          )}
          {allIssues.length > 0 && (
            <div ref={innerRef} style={{ height: totalHeight, position: "relative" }}>
              {virtualRows.map((virtualRow) => {
                const rowItems = rows[virtualRow.index];
                return (
                  <div
                    key={virtualRow.key}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                      display: "grid",
                      gridTemplateColumns: `repeat(${columnsPerRow}, 1fr)`,
                      gap: `${CARD_GAP}px`,
                      paddingBottom: `${CARD_GAP}px`,
                    }}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                  >
                    {rowItems.map((issue) => (
                      <CompletedCard
                        key={issue.id}
                        issue={issue}
                        onClick={onIssueClick}
                        onDragStart={onDragStart}
                        searchQuery={searchQuery}
                        isSelected={selectedIssueIds?.has(issue.id)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {showMinimap && (
          <ColumnMinimap
            issues={allIssues}
            totalScrollHeight={totalHeight}
            scrollContainerRef={scrollContainerRef}
          />
        )}
      </div>
    </div>
  );
}
