import { useEffect, useRef } from "react";
import type { NotificationEvent, NotificationEventType } from "../hooks/useActivityNotifications.js";

function formatRelativeTime(isoTimestamp: string): string {
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(-days, "day");
}

function eventLabel(type: NotificationEventType): string {
  switch (type) {
    case "workspace_merged": return "Merged";
    case "session_completed": return "Completed";
    case "session_failed": return "Session failed";
    case "workflow_error": return "Workflow error";
    case "approval_requested": return "Agent needs input";
  }
}

function EventIcon({ type }: { type: NotificationEventType }) {
  switch (type) {
    case "workspace_merged":
      return (
        <svg className="h-4 w-4 text-green-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case "session_completed":
      return (
        <svg className="h-4 w-4 text-blue-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      );
    case "session_failed":
    case "workflow_error":
      return (
        <svg className="h-4 w-4 text-red-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      );
    case "approval_requested":
      return (
        <svg className="h-4 w-4 text-amber-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
  }
}

interface NotificationBellProps {
  events: NotificationEvent[];
  unreadCount: number;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onMarkRead: () => void;
  onEventClick: (event: NotificationEvent) => void;
}

export function NotificationBell({
  events,
  unreadCount,
  isOpen,
  onOpen,
  onClose,
  onMarkRead,
  onEventClick,
}: NotificationBellProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [isOpen, onClose]);

  function handleBellClick() {
    if (isOpen) {
      onClose();
    } else {
      onOpen();
      onMarkRead();
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={handleBellClick}
        className="relative p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-semibold leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-3 py-2">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Activity</span>
            {events.length > 0 && (
              <button
                onClick={onMarkRead}
                className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {events.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                No recent activity
              </p>
            ) : (
              <ul>
                {events.map((event) => (
                  <li key={event.id}>
                    <button
                      onClick={() => { onEventClick(event); onClose(); }}
                      className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      <EventIcon type={event.type} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">
                          {eventLabel(event.type)}
                          {event.issueNumber != null && (
                            <span className="ml-1 text-gray-500 dark:text-gray-400">#{event.issueNumber}</span>
                          )}
                        </p>
                        {event.issueTitle && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{event.issueTitle}</p>
                        )}
                        <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
                          {formatRelativeTime(event.timestamp)}
                        </p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
