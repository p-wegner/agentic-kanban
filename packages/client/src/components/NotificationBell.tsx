import { useEffect, useRef } from "react";
import type { NotificationEvent, NotificationEventType } from "../hooks/useActivityNotifications.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { INBOX_KIND_MARK, openInboxItem, refreshInbox, useInbox, type InboxItem } from "../hooks/useInbox.js";

function eventLabel(type: NotificationEventType): string {
  switch (type) {
    case "workspace_merged": return "Merged";
    case "workspace_ready_for_merge": return "Ready for review";
    case "session_completed": return "Completed";
    case "session_failed": return "Session failed";
    case "session_launched": return "Agent launched";
    case "workflow_error": return "Workflow error";
    case "workflow_transition": return "Issue moved";
    case "approval_requested": return "Agent needs input";
    case "plugin_gate": return "Approval gate";
    case "project_completed": return "Project complete 🎉";
  }
}

/**
 * The durable half of the dropdown (#302): pending DECISIONS read fresh from the
 * server whenever the bell opens — unlike the activity feed below it, these are
 * state, not events, so they survive reloads and disappear only when resolved.
 * Items are fetched by the bell itself (#328) so the badge can count them even
 * while the dropdown is closed; this section only renders them.
 */
function InboxSection({ items, onNavigate }: { items: InboxItem[] | null; onNavigate: () => void }) {
  function open(item: InboxItem) {
    openInboxItem(item);
    onNavigate();
  }

  if (items === null) {
    return <p className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">Checking what waits on you…</p>;
  }
  if (items.length === 0) return null;
  return (
    <div className="border-b border-gray-200 dark:border-gray-700" data-testid="inbox-section">
      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
        Waiting on you — all projects
      </div>
      <ul>
        {items.slice(0, 8).map((item, i) => (
          <li key={`${item.kind}-${i}`}>
            <button
              onClick={() => open(item)}
              className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors"
            >
              <span className="shrink-0 text-sm" aria-hidden="true">{INBOX_KIND_MARK[item.kind]}</span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-gray-900 dark:text-gray-100 truncate">{item.title}</p>
                <p className="text-[10px] text-gray-500 dark:text-gray-400 truncate">
                  {item.projectName}{item.detail ? ` · ${item.detail}` : ""}
                </p>
              </div>
              {/* How long this has been blocked on a human — the gate card shows it, but the
                  bell is where a decision is DISCOVERED, and a day-old wait reads very
                  differently from a minute-old one (2026-08-11 UX round). */}
              {item.createdAt && (
                <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400 whitespace-nowrap" title={`Waiting since ${new Date(item.createdAt).toLocaleString("en-US")}`}>
                  {formatRelativeTime(item.createdAt).replace(" ago", "")}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EventIcon({ type }: { type: NotificationEventType }) {
  switch (type) {
    case "workspace_merged":
      return (
        <svg className="h-4 w-4 text-green-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case "workspace_ready_for_merge":
      return (
        <svg className="h-4 w-4 text-violet-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m-8-9H3m18 0h-1m-2.636-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m11.314 11.314l.707.707" />
        </svg>
      );
    case "session_completed":
      return (
        <svg className="h-4 w-4 text-blue-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      );
    case "session_launched":
      return (
        <svg className="h-4 w-4 text-sky-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
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
    case "workflow_transition":
      return (
        <svg className="h-4 w-4 text-indigo-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
      );
    case "approval_requested":
      return (
        <svg className="h-4 w-4 text-amber-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case "plugin_gate":
      return <span className="text-sm shrink-0" aria-hidden="true">✋</span>;
    case "project_completed":
      return (
        <svg className="h-4 w-4 text-emerald-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L23 12l-6.714 2.143L14 21l-2.286-6.857L5 12l6.714-2.143L14 3z" />
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

  // #328: pending decisions (cross-project inbox) are STATE, not events — they
  // must light the badge on a fresh page load, independent of the activity
  // feed's lastReadAt bookkeeping. The list itself lives in the shared `useInbox`
  // cache (#411) so the header chip and switcher badges read the SAME poll.
  const { items: inboxItems, count: inboxCount } = useInbox();
  // Refresh once when the dropdown OPENS (a resolved gate should vanish without
  // waiting for the slow poll); closing fetches nothing.
  useEffect(() => {
    if (isOpen) void refreshInbox();
  }, [isOpen]);
  const badgeCount = unreadCount + inboxCount;

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
        aria-label={
          `Notifications${badgeCount > 0 ? ` (${badgeCount} unread)` : ""}` +
          (inboxCount > 0 ? ` — ${inboxCount} waiting on you` : "")
        }
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {badgeCount > 0 && (
          /* Amber when something is BLOCKED ON A HUMAN, red for mere activity (#411):
             a decision-blocked pipeline is a different urgency class from an event feed,
             and one red "1" for both is why a gate sat unnoticed for 1d 3h. */
          <span
            className={`absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full text-white text-[10px] font-semibold leading-none ${
              inboxCount > 0 ? "bg-amber-500" : "bg-red-500"
            }`}
            data-testid="notification-badge"
            data-waiting={inboxCount > 0 ? "true" : "false"}
          >
            {badgeCount > 9 ? "9+" : badgeCount}
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
            <InboxSection items={inboxItems} onNavigate={onClose} />
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
