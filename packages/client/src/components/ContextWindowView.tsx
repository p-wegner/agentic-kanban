import { formatTokenCount } from "../lib/workspace-helpers.js";
import {
  occupancyFromStatsJson,
  occupancyFromLive,
  occupancyColor,
  type ContextOccupancy,
} from "../lib/context-window.js";

/** Minimal session shape this view needs — a subset of WorkspacePanel's SessionInfo. */
export interface ContextSessionInfo {
  id: string;
  startedAt: string;
  stats: string | null;
  triggerType: string | null;
  skillName: string | null;
}

interface LiveStatsLike {
  model: string;
  contextTokens: number;
}

function OccupancyBar({ occ }: { occ: ContextOccupancy }) {
  const pct = Math.round(occ.fraction * 100);
  const { bar, text } = occupancyColor(occ.fraction);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className={`font-semibold ${text}`}>{pct}% of context window</span>
        <span className="font-mono text-gray-500 dark:text-gray-400">
          {formatTokenCount(occ.contextTokens)} / {formatTokenCount(occ.contextWindow)}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${bar}`}
          style={{ width: `${Math.max(occ.fraction * 100, occ.contextTokens > 0 ? 1.5 : 0)}%` }}
        />
      </div>
      {occ.model && (
        <div className="text-[10px] font-mono text-gray-400 dark:text-gray-500 truncate">{occ.model}</div>
      )}
    </div>
  );
}

/**
 * "/context"-like view for a workspace: how much of the model's context window
 * the agent is (or was) occupying. Shows live occupancy while a session is
 * active, falls back to the latest completed session's recorded usage, and
 * lists per-session historical occupancy below.
 */
export function ContextWindowView({
  sessions,
  liveStats,
}: {
  sessions: ContextSessionInfo[];
  liveStats?: LiveStatsLike | null;
}) {
  // Newest session first for the headline + the list.
  const ordered = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const live =
    liveStats && liveStats.contextTokens > 0
      ? occupancyFromLive(liveStats.contextTokens, liveStats.model)
      : null;

  // Each completed session that recorded context usage, newest first.
  const historical = ordered
    .map((s) => ({ session: s, occ: occupancyFromStatsJson(s.stats) }))
    .filter((row): row is { session: ContextSessionInfo; occ: ContextOccupancy } => row.occ !== null);

  const headline = live ?? historical[0]?.occ ?? null;

  if (!headline) {
    return (
      <div className="text-[11px] text-gray-400 dark:text-gray-500 italic">
        No context-window usage recorded yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
          Context Window
        </span>
        {live ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-green-600 dark:text-green-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            live
          </span>
        ) : (
          <span className="text-[10px] text-gray-400 dark:text-gray-500">latest session</span>
        )}
      </div>

      <OccupancyBar occ={headline} />

      {historical.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-[10px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 select-none">
            Per-session history ({historical.length})
          </summary>
          <div className="mt-1 space-y-1 max-h-40 overflow-y-auto pr-1">
            {historical.map(({ session, occ }) => {
              const label =
                session.skillName ??
                (session.triggerType && session.triggerType !== "agent" && session.triggerType !== "chat"
                  ? session.triggerType
                  : "Agent");
              const { text } = occupancyColor(occ.fraction);
              return (
                <div key={session.id} className="flex items-center gap-2 text-[10px]">
                  <span className="w-20 shrink-0 truncate text-gray-500 dark:text-gray-400">{label}</span>
                  <div className="h-1.5 flex-1 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${occupancyColor(occ.fraction).bar}`}
                      style={{ width: `${Math.max(occ.fraction * 100, 1.5)}%` }}
                    />
                  </div>
                  <span className={`w-10 shrink-0 text-right font-mono ${text}`}>
                    {Math.round(occ.fraction * 100)}%
                  </span>
                  <span className="w-12 shrink-0 text-right font-mono text-gray-400 dark:text-gray-500">
                    {formatTokenCount(occ.contextTokens)}
                  </span>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}
