import {
  checkBranchTipIsAncestor,
  countUniqueCommits,
} from "@agentic-kanban/shared/lib/git-service";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { emptyPassReport, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { getOpenNonDirectWorkspacesForProject } from "../repositories/workspace-reads.repository.js";
import { getProjectRepoFields } from "../repositories/project.repository.js";

/**
 * Why an "unmerged" workspace is not automatically outstanding work (#1177).
 *
 * `list_workspaces`/the board count every non-closed workspace as "unmerged" — but a
 * workspace's branch can be gone entirely (no branch to merge at all, e.g. its worktree
 * was cleaned up out of band) or fully caught up with base (0 commits ahead — the content
 * already landed, whether by a merge the board never attributed, a hand merge, or because
 * the work was redone elsewhere). Neither of those is outstanding: nothing will ever move
 * them, since there is no commit left to land. Measured 2026-09-16: roughly two thirds of
 * the board's "54 unmerged" workspaces fell into one of these two buckets, inflating the
 * real outstanding count by ~2.5x.
 *
 * - `no-branch`   — the branch ref does not resolve (deleted, or never created).
 * - `zero-ahead`  — the branch resolves and IS an ancestor of base (0 unique commits).
 * - `outstanding` — the branch resolves and has commits base does not (real, unlanded work).
 */
export type UnmergedWorkspaceBucket = "no-branch" | "zero-ahead" | "outstanding";

export interface UnmergedWorkspaceClassification {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  projectId: string;
  branch: string;
  baseBranch: string;
  bucket: UnmergedWorkspaceBucket;
  /** Unique commits ahead of base. 0 for `no-branch` (nothing to count) and `zero-ahead`. */
  uniqueCommitCount: number;
}

export interface ClassifyUnmergedWorkspacesReport extends PassReport {
  classifications: UnmergedWorkspaceClassification[];
}

export interface ClassifyUnmergedWorkspacesDeps {
  database?: Database;
  /** Injectable for testing. Defaults to the real checkBranchTipIsAncestor from git-service. */
  checkAncestor?: typeof checkBranchTipIsAncestor;
  /** Injectable for testing. Defaults to the real countUniqueCommits from git-service. */
  countCommits?: typeof countUniqueCommits;
}

/**
 * Classify every open (non-closed), non-direct workspace of a project into
 * no-branch / zero-ahead / outstanding, by asking git rather than trusting the DB's
 * "unmerged" bucketing (which is just `status !== 'closed'` and knows nothing about
 * branch state).
 *
 * Read-only and best-effort: a workspace whose git checks fail is recorded as `skipped`
 * with the reason, never silently dropped (see `PassReport`'s "acted + skipped may be
 * LESS than scanned" note) — this function makes no destructive decision on its own; a
 * caller wanting to CLOSE the no-branch/zero-ahead findings is a separate, deliberate step
 * (the no-branch bucket in particular can include a workspace whose worktree was cleaned
 * up while the ticket is still genuinely open, so it must never be auto-closed here).
 */
export async function classifyUnmergedWorkspaces(
  projectId: string,
  deps: ClassifyUnmergedWorkspacesDeps = {},
): Promise<ClassifyUnmergedWorkspacesReport> {
  const database = deps.database ?? db;
  const ancestorCheck = deps.checkAncestor ?? checkBranchTipIsAncestor;
  const commitCounter = deps.countCommits ?? countUniqueCommits;

  const project = await getProjectRepoFields(projectId, database);
  if (!project || !project.repoPath) {
    return { ...emptyPassReport(0), classifications: [] };
  }

  const candidates = await getOpenNonDirectWorkspacesForProject(projectId, database);

  const report: ClassifyUnmergedWorkspacesReport = { ...emptyPassReport(candidates.length), classifications: [] };
  if (candidates.length === 0) return report;

  const defaultBranch = project.defaultBranch;

  for (const c of candidates) {
    const baseBranch = c.baseBranch || defaultBranch;
    if (!baseBranch) {
      recordSkipped(report, c.wsId, "no base branch resolvable");
      continue;
    }

    let ancestry: Awaited<ReturnType<typeof checkBranchTipIsAncestor>>;
    try {
      ancestry = await ancestorCheck(project.repoPath, c.branch, baseBranch, c.workingDir ?? undefined);
    } catch (err) {
      recordSkipped(report, c.wsId, `git ancestry check failed: ${errorMessage(err)}`);
      continue;
    }

    if (ancestry.branchSha === null) {
      // "base-not-found" is a repo-level problem, not a per-workspace branch-state fact —
      // record it as skipped rather than misclassifying every candidate as no-branch.
      if (ancestry.reason === "base-not-found") {
        recordSkipped(report, c.wsId, `could not resolve base branch ${baseBranch}`);
        continue;
      }
      const classification: UnmergedWorkspaceClassification = {
        workspaceId: c.wsId,
        issueId: c.issueId,
        issueNumber: c.issueNumber,
        projectId,
        branch: c.branch,
        baseBranch,
        bucket: "no-branch",
        uniqueCommitCount: 0,
      };
      report.classifications.push(classification);
      recordActed(report, c.wsId, "no-branch");
      continue;
    }

    if (ancestry.isAncestor) {
      const classification: UnmergedWorkspaceClassification = {
        workspaceId: c.wsId,
        issueId: c.issueId,
        issueNumber: c.issueNumber,
        projectId,
        branch: c.branch,
        baseBranch,
        bucket: "zero-ahead",
        uniqueCommitCount: 0,
      };
      report.classifications.push(classification);
      recordActed(report, c.wsId, "zero-ahead");
      continue;
    }

    let uniqueCommits: number;
    try {
      uniqueCommits = await commitCounter(project.repoPath, ancestry.baseSha, ancestry.branchSha);
    } catch (err) {
      recordSkipped(report, c.wsId, `git commit count failed: ${errorMessage(err)}`);
      continue;
    }

    if (uniqueCommits === 0) {
      // Ancestry said "not an ancestor" (usually a diverged/rebased history) but there
      // are genuinely no commits base lacks — same "nothing to land" conclusion as the
      // is-ancestor case above, just reached the other way round.
      const classification: UnmergedWorkspaceClassification = {
        workspaceId: c.wsId,
        issueId: c.issueId,
        issueNumber: c.issueNumber,
        projectId,
        branch: c.branch,
        baseBranch,
        bucket: "zero-ahead",
        uniqueCommitCount: 0,
      };
      report.classifications.push(classification);
      recordActed(report, c.wsId, "zero-ahead");
      continue;
    }

    const classification: UnmergedWorkspaceClassification = {
      workspaceId: c.wsId,
      issueId: c.issueId,
      issueNumber: c.issueNumber,
      projectId,
      branch: c.branch,
      baseBranch,
      bucket: "outstanding",
      uniqueCommitCount: uniqueCommits,
    };
    report.classifications.push(classification);
    recordActed(report, c.wsId, "outstanding");
  }

  return report;
}

/** Count classifications by bucket — the ~2.5x-inflation number this ticket is about. */
export function summarizeUnmergedWorkspaceBuckets(
  classifications: UnmergedWorkspaceClassification[],
): Record<UnmergedWorkspaceBucket, number> {
  const summary: Record<UnmergedWorkspaceBucket, number> = { "no-branch": 0, "zero-ahead": 0, outstanding: 0 };
  for (const c of classifications) summary[c.bucket]++;
  return summary;
}

/** Only the workspaces that are real, unlanded work — the number an operator actually wants. */
export function outstandingUnmergedWorkspaces(
  classifications: UnmergedWorkspaceClassification[],
): UnmergedWorkspaceClassification[] {
  return classifications.filter((c) => c.bucket === "outstanding");
}
