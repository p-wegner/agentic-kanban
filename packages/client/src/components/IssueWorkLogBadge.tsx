import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatMinutes } from "./IssueWorkLogSection.js";

interface IssueWorkLogBadgeProps {
  issueId: string;
}

export function IssueWorkLogBadge({ issueId }: IssueWorkLogBadgeProps) {
  const [totalMinutes, setTotalMinutes] = useState<number | null>(null);

  useEffect(() => {
    setTotalMinutes(null);
    apiFetch<{ entries: unknown[]; totalMinutes: number }>(`/api/issues/${issueId}/time-entries`)
      .then((data) => setTotalMinutes(data.totalMinutes))
      .catch(() => {});
  }, [issueId]);

  if (!totalMinutes) return null;

  return (
    <span
      className="inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300"
      title={`Time logged: ${formatMinutes(totalMinutes)}`}
    >
      <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {formatMinutes(totalMinutes)}
    </span>
  );
}
