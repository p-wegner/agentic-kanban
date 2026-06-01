import type { IssueWithStatus } from "@agentic-kanban/shared";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";

interface CompletedCardProps {
  issue: IssueWithStatus;
  onClick: (issue: IssueWithStatus, event: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  searchQuery?: string;
  isSelected?: boolean;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return <>{text}</>;
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return (
    <>
      {before}
      <mark className="bg-yellow-200 rounded px-0.5">{match}</mark>
      {after}
    </>
  );
}

export function CompletedCard({ issue, onClick, onDragStart, searchQuery, isSelected }: CompletedCardProps) {
  const isCancelled = issue.statusName === "Cancelled";
  const ws = issue.workspaceSummary;
  const mainWs = ws?.main;

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, issue)}
      onClick={(e) => onClick(issue, e)}
      aria-selected={isSelected ? "true" : undefined}
      className={
        `group rounded-md shadow-sm p-2.5 border cursor-pointer ` +
        `hover:shadow-md transition-shadow ` +
        (isSelected
          ? "ring-2 ring-brand-400 border-brand-500 "
          : "") +
        (isCancelled
          ? "bg-red-50/50 border-red-200/60 hover:border-red-300"
          : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600")
      }
    >
      {isSelected && (
        <span className="float-right ml-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[9px] font-semibold text-white">
          ✓
        </span>
      )}
      <div className="flex min-w-0 items-start justify-between gap-1.5">
        <p className={`text-xs leading-snug min-w-0 break-words ${isCancelled ? "line-through text-gray-400 dark:text-gray-500" : "text-gray-800 dark:text-gray-200"}`}>
          {issue.issueNumber != null && (
            <span className="text-gray-400 dark:text-gray-500 font-mono mr-0.5">#{issue.issueNumber}</span>
          )}
          <HighlightedText text={issue.title} query={searchQuery ?? ""} />
        </p>
        {isCancelled && (
          <span className="shrink-0 text-[10px] font-medium px-1 py-0.5 rounded bg-red-100 text-red-600">
            Cancelled
          </span>
        )}
      </div>

      <div className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">
        {issue.statusChangedAt
          ? formatRelativeTime(issue.statusChangedAt)
          : formatRelativeTime(issue.updatedAt)}
      </div>

      {mainWs && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 mt-1.5 text-[10px] text-gray-500 dark:text-gray-400">
          <span className="min-w-0 flex-1 basis-24 font-mono truncate">{mainWs.branch}</span>
          {mainWs.diffStats && (
            <span className="inline-flex items-center gap-0.5 font-mono shrink-0">
              <span className="text-green-600">+{mainWs.diffStats.insertions}</span>
              <span className="text-red-500">-{mainWs.diffStats.deletions}</span>
              <span className="text-gray-400 dark:text-gray-500">{mainWs.diffStats.filesChanged}f</span>
            </span>
          )}
          {ws && ws.total > 1 && (
            <span className="text-gray-400 dark:text-gray-500 shrink-0">{ws.total} ws</span>
          )}
        </div>
      )}
    </div>
  );
}
