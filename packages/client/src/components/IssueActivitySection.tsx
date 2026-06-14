import React from "react";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { showToast } from "./Toast.js";

export type ActivityEventType =
  | "issue_created"
  | "status_changed"
  | "workspace_created"
  | "workspace_launched"
  | "workspace_merged"
  | "workspace_closed"
  | "session_started"
  | "session_completed"
  | "session_failed"
  | "session_stopped"
  | "comment";

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  summary: string;
  actor: string | null;
  timestamp: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  commentKind?: string | null;
}

interface Props {
  events: ActivityEvent[];
  loading: boolean;
  issueTitle?: string;
  issueNumber?: number | null;
  currentStatusName?: string | null;
}

function markdownEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([`*_\[\]])/g, "\\$1");
}

function safeFileSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function issueActivityMarkdownFilename(issueTitle: string, issueNumber?: number | null): string {
  const prefix = issueNumber != null ? `issue-${issueNumber}` : "issue-activity";
  const titleSegment = safeFileSegment(issueTitle);
  return titleSegment ? `${prefix}-${titleSegment}-activity.md` : `${prefix}-activity.md`;
}

export function buildIssueActivityMarkdown(
  issueTitle: string,
  currentStatusName: string,
  events: ActivityEvent[],
): string {
  const lines = [
    `# ${markdownEscape(issueTitle)}`,
    "",
    `Current status: ${markdownEscape(currentStatusName)}`,
    "",
    "## Activity",
    "",
  ];

  const chronologicalEvents = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (chronologicalEvents.length === 0) {
    lines.push("_No activity recorded._");
  } else {
    for (const event of chronologicalEvents) {
      const timestamp = new Date(event.timestamp).toLocaleString();
      const actor = event.actor ? ` by ${markdownEscape(event.actor)}` : "";
      lines.push(`- **${markdownEscape(timestamp)}** - ${markdownEscape(event.summary)}${actor}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function downloadIssueActivityMarkdown(
  issueTitle: string,
  currentStatusName: string,
  issueNumber: number | null | undefined,
  events: ActivityEvent[],
): void {
  const markdown = buildIssueActivityMarkdown(issueTitle, currentStatusName, events);
  const blob = new Blob([markdown], { type: "text/markdown" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = issueActivityMarkdownFilename(issueTitle, issueNumber);
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

const EVENT_ICONS: Record<ActivityEventType, React.ReactNode> = {
  issue_created: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
    </svg>
  ),
  status_changed: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
    </svg>
  ),
  workspace_created: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  ),
  workspace_launched: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  workspace_merged: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  ),
  workspace_closed: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
  session_started: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
    </svg>
  ),
  session_completed: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  session_failed: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  session_stopped: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0zM9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
    </svg>
  ),
  comment: (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  ),
};

const EVENT_ICON_COLORS: Record<ActivityEventType, string> = {
  issue_created: "text-brand-500 dark:text-brand-400",
  status_changed: "text-blue-500 dark:text-blue-400",
  workspace_created: "text-indigo-500 dark:text-indigo-400",
  workspace_launched: "text-violet-500 dark:text-violet-400",
  workspace_merged: "text-emerald-500 dark:text-emerald-400",
  workspace_closed: "text-gray-400 dark:text-gray-500",
  session_started: "text-amber-500 dark:text-amber-400",
  session_completed: "text-emerald-500 dark:text-emerald-400",
  session_failed: "text-red-500 dark:text-red-400",
  session_stopped: "text-gray-400 dark:text-gray-500",
  comment: "text-gray-400 dark:text-gray-500",
};

export function IssueActivitySection({ events, loading, issueTitle, issueNumber, currentStatusName }: Props) {
  const canExportMarkdown = Boolean(issueTitle && currentStatusName);

  function handleExportMarkdown() {
    if (!issueTitle || !currentStatusName) return;
    downloadIssueActivityMarkdown(issueTitle, currentStatusName, issueNumber, events);
    showToast("Activity Markdown downloaded", "success");
  }

  return (
    <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
      <div className="flex items-center justify-between gap-2 mb-2">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Activity
        </label>
        {canExportMarkdown && (
          <button
            type="button"
            onClick={handleExportMarkdown}
            disabled={loading}
            className="text-[11px] text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300 disabled:opacity-50"
            title="Download this issue's activity history as Markdown"
          >
            Export activity as Markdown
          </button>
        )}
      </div>
      {loading ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">Loading activity...</p>
      ) : events.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">No activity yet.</p>
      ) : (
        <ul className="space-y-0.5">
          {events.map((event) => (
            <li key={event.id} className="flex items-start gap-2 py-1">
              <span className={`shrink-0 mt-0.5 ${EVENT_ICON_COLORS[event.type]}`}>
                {EVENT_ICONS[event.type]}
              </span>
              <span className="flex-1 min-w-0 text-xs text-gray-700 dark:text-gray-300 leading-snug break-words">
                {event.summary}
                {event.actor && (
                  <span className="ml-1 text-gray-400 dark:text-gray-500 capitalize">
                    by {event.actor}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">
                {formatRelativeTime(event.timestamp)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
