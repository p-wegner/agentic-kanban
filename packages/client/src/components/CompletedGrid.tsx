import { useMemo, useRef, useState } from "react";
import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { CompletedCard } from "./CompletedCard.js";

interface CompletedGridProps {
  columns: StatusWithIssues[];
  collapsed: boolean;
  onToggle: () => void;
  onIssueClick: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  onDrop: (statusId: string, sortOrder?: number) => void;
  searchQuery?: string;
}

export function CompletedGrid({
  columns,
  collapsed,
  onToggle,
  onIssueClick,
  onDragStart,
  onDrop,
  searchQuery,
}: CompletedGridProps) {
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);

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
        <span className="text-sm font-medium text-gray-600">Completed</span>
        <span className="text-xs text-gray-400 flex items-center gap-1.5 min-w-0">
          <span className="bg-gray-200 rounded-full px-1.5 py-0.5 shrink-0">{totalIssues}</span>
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
  }

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

  return (
    <div className="shrink-0 max-h-[40vh] overflow-y-auto scrollbar-hide">
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
        <span className="font-medium">Completed</span>
        <span className="text-xs text-gray-400">{totalIssues}</span>
      </button>

      <div
        className={`rounded-lg p-3 transition-all ${
          dragOver ? "ring-2 ring-blue-400 ring-offset-1 bg-blue-50/30" : "bg-gray-50/50"
        }`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
        >
          {allIssues.map((issue) => (
            <CompletedCard
              key={issue.id}
              issue={issue}
              onClick={onIssueClick}
              onDragStart={onDragStart}
              searchQuery={searchQuery}
            />
          ))}
        </div>
        {allIssues.length === 0 && !dragOver && (
          <p className="text-xs text-gray-400 text-center py-4">No completed issues</p>
        )}
      </div>
    </div>
  );
}
