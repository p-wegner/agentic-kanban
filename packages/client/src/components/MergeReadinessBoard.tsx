import { useMemo } from "react";
import type { MatrixWorkspaceInput, MultiRepoMatrix } from "../lib/multiRepoMatrix.js";
import {
  computeMergeReadiness,
  deriveActivity,
  deriveAgentBlocker,
  deriveReviewStatus,
  repoStatusFromCell,
  verdictSortRank,
  type GateStatus,
  type MergeVerdict,
  type RepoReadinessStatus,
  type ReviewStatus,
} from "../lib/mergeReadiness.js";

/** One fully-resolved board row: a workspace, its per-repo statuses, and its verdict. */
export interface MergeReadinessRow {
  workspace: MatrixWorkspaceInput;
  repos: RepoReadinessStatus[];
  review: ReviewStatus;
  gate: GateStatus;
  verdict: MergeVerdict;
}

/**
 * Transpose the repo × workspace matrix into one merge-readiness row per workspace:
 * gather each repo's cell for that workspace column, derive review + gate state from
 * the workspace status, then resolve the single verdict. Sorted READY-first (then
 * BLOCKED, then IN-PROGRESS), ties broken by issue number so the order is stable.
 */
export function buildMergeReadinessRows(
  matrix: MultiRepoMatrix,
  workspaces: MatrixWorkspaceInput[],
): MergeReadinessRow[] {
  const rows = workspaces.map((workspace, col) => {
    const repos = matrix.rows.map((row) => repoStatusFromCell(row.label, row.cells[col]));
    const hasWork = repos.some((r) => r.kind === "ahead" || r.kind === "conflicts");
    const hasConflicts = repos.some((r) => r.kind === "conflicts");
    const review = deriveReviewStatus(workspace.status);
    // The only gate we can read without a heavy fetch is merge-cleanliness: a
    // workspace with unlanded work either applies cleanly (passed) or conflicts
    // (failed); nothing to merge yet has no gate to evaluate.
    const gate: GateStatus = hasConflicts ? "failed" : hasWork ? "passed" : "none";
    const verdict = computeMergeReadiness({
      repos,
      review,
      gate,
      activity: deriveActivity(workspace.status),
      agentBlocker: deriveAgentBlocker(workspace.status),
    });
    return { workspace, repos, review, gate, verdict };
  });

  return rows.sort((a, b) => {
    const byVerdict = verdictSortRank(a.verdict.kind) - verdictSortRank(b.verdict.kind);
    if (byVerdict !== 0) return byVerdict;
    return (a.workspace.issueNumber ?? Infinity) - (b.workspace.issueNumber ?? Infinity);
  });
}

const VERDICT_CLASS: Record<MergeVerdict["kind"], string> = {
  READY: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  BLOCKED: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  "IN-PROGRESS": "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
};

const REPO_STATUS: Record<RepoReadinessStatus["kind"], { className: string; title: string }> = {
  clean: {
    className: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    title: "Clean — work landed on base (or no changes)",
  },
  ahead: {
    className: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    title: "Commits ahead of base (unlanded work)",
  },
  conflicts: {
    className: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    title: "Unlanded work that conflicts with base",
  },
  "not-part-of": {
    className: "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500",
    title: "This repo is not part of the workspace",
  },
  unknown: {
    className: "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500",
    title: "Merge status could not be read for this workspace",
  },
};

function repoBadgeText(repo: RepoReadinessStatus): string {
  switch (repo.kind) {
    case "clean":
      return "clean";
    case "ahead":
      return `ahead ${repo.ahead}`;
    case "conflicts":
      return "conflicts";
    case "not-part-of":
      return "—";
    default:
      return "?";
  }
}

function ReviewBadge({ review }: { review: ReviewStatus }) {
  const label = review === "approved" ? "reviewed" : review === "in-progress" ? "reviewing" : "unreviewed";
  const className =
    review === "approved"
      ? "text-green-600 dark:text-green-400"
      : review === "in-progress"
        ? "text-blue-600 dark:text-blue-400"
        : "text-amber-600 dark:text-amber-400";
  return <span className={`text-xs ${className}`}>{label}</span>;
}

function GateBadge({ gate }: { gate: GateStatus }) {
  if (gate === "none") return <span className="text-xs text-gray-400 dark:text-gray-500">—</span>;
  const label = gate === "passed" ? "clean" : gate === "failed" ? "conflicts" : "checking";
  const className =
    gate === "passed"
      ? "text-green-600 dark:text-green-400"
      : gate === "failed"
        ? "text-red-600 dark:text-red-400"
        : "text-blue-600 dark:text-blue-400";
  return <span className={`text-xs ${className}`}>{label}</span>;
}

