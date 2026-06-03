import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";

interface StatusDuration {
  statusName: string;
  durationMs: number;
}

interface CycleTimeData {
  totalAgeMs: number;
  createdAt: string;
  closedAt: string | null;
  isOpen: boolean;
  statusBreakdowns: StatusDuration[];
}

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

interface IssueCycleTimeBadgeProps {
  issueId: string;
}

export function IssueCycleTimeBadge({ issueId }: IssueCycleTimeBadgeProps) {
  const [data, setData] = useState<CycleTimeData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setData(null);
    apiFetch<CycleTimeData>(`/api/issues/${issueId}/cycle-time`)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [issueId]);

  if (loading) {
    return (
      <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
        <p className="text-xs text-gray-400 dark:text-gray-500">Loading cycle time...</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
      <div className="flex items-center gap-2 mb-2">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Cycle Time
        </label>
        <span
          title={data.isOpen ? "Issue is still open" : "Issue closed"}
          className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded ${
            data.isOpen
              ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
              : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
          }`}
        >
          {formatDurationMs(data.totalAgeMs)}
          {data.isOpen && (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 dark:bg-blue-300 animate-pulse" />
          )}
        </span>
      </div>

      {data.statusBreakdowns.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {data.statusBreakdowns.map((s) => (
            <span
              key={s.statusName}
              title={`${s.statusName}: ${formatDurationMs(s.durationMs)}`}
              className="inline-block text-[11px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300"
            >
              {s.statusName} {formatDurationMs(s.durationMs)}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400 dark:text-gray-500">No workflow transitions recorded.</p>
      )}
    </div>
  );
}
