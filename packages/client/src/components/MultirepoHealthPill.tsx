import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import type { RepoMergeStatusResponse, ServiceStackState } from "@agentic-kanban/shared";
import {
  summarizeMultirepoHealth,
  type MultirepoHealthSummary,
} from "../lib/summarizeMultirepoHealth.js";

const SEVERITY_CLASS: Record<MultirepoHealthSummary["severity"], string> = {
  attention: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
  healthy: "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300",
  neutral: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

/** Pure presentational pill — renders nothing when there is no summary. */
export function MultirepoHealthPillView({ summary }: { summary: MultirepoHealthSummary | null }) {
  if (!summary) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 max-w-full truncate ${SEVERITY_CLASS[summary.severity]}`}
      data-testid="multirepo-health-pill"
      title={`Multi-repo health: ${summary.text}`}
    >
      <span aria-hidden="true">⧉</span>
      {summary.text}
    </span>
  );
}

/**
 * Glanceable multirepo-health pill for a workspace card / row (#83).
 *
 * Lazy by design: the repo-merge-status endpoint is only hit once the pill is
 * expanded (click the collapsed teaser), so the board doesn't fire N calls on
 * render. The collapsed teaser only appears when board-loaded data already hints
 * the workspace is multi-repo — a sibling-namespaced conflict (`repoName::file`,
 * since #76) — or when a service stack was already loaded (workspace detail).
 * `serviceState` is reused as-is when the caller has it; otherwise the stack part
 * is simply omitted (no extra fetch).
 */
export function MultirepoHealthPill({
  workspaceId,
  serviceState,
  hasConflicts,
  conflictingFiles,
  refreshKey,
}: {
  workspaceId: string;
  serviceState?: ServiceStackState | null;
  hasConflicts?: boolean;
  conflictingFiles?: readonly string[];
  refreshKey?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<RepoMergeStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // Re-fetch when the workspace or an external refresh key (e.g. post-merge) changes.
  useEffect(() => {
    setStatus(null);
  }, [workspaceId, refreshKey]);

  useEffect(() => {
    if (!expanded || status) return;
    let cancelled = false;
    setLoading(true);
    apiFetch<RepoMergeStatusResponse>(`/api/workspaces/${workspaceId}/repo-merge-status`)
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setStatus(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, status, workspaceId, refreshKey]);

  const summary = summarizeMultirepoHealth({ repoMergeStatus: status, serviceState, hasConflicts });

  // Multi-repo hint available from data already loaded on the board (no fetch):
  // a sibling-namespaced conflict path, or an already-known service stack.
  const siblingHint = !!conflictingFiles?.some((f) => f.includes("::"));
  const hasHint = siblingHint || !!serviceState;

  // Once fetched and confirmed single-repo, render nothing.
  if (expanded && status && !summary) return null;

  if (expanded && summary) {
    return <MultirepoHealthPillView summary={summary} />;
  }

  // Collapsed teaser — only when board-loaded data hints multi-repo.
  if (!hasHint) return null;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
        siblingHint ? SEVERITY_CLASS.attention : SEVERITY_CLASS.neutral
      }`}
      data-testid="multirepo-health-teaser"
      title="Show multi-repo health"
    >
      <span aria-hidden="true">⧉</span>
      {loading ? "repos…" : "repos"}
    </button>
  );
}