/**
 * Merge-Readiness Roll-up Board (#98): fleet triage answering "what can I merge
 * next and what's blocked", per repo. One row per active workspace — a compact
 * per-repo status set, review + gate state, and a single READY / BLOCKED(reason) /
 * IN-PROGRESS verdict — sorted READY-first. Clicking a row jumps to the workspace.
 *
 * Purely presentational: it reuses the repo × workspace matrix already built by the
 * Multi-Repo Monitor (`buildMultiRepoMatrix`) and the workspace status data, so it
 * adds no new fetch of its own.
 */
export function MergeReadinessBoard({
  matrix,
  workspaces,
  onOpenWorkspace,
}: {
  matrix: MultiRepoMatrix;
  workspaces: MatrixWorkspaceInput[];
  onOpenWorkspace?: (workspaceId: string, issueId: string | null) => void;
}) {
  const rows = useMemo(() => buildMergeReadinessRows(matrix, workspaces), [matrix, workspaces]);
  const readyCount = rows.filter((r) => r.verdict.kind === "READY").length;
  const blockedCount = rows.filter((r) => r.verdict.kind === "BLOCKED").length;

  if (rows.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center h-48 text-gray-400 dark:text-gray-500 gap-2 px-6 text-center"
        data-testid="merge-readiness-empty"
      >
        <p className="text-sm font-medium">No active workspaces</p>
        <p className="text-xs">Start a workspace to see its merge readiness here.</p>
      </div>
    );
  }

  return (
    <div data-testid="merge-readiness-board">
      <div className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
        <span className="text-green-600 dark:text-green-400 font-medium">{readyCount} ready</span>
        {" · "}
        <span className="text-red-600 dark:text-red-400 font-medium">{blockedCount} blocked</span>
        {" · "}
        {rows.length} workspace{rows.length === 1 ? "" : "s"}
      </div>
      <table className="text-sm border-collapse min-w-full" data-testid="merge-readiness-table">
        <thead>
          <tr className="text-left text-xs font-semibold text-gray-500 dark:text-gray-400">
            <th className="px-4 py-2 border-b border-gray-200 dark:border-gray-700">Verdict</th>
            <th className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">Workspace</th>
            <th className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">Repos</th>
            <th className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">Review</th>
            <th className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">Gate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ workspace, repos, review, gate, verdict }) => (
            <tr
              key={workspace.id}
              data-testid="merge-readiness-row"
              data-verdict={verdict.kind}
              className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer"
              onClick={() => onOpenWorkspace?.(workspace.id, workspace.issueId ?? null)}
              title={workspace.issueTitle ?? undefined}
            >
              <td className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 align-top whitespace-nowrap">
                <span
                  className={`inline-block text-[11px] font-semibold px-1.5 py-0.5 rounded ${VERDICT_CLASS[verdict.kind]}`}
                  data-testid="merge-readiness-verdict"
                >
                  {verdict.kind}
                </span>
                {verdict.reason && (
                  <div className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400" data-testid="merge-readiness-reason">
                    {verdict.reason}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 border-b border-gray-100 dark:border-gray-800 align-top">
                <div className="font-mono text-gray-700 dark:text-gray-200">
                  {workspace.issueNumber !== null ? `#${workspace.issueNumber}` : "—"}
                </div>
                <div className="text-[10px] text-gray-400 dark:text-gray-500 font-mono truncate max-w-[160px]">
                  {workspace.branch ?? ""}
                </div>
              </td>
              <td className="px-3 py-2 border-b border-gray-100 dark:border-gray-800 align-top">
                <div className="flex flex-wrap gap-1">
                  {repos.map((repo, i) => {
                    const style = REPO_STATUS[repo.kind];
                    return (
                      <span
                        key={`${repo.label}-${i}`}
                        className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded ${style.className}`}
                        title={`${repo.label}: ${style.title}`}
                        data-repo-kind={repo.kind}
                      >
                        <span className="font-mono opacity-70">{repo.label}</span>
                        <span className="font-medium">{repoBadgeText(repo)}</span>
                      </span>
                    );
                  })}
                </div>
              </td>
              <td className="px-3 py-2 border-b border-gray-100 dark:border-gray-800 align-top">
                <ReviewBadge review={review} />
              </td>
              <td className="px-3 py-2 border-b border-gray-100 dark:border-gray-800 align-top">
                <GateBadge gate={gate} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
