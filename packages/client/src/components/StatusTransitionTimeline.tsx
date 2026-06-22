import React from "react";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import type { ActivityEvent } from "./IssueActivitySection.js";

interface Props {
  events: ActivityEvent[];
  loading: boolean;
  currentStatusName?: string | null;
}

interface TransitionEntry {
  id: string;
  toStatus: string;
  timestamp: string;
  isInitial: boolean;
}

function buildTransitions(events: ActivityEvent[], _currentStatusName?: string | null): TransitionEntry[] {
  // Sort oldest-first to build the chronological chain
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const transitions: TransitionEntry[] = [];

  for (const event of sorted) {
    if (event.type === "issue_created") {
      transitions.push({
        id: event.id,
        toStatus: "Backlog",
        timestamp: event.timestamp,
        isInitial: true,
      });
    } else if (event.type === "status_changed") {
      // summary is "Moved to {statusName}" — extract the status name
      const match = event.summary.match(/^Moved to (.+)$/);
      const toStatus = match ? match[1] : event.summary;
      transitions.push({
        id: event.id,
        toStatus,
        timestamp: event.timestamp,
        isInitial: false,
      });
    }
  }

  return transitions;
}

export function StatusTransitionTimeline({ events, loading, currentStatusName }: Props) {
  if (loading) {
    return (
      <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-2">
          Status History
        </label>
        <p className="text-xs text-gray-400 dark:text-gray-500">Loading...</p>
      </div>
    );
  }

  const transitions = buildTransitions(events, currentStatusName);
  const statusTransitions = transitions.filter((t) => !t.isInitial);

  return (
    <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
      <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-2">
        Status History
      </label>
      {statusTransitions.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">No status changes yet.</p>
      ) : (
        <ol className="relative border-l border-gray-200 dark:border-gray-700 ml-2 space-y-0">
          {transitions.map((entry, idx) => {
            const fromStatus = idx === 0 ? null : transitions[idx - 1].toStatus;
            if (entry.isInitial && transitions.length === 1) return null;
            if (entry.isInitial) {
              return null;
            }
            return (
              <li key={entry.id} className="ml-4 pb-3 last:pb-0">
                <span className="absolute -left-[5px] w-2.5 h-2.5 rounded-full border-2 border-white dark:border-gray-900 bg-blue-400 dark:bg-blue-500" />
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {fromStatus && (
                      <>
                        <span className="font-medium text-gray-600 dark:text-gray-300">{fromStatus}</span>
                        <span className="mx-1 text-gray-400">&#8594;</span>
                      </>
                    )}
                    <span className="font-medium text-gray-800 dark:text-gray-100">{entry.toStatus}</span>
                  </span>
                  <span className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums ml-auto">
                    {formatRelativeTime(entry.timestamp)}
                  </span>
                </div>
                <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
                  {new Date(entry.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
