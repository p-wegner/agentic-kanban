import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api.js";
import type { NextStartCandidate } from "../../lib/monitor-popover.js";

/**
 * #917 — the Todo-pull loop's current ranking, read-only, backed by
 * `GET /api/projects/:id/board-monitor/next`. Makes the score that decides launch order
 * visible: priority weight, unblock count, age factor, predicted cost, Bullseye multiplier.
 *
 * Own module for the same reason as `ProfileQuotaSection`: it OWNS ITS DATA SOURCE (it
 * fetches from its own endpoint) rather than rendering a slice of the `MonitorStatus`
 * payload the rest of `MonitorSections.tsx` is passed.
 */
export function NextStartCandidatesSection({ projectId }: { projectId: string | null }) {
  const [candidates, setCandidates] = useState<NextStartCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) { setCandidates(null); setError(null); return; }
    let cancelled = false;
    apiFetch<{ projectId: string; candidates: NextStartCandidate[] }>(`/api/projects/${projectId}/board-monitor/next?limit=5`)
      .then((data) => { if (!cancelled) { setCandidates(data.candidates); setError(null); } })
      .catch((err) => { if (!cancelled) { setCandidates(null); setError(err instanceof Error ? err.message : "Failed to load ranking"); } });
    return () => { cancelled = true; };
  }, [projectId]);

  if (!projectId) return null;
  if (error) return null;
  if (candidates === null) return null;
  if (candidates.length === 0) return null;

  return (
    <div className="px-3 py-2.5 border-b border-gray-100 dark:border-gray-800">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">Next to start</div>
      <div className="space-y-1">
        {candidates.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-2 rounded-md bg-gray-50 dark:bg-gray-800 px-2 py-1">
            <div className="min-w-0 flex-1">
              <div className="truncate text-gray-700 dark:text-gray-300">
                {c.issueNumber != null ? `#${c.issueNumber} ` : ""}{c.title}
              </div>
              <div
                className="text-[10px] text-gray-400 dark:text-gray-500"
                title={`priority=${c.score.priority} (x${c.score.priorityWeight}) · unblocks=${c.score.unblockCount} · age=${c.score.ageHours.toFixed(1)}h (x${c.score.ageFactor.toFixed(2)}) · cost=${c.score.predictedCost} · bullseye=x${c.score.bullseyeMultiplier}`}
              >
                {c.score.priority} · unblocks {c.score.unblockCount}
              </div>
            </div>
            <span className="shrink-0 font-mono font-semibold text-gray-600 dark:text-gray-400 text-[11px]">
              {c.score.score.toFixed(1)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
