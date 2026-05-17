import type { IssueWithStatus } from "@agentic-kanban/shared";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";

interface CompletedCardProps {
  issue: IssueWithStatus;
  onClick: (issue: IssueWithStatus) => void;
  onDragStart: (e: React.DragEvent, issue: IssueWithStatus) => void;
  searchQuery?: string;
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

export function CompletedCard({ issue, onClick, onDragStart, searchQuery }: CompletedCardProps) {
  const isCancelled = issue.statusName === "Cancelled";
  const ws = issue.workspaceSummary;
  const mainWs = ws?.main;

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, issue)}
      onClick={() => onClick(issue)}
      className={
        `group rounded-md shadow-sm p-2.5 border cursor-pointer ` +
        `hover:shadow-md transition-shadow ` +
        (isCancelled
          ? "bg-red-50/50 border-red-200/60 hover:border-red-300"
          : "bg-white border-gray-200 hover:border-gray-300")
      }
    >
      <div className="flex items-start justify-between gap-1.5">
        <p className={`text-xs leading-snug min-w-0 ${isCancelled ? "line-through text-gray-400" : "text-gray-800"}`}>
          {issue.issueNumber != null && (
            <span className="text-gray-400 font-mono mr-0.5">#{issue.issueNumber}</span>
          )}
          <HighlightedText text={issue.title} query={searchQuery ?? ""} />
        </p>
        {isCancelled && (
          <span className="shrink-0 text-[10px] font-medium px-1 py-0.5 rounded bg-red-100 text-red-600">
            Cancelled
          </span>
        )}
      </div>

      <div className="text-[10px] text-gray-400 mt-1">
        {issue.statusChangedAt
          ? formatRelativeTime(issue.statusChangedAt)
          : formatRelativeTime(issue.updatedAt)}
      </div>

      {mainWs && (
        <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-gray-500">
          <span className="font-mono truncate">{mainWs.branch}</span>
          {mainWs.diffStats && (
            <span className="inline-flex items-center gap-0.5 font-mono shrink-0 ml-auto">
              <span className="text-green-600">+{mainWs.diffStats.insertions}</span>
              <span className="text-red-500">-{mainWs.diffStats.deletions}</span>
              <span className="text-gray-400">{mainWs.diffStats.filesChanged}f</span>
            </span>
          )}
          {ws && ws.total > 1 && (
            <span className="text-gray-400 shrink-0">{ws.total} ws</span>
          )}
        </div>
      )}
    </div>
  );
}
