import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";

interface RelatedIssue {
  id: string;
  issueNumber: number | null;
  title: string;
  sharedFileCount: number;
}

interface IssueRelatedIssuesSectionProps {
  issueId: string;
  onNavigateToIssue?: (issueId: string) => void;
}

/**
 * Related-issues section. Self-contained (extracted from IssueDetailPanel): owns
 * its own best-effort fetch — moving it out of the panel's loadData mega-effect —
 * loading state, and collapse toggle.
 */
export function IssueRelatedIssuesSection({ issueId, onNavigateToIssue }: IssueRelatedIssuesSectionProps) {
  const [related, setRelated] = useState<RelatedIssue[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    setRelated(null);
    setLoading(true);
    apiFetch<{ related: RelatedIssue[] }>(`/api/issues/${issueId}/related-issues`)
      .then((ri) => setRelated(ri.related))
      .catch(() => setRelated([]))
      .finally(() => setLoading(false));
  }, [issueId]);

  return (
    <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
            Related Issues
          </label>
          {!loading && related && related.length > 0 && (
            <span className="inline-flex items-center text-xs font-medium px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
              {related.length}
            </span>
          )}
        </div>
        {(related && related.length > 0) && (
          <button
            onClick={() => setShow((v) => !v)}
            className="text-xs text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
          >
            {show ? "Hide" : "Show"}
          </button>
        )}
      </div>
      {loading && (
        <p className="text-xs text-gray-400 dark:text-gray-500">Loading…</p>
      )}
      {!loading && related && related.length === 0 && (
        <p className="text-xs text-gray-400 dark:text-gray-500">No related issues found.</p>
      )}
      {!loading && related && related.length > 0 && show && (
        <ul className="space-y-1">
          {related.map((ri) => (
            <li key={ri.id} className="flex items-center justify-between gap-2 text-xs">
              <button
                onClick={() => onNavigateToIssue?.(ri.id)}
                className="text-left text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300 hover:underline truncate"
                title={ri.title}
              >
                {ri.issueNumber != null ? `#${ri.issueNumber} ` : ""}{ri.title}
              </button>
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 whitespace-nowrap">
                {ri.sharedFileCount} shared {ri.sharedFileCount === 1 ? "file" : "files"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
