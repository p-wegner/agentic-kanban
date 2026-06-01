import { useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import type { IssueWithStatus, MainWorkspaceInfo, StatusWithIssues } from "@agentic-kanban/shared";

interface ConflictPreview {
  workspaceId: string;
  hasConflicts: boolean;
  conflictingFiles: string[];
  isStale: boolean;
  error?: string;
}

export interface MergeQueueItem {
  issue: IssueWithStatus;
  workspace: MainWorkspaceInfo;
  readyForMerge: boolean;
  ageSource: string | null;
  conflictRisk: number;
  riskLabel: "blocked" | "high" | "medium" | "low";
}

interface MergeQueuePanelProps {
  columns: StatusWithIssues[];
  projectId: string;
  onClose: () => void;
  onIssueClick: (issue: IssueWithStatus) => void;
  onMerged?: () => void;
}

function riskLabel(score: number): MergeQueueItem["riskLabel"] {
  if (score >= 1000) return "blocked";
  if (score >= 80) return "high";
  if (score >= 20) return "medium";
  return "low";
}

export function computeMergeConflictRisk(workspace: MainWorkspaceInfo): number {
  const conflicts = workspace.conflicts;
  if (conflicts?.hasConflicts) {
    return 1000 + conflicts.conflictingFiles.length * 100;
  }

  const stats = workspace.diffStats;
  if (!stats) return 0;

  const lineChurn = stats.insertions + stats.deletions;
  return stats.filesChanged * 6 + Math.ceil(lineChurn / 50);
}

export function buildMergeQueueItems(columns: StatusWithIssues[]): MergeQueueItem[] {
  const seen = new Set<string>();
  const inReview = columns.find((column) => column.name === "In Review");
  if (!inReview) return [];

  return inReview.issues
    .flatMap((issue) => {
      const workspace = issue.workspaceSummary?.main;
      if (!workspace || seen.has(workspace.id) || workspace.status === "closed") return [];
      seen.add(workspace.id);

      const conflictRisk = computeMergeConflictRisk(workspace);
      return [{
        issue,
        workspace,
        readyForMerge: workspace.readyForMerge === true,
        ageSource: workspace.lastSessionAt ?? issue.statusChangedAt ?? issue.updatedAt,
        conflictRisk,
        riskLabel: riskLabel(conflictRisk),
      }];
    })
    .sort((a, b) => {
      if (a.readyForMerge !== b.readyForMerge) return a.readyForMerge ? -1 : 1;
      if (a.conflictRisk !== b.conflictRisk) return a.conflictRisk - b.conflictRisk;
      const ageA = a.ageSource ? new Date(a.ageSource).getTime() : Number.POSITIVE_INFINITY;
      const ageB = b.ageSource ? new Date(b.ageSource).getTime() : Number.POSITIVE_INFINITY;
      return ageA - ageB;
    });
}

function formatDiffStats(workspace: MainWorkspaceInfo): string {
  const stats = workspace.diffStats;
  if (!stats || stats.filesChanged === 0) return "No cached diff";
  const files = `${stats.filesChanged} file${stats.filesChanged === 1 ? "" : "s"}`;
  return `${files}, +${stats.insertions} / -${stats.deletions}`;
}

function riskClasses(label: MergeQueueItem["riskLabel"]): string {
  switch (label) {
    case "blocked":
      return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
    case "high":
      return "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300";
    case "medium":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
    case "low":
    default:
      return "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300";
  }
}

export function MergeQueuePanel({ columns, projectId: _projectId, onClose, onIssueClick, onMerged }: MergeQueuePanelProps) {
  const items = useMemo(() => buildMergeQueueItems(columns), [columns]);
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [errorByWorkspace, setErrorByWorkspace] = useState<Record<string, string>>({});
  const [previewByWorkspace, setPreviewByWorkspace] = useState<Record<string, ConflictPreview>>({});
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);

  async function handleMerge(workspaceId: string) {
    const confirmed = window.confirm("Trigger merge for this workspace?");
    if (!confirmed) return;

    setMergingId(workspaceId);
    setErrorByWorkspace((prev) => {
      const next = { ...prev };
      delete next[workspaceId];
      return next;
    });

    try {
      await apiFetch(`/api/workspaces/${workspaceId}/merge`, { method: "POST" });
      onMerged?.();
    } catch (err) {
      setErrorByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: err instanceof Error ? err.message : "Merge failed",
      }));
    } finally {
      setMergingId(null);
    }
  }

  async function handleCheckConflicts(workspaceId: string) {
    setCheckingId(workspaceId);
    try {
      const result = await apiFetch<{ ok: boolean; preview: ConflictPreview }>(
        `/api/merge-queue/preview/${workspaceId}`,
        { method: "POST" },
      );
      setPreviewByWorkspace((prev) => ({ ...prev, [workspaceId]: result.preview }));
    } catch (err) {
      setPreviewByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: {
          workspaceId,
          hasConflicts: false,
          conflictingFiles: [],
          isStale: false,
          error: err instanceof Error ? err.message : "Check failed",
        },
      }));
    } finally {
      setCheckingId(null);
    }
  }

  async function handleCheckAll() {
    const workspaceIds = items.map((item) => item.workspace.id);
    if (workspaceIds.length === 0) return;
    setCheckingAll(true);
    try {
      const result = await apiFetch<{ ok: boolean; dryRun: boolean; plan: { conflictPreviews: ConflictPreview[] } }>(
        "/api/merge-queue",
        {
          method: "POST",
          body: JSON.stringify({ workspaceIds, dryRun: true }),
          headers: { "Content-Type": "application/json" },
        },
      );
      const map: Record<string, ConflictPreview> = {};
      for (const preview of result.plan.conflictPreviews) {
        map[preview.workspaceId] = preview;
      }
      setPreviewByWorkspace((prev) => ({ ...prev, ...map }));
    } catch {
      // best effort — individual errors will surface on per-workspace retry
    } finally {
      setCheckingAll(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-[min(720px,100vw)] bg-surface-raised dark:bg-surface-raised-dark shadow-xl flex flex-col animate-slide-in-right">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-orange-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M3 12h12M3 17h6" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l3 3-3 3" />
            </svg>
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 heading-serif">Merge Queue</h2>
            <span className="text-sm text-gray-500 dark:text-gray-400">({items.length})</span>
          </div>
          <div className="flex items-center gap-2">
            {items.length > 0 && (
              <button
                type="button"
                onClick={() => void handleCheckAll()}
                disabled={checkingAll || checkingId !== null}
                className="text-xs px-2.5 py-1 rounded border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Check all workspaces for merge conflicts (read-only)"
              >
                {checkingAll ? "Checking..." : "Check All"}
              </button>
            )}
            <button
              onClick={onClose}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
              aria-label="Close merge queue"
            >
              &times;
            </button>
          </div>
        </div>

        <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 grid grid-cols-[1fr_auto_auto_auto] gap-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          <span>Workspace</span>
          <span>Ready</span>
          <span>Risk</span>
          <span>Age</span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-gray-500 dark:text-gray-400">
              No In Review workspaces are waiting in the merge queue.
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {items.map((item, index) => {
                const { issue, workspace } = item;
                const mergeError = errorByWorkspace[workspace.id];
                const isMerging = mergingId === workspace.id;
                const isChecking = checkingId === workspace.id;
                const conflicts = workspace.conflicts?.hasConflicts ? workspace.conflicts.conflictingFiles : [];
                const preview = previewByWorkspace[workspace.id];

                return (
                  <div key={workspace.id} className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800">
                    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-start">
                      <button
                        type="button"
                        onClick={() => {
                          onIssueClick(issue);
                          onClose();
                        }}
                        className="min-w-0 text-left"
                        title="Open workspace detail"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs text-gray-400 dark:text-gray-500 font-mono shrink-0">{index + 1}</span>
                          <span className="text-xs text-gray-400 dark:text-gray-500 font-mono shrink-0">#{issue.issueNumber}</span>
                          <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{issue.title}</span>
                        </div>
                        <div className="mt-1 ml-10 flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate max-w-[260px]">{workspace.branch}</span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">{formatDiffStats(workspace)}</span>
                          <span className="text-xs text-gray-400 dark:text-gray-500">{workspace.status}</span>
                        </div>
                      </button>

                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${item.readyForMerge ? "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}>
                        {item.readyForMerge ? "Ready" : "Gated"}
                      </span>

                      <span
                        className={`text-xs px-2 py-1 rounded-full font-medium ${riskClasses(item.riskLabel)}`}
                        title={conflicts.length > 0 ? `Conflicts: ${conflicts.join(", ")}` : `Risk score: ${item.conflictRisk}`}
                      >
                        {item.riskLabel === "blocked" ? "Conflicts" : `${item.riskLabel} ${item.conflictRisk}`}
                      </span>

                      <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap pt-1">
                        {item.ageSource ? formatRelativeTime(item.ageSource) : "unknown"}
                      </span>
                    </div>

                    {conflicts.length > 0 && !preview && (
                      <div className="mt-2 ml-10 text-xs text-red-600 dark:text-red-400 font-mono truncate">
                        {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}: {conflicts.join(", ")}
                      </div>
                    )}

                    {preview && (
                      <div className="mt-2 ml-10 space-y-0.5">
                        {preview.error ? (
                          <div className="text-xs text-red-600 dark:text-red-400">Check error: {preview.error}</div>
                        ) : preview.hasConflicts ? (
                          <div className="text-xs text-red-600 dark:text-red-400 font-mono">
                            {preview.conflictingFiles.length} conflict{preview.conflictingFiles.length === 1 ? "" : "s"}: {preview.conflictingFiles.join(", ")}
                          </div>
                        ) : (
                          <div className="text-xs text-green-600 dark:text-green-400">No conflicts detected</div>
                        )}
                        {preview.isStale && (
                          <div className="text-xs text-amber-600 dark:text-amber-400">Base branch has new commits — consider rebasing</div>
                        )}
                      </div>
                    )}

                    {mergeError && (
                      <div className="mt-2 ml-10 text-xs text-red-600 dark:text-red-400">
                        {mergeError}
                      </div>
                    )}

                    <div className="mt-2 ml-10 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          onIssueClick(issue);
                          onClose();
                        }}
                        className="text-xs px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                      >
                        Open Detail
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCheckConflicts(workspace.id)}
                        disabled={isChecking || checkingAll || checkingId !== null}
                        className="text-xs px-2.5 py-1 rounded border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Dry-run conflict check (read-only)"
                      >
                        {isChecking ? "Checking..." : "Check"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleMerge(workspace.id)}
                        disabled={isMerging || mergingId !== null}
                        className="text-xs px-2.5 py-1 rounded bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        title={item.readyForMerge ? "Trigger existing merge endpoint" : "Trigger existing merge endpoint for a gated item"}
                      >
                        {isMerging ? "Merging..." : "Merge"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
