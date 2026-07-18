import { useEffect, useState } from "react";
import { getSettings } from "../lib/settingsStore.js";
import { getNumber } from "@agentic-kanban/shared/lib/settings-registry";
import {
  detectAgentStall,
  DEFAULT_STALL_THRESHOLD_SEC,
  type AgentStallSignal,
} from "../lib/detectAgentStall.js";
import { useAgentActivityStore } from "../stores/agentActivityStore.js";

/** How often the badge re-evaluates so idle time can cross the threshold live. */
const STALL_TICK_MS = 5_000;

/** Compact idle label: "3m" once past a minute, otherwise "45s". */
function formatIdle(idleSec: number): string {
  return idleSec >= 60 ? `${Math.floor(idleSec / 60)}m` : `${idleSec}s`;
}

/**
 * Reads `agent_stall_threshold_sec` from the shared settings cache once. Returns the
 * sane default (240) until the fetch resolves; getSettings() is deduped/cached so many
 * mounted badges share a single network read.
 */
export function useAgentStallThreshold(): number {
  const [threshold, setThreshold] = useState(DEFAULT_STALL_THRESHOLD_SEC);
  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((s) => {
        if (!cancelled) setThreshold(getNumber(s, "agent_stall_threshold_sec", DEFAULT_STALL_THRESHOLD_SEC));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return threshold;
}

/**
 * Derives the live stall/loop signal for one issue's agent. Ticks on a timer while the
 * agent is live so a growing idle gap crosses the threshold without a new event.
 *
 * `sessionStartMs` seeds the idle baseline before any activity event has arrived, so a
 * launched-but-silent agent (the "~1s, 0 tokens = launch-failed/stale" case) still
 * trips the stalled badge; live deltas from the store override it once they stream in.
 * Pass null to disable the seed (e.g. cross-project rows whose live stream this tab
 * isn't subscribed to — avoids false positives on healthy remote agents).
 */
export function useAgentStallSignal(
  issueId: string,
  status: string | null | undefined,
  sessionStartMs: number | null | undefined,
  thresholdSec: number,
): AgentStallSignal {
  const meta = useAgentActivityStore((s) => s.byIssue[issueId]);
  const isLive = status === "active" || status === "fixing";
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => setTick((n) => n + 1), STALL_TICK_MS);
    return () => clearInterval(t);
  }, [isLive]);

  const lastActivityAt = meta?.lastActivityAt ?? sessionStartMs ?? null;
  return detectAgentStall({
    status,
    lastActivityAt,
    recentTools: meta?.recentTools,
    thresholdSec,
  });
}

/** Renders the stalled/looping pill (or nothing for an "ok" signal). */
export function AgentStallBadge({ signal, className }: { signal: AgentStallSignal; className?: string }) {
  if (signal.state === "stalled") {
    return (
      <span
        title={`No agent activity for ${formatIdle(signal.idleSec)} — possibly stalled`}
        className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 ${className ?? ""}`}
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4l2 2" />
        </svg>
        stalled {formatIdle(signal.idleSec)}
      </span>
    );
  }
  if (signal.state === "looping") {
    return (
      <span
        title={`Repeated ${signal.repeatedTool} ×${signal.repeatCount} — possible loop`}
        className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 ${className ?? ""}`}
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M17 2l4 4-4 4" />
          <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
          <path d="M7 22l-4-4 4-4" />
          <path d="M21 13v1a4 4 0 0 1-4 4H3" />
        </svg>
        looping ×{signal.repeatCount}
      </span>
    );
  }
  return null;
}

/**
 * Convenience wrapper: derive + render a stall badge for one issue's agent. `thresholdSec`
 * is supplied by the parent (which reads it once via useAgentStallThreshold) so a list of
 * rows doesn't each re-read the setting.
 */
export function AgentStallIndicator({
  issueId,
  status,
  sessionStartMs,
  thresholdSec,
  className,
}: {
  issueId: string;
  status: string | null | undefined;
  sessionStartMs: number | null | undefined;
  thresholdSec: number;
  className?: string;
}) {
  const signal = useAgentStallSignal(issueId, status, sessionStartMs, thresholdSec);
  return <AgentStallBadge signal={signal} className={className} />;
}
