import React, { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import type { WorkspaceTimelineResponse, WorkspaceTimelineEvent } from "@agentic-kanban/shared";

interface WorkspaceTimelinePanelProps {
  workspaceId: string;
}

const EVENT_ICONS: Record<string, string> = {
  workspace_created: "🆕",
  setup_started: "⚙️",
  setup_completed: "✅",
  setup_failed: "❌",
  session_launched: "🚀",
  session_stopped: "🛑",
  session_zero_output: "⚠️",
  session_completed: "✓",
  nudge: "👋",
  review_started: "🔍",
  merge_started: "🔀",
  fix_and_merge_started: "🔧",
  workspace_merged: "✅",
  workspace_closed: "🚪",
  ready_for_merge: "✔️",
};

const SEVERITY_CLASSES: Record<string, string> = {
  info: "border-l-gray-300 dark:border-l-gray-600",
  warning: "border-l-yellow-400 dark:border-l-yellow-500",
  error: "border-l-red-400 dark:border-l-red-500",
  success: "border-l-green-400 dark:border-l-green-500",
};

const SEVERITY_BADGE_CLASSES: Record<string, string> = {
  info: "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400",
  warning: "bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300",
  error: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300",
  success: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300",
};

const TRIGGER_LABELS: Record<string, string> = {
  agent: "Agent",
  chat: "Chat",
  review: "AI Review",
  merge: "AI Merge",
  "fix-conflicts": "Fix Conflicts",
  bisect: "Auto-bisect",
  learning: "Learning",
  "auto-start": "Auto-start",
};

function TriggerBadge({ triggerType }: { triggerType: string | null | undefined }) {
  if (!triggerType) return null;
  const label = TRIGGER_LABELS[triggerType] ?? triggerType;
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-50 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300 font-medium">
      {label}
    </span>
  );
}

function TokenBadge({ tokenCounts }: { tokenCounts: { inputTokens: number; outputTokens: number } | null | undefined }) {
  if (!tokenCounts) return null;
  if (tokenCounts.inputTokens === 0 && tokenCounts.outputTokens === 0) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 font-medium" title="Zero tokens — provider activity failed">
        0 tokens
      </span>
    );
  }
  return (
    <span className="text-[10px] text-gray-400 dark:text-gray-500" title="Input / output tokens">
      {tokenCounts.inputTokens.toLocaleString("en-US")} in / {tokenCounts.outputTokens.toLocaleString("en-US")} out
    </span>
  );
}

function TimelineEventRow({ event }: { event: WorkspaceTimelineEvent }) {
  const [expanded, setExpanded] = useState(false);
  const icon = EVENT_ICONS[event.type] ?? "•";
  const borderClass = SEVERITY_CLASSES[event.severity ?? "info"] ?? SEVERITY_CLASSES.info;
  const badgeClass = SEVERITY_BADGE_CLASSES[event.severity ?? "info"] ?? SEVERITY_BADGE_CLASSES.info;
  const hasDetail = !!event.detail;

  return (
    <div
      className={`border-l-2 pl-3 py-2 ${borderClass} ${hasDetail ? "cursor-pointer" : ""}`}
      onClick={hasDetail ? () => setExpanded(e => !e) : undefined}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm select-none">{icon}</span>
        <span className="text-xs font-medium text-gray-700 dark:text-gray-200 flex-1">{event.label}</span>
        <span className={`text-[10px] px-1 py-0.5 rounded ${badgeClass}`}>
          {event.severity ?? "info"}
        </span>
        {event.triggerType && <TriggerBadge triggerType={event.triggerType} />}
        {event.tokenCounts && <TokenBadge tokenCounts={event.tokenCounts} />}
        {event.exitCode && event.exitCode !== "0" && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400">
            exit {event.exitCode}
          </span>
        )}
        <span className="text-[10px] text-gray-400 dark:text-gray-500 whitespace-nowrap">
          {formatRelativeTime(event.timestamp)}
        </span>
        {hasDetail && (
          <span className="text-[10px] text-gray-400 dark:text-gray-500">{expanded ? "▲" : "▼"}</span>
        )}
      </div>
      {expanded && event.detail && (
        <div className="mt-2 text-xs text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 rounded p-2 font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
          {event.detail}
        </div>
      )}
    </div>
  );
}

export function WorkspaceTimelinePanel({ workspaceId }: WorkspaceTimelinePanelProps) {
  const [timeline, setTimeline] = useState<WorkspaceTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<WorkspaceTimelineResponse>(`/api/workspaces/${workspaceId}/timeline`)
      .then(data => { if (!cancelled) setTimeline(data); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load timeline"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  if (loading) {
    return (
      <div className="p-4 text-xs text-gray-400 dark:text-gray-500 animate-pulse">Loading timeline...</div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-xs text-red-500 dark:text-red-400">{error}</div>
    );
  }

  if (!timeline || timeline.events.length === 0) {
    return (
      <div className="p-4 text-xs text-gray-400 dark:text-gray-500">No timeline events yet.</div>
    );
  }

  // Display most recent first
  const sortedEvents = [...timeline.events].reverse();

  return (
    <div className="p-3 space-y-1 max-h-96 overflow-y-auto">
      <div className="text-[10px] text-gray-400 dark:text-gray-500 mb-2 text-right">
        {timeline.events.length} events · updated {formatRelativeTime(timeline.generatedAt)}
      </div>
      {sortedEvents.map(event => (
        <TimelineEventRow key={event.id} event={event} />
      ))}
    </div>
  );
}
