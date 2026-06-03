import React from "react";
import type { TrailEntry } from "../hooks/useTicketTrail.js";

// The breadcrumb-style strip that surfaces the multi-ticket navigation trail
// (#383) at the top of the issue detail panel. It gives the single-panel UI a
// browser-like memory of every ticket you've opened: back/forward arrows plus a
// row of recency chips you can jump to or dismiss.

interface TicketTrailStripProps {
  entries: TrailEntry[];
  activeId: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}

function entryLabel(entry: TrailEntry): string {
  return entry.number != null ? `#${entry.number}` : entry.title.slice(0, 12) || "untitled";
}

export function TicketTrailStrip({
  entries,
  activeId,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onSelect,
  onRemove,
}: TicketTrailStripProps) {
  // A single open ticket and no history is the old behavior — no point showing
  // a one-chip trail. Surface the strip only once there's something to navigate.
  if (entries.length <= 1) return null;

  return (
    <div
      data-ticket-trail
      className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-200 dark:border-gray-700 bg-gray-50/80 dark:bg-gray-900/40 overflow-x-auto scrollbar-thin"
      // Don't let the header's drag-to-move handler hijack chip clicks.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        onClick={onBack}
        disabled={!canGoBack}
        title="Back (Alt+←)"
        aria-label="Back to previous ticket"
        className="shrink-0 p-0.5 rounded text-gray-400 dark:text-gray-500 enabled:hover:text-gray-700 enabled:hover:bg-gray-200 dark:enabled:hover:text-gray-200 dark:enabled:hover:bg-gray-700 disabled:opacity-30 transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <button
        onClick={onForward}
        disabled={!canGoForward}
        title="Forward (Alt+→)"
        aria-label="Forward to next ticket"
        className="shrink-0 p-0.5 rounded text-gray-400 dark:text-gray-500 enabled:hover:text-gray-700 enabled:hover:bg-gray-200 dark:enabled:hover:text-gray-200 dark:enabled:hover:bg-gray-700 disabled:opacity-30 transition-colors"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      <div className="w-px self-stretch my-0.5 bg-gray-200 dark:bg-gray-700 shrink-0" />
      <div className="flex items-center gap-1">
        {entries.map((entry) => {
          const active = entry.id === activeId;
          return (
            <span
              key={entry.id}
              className={`group shrink-0 inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                active
                  ? "bg-brand-100 text-brand-700 border-brand-300 dark:bg-brand-900/50 dark:text-brand-200 dark:border-brand-700"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-300 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700 dark:hover:bg-gray-700"
              }`}
            >
              <button
                onClick={() => onSelect(entry.id)}
                title={entry.title}
                aria-current={active ? "true" : undefined}
                className="font-mono max-w-[10rem] truncate"
              >
                {entryLabel(entry)}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(entry.id);
                }}
                title="Remove from trail"
                aria-label={`Remove ${entryLabel(entry)} from trail`}
                className="rounded-full p-0.5 text-gray-300 dark:text-gray-600 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-100 dark:hover:bg-red-900/40 transition-all"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
