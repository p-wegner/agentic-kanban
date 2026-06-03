import { useMemo, useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { CompletedCard } from "./CompletedCard.js";
import { useIsNarrow } from "../hooks/useMediaQuery.js";

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

  // On phones the completed list opens as a bottom-sheet overlay rather than an
  // inline block, so it never competes with the board for vertical room: the
  // thin collapsed bar stays in-flow, and the sheet floats above when expanded.
  if (isNarrow) {
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
    <div className="shrink-0 max-h-[50vh] sm:max-h-[40vh] overflow-y-auto scrollbar-hide">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mb-2 transition-colors"
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

      <div
        className={`rounded-lg p-3 transition-all ${
          dragOver ? "ring-2 ring-brand-400 ring-offset-1 bg-brand-50/30" : "bg-gray-50/50 dark:bg-gray-950/50"
        }`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {cardsGrid}
        {allIssues.length === 0 && !dragOver && (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">No completed issues</p>
        )}
      </div>
    </div>
  );
}
