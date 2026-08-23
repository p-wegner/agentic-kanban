import { useEffect, useState } from "react";
import { getIssueTimeEntries } from "../lib/timeEntriesCache.js";
import { formatMinutes } from "./IssueWorkLogSection.js";
import { Icon } from "./Icon.js";

interface IssueWorkLogBadgeProps {
  issueId: string;
}

export function IssueWorkLogBadge({ issueId }: IssueWorkLogBadgeProps) {
  const [totalMinutes, setTotalMinutes] = useState<number | null>(null);

  useEffect(() => {
    setTotalMinutes(null);
    // Shared module-level cache: dedupes the StrictMode double-mount and the
    // per-card N+1 fetch storm on board load (see lib/timeEntriesCache.ts).
    getIssueTimeEntries(issueId)
      .then((data) => setTotalMinutes(data.totalMinutes))
      .catch(() => {});
  }, [issueId]);

  if (!totalMinutes) return null;

  return (
    <span
      className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300"
      title={`Time logged: ${formatMinutes(totalMinutes)}`}
    >
      <Icon className="w-3 h-3 shrink-0" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      {formatMinutes(totalMinutes)}
    </span>
  );
}
