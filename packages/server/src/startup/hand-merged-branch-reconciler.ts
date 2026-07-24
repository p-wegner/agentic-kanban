import { and, eq, inArray, ne, notInArray } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { getMergeCommits, getRevertedMergeCommitSubjects } from "@agentic-kanban/shared/lib/git-service";
import type { MergeCommitSubject } from "@agentic-kanban/shared/lib/git-service";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { reconcileMergedIssue } from "../services/merge-cleanup.service.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";

/**
 * Status names the sweep must NEVER touch:
 * - "Backlog" — a never-started ticket must not be closed on a coincidental branch name.
 * - "Done" — already terminal; transitioning is a no-op but we skip it to avoid churn.
 * - "Cancelled" / "Closed" — deliberately terminal; a merged branch must not resurrect
 *   them to Done (idempotency + "don't clobber Cancelled", per #113).
 */
const PROTECTED_STATUS_NAMES = ["Backlog", "Done", "Cancelled", "Closed"];

/** The branch-naming convention this reconciler recognizes (`suggestBranchName`). */
const BRANCH_AK_RE = /(?:feature\/)?ak-(\d+)\b/i;

/**
 * Extract the issue number of a merged `feature/ak-<N>` (or bare `ak-<N>`) branch from a
 * single MERGE-commit subject — only the FIRST `ak-<N>` occurrence in the subject, i.e. the
 * one anchored to the branch-name position (`Merge branch 'feature/ak-<N>-<slug>'`). A slug
 * that happens to mention a second issue later in its text (e.g.
 * `feature/ak-105-fix-ak-104-regression`) must not also match that second number (#146).
 */
function firstBranchIssueNumber(subject: string): number | null {
  const m = BRANCH_AK_RE.exec(subject);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Extract the set of issue numbers whose `feature/ak-<N>` branch appears merged, from a
 * list of MERGE-commit subjects. Exported standalone for unit testing the extraction logic.
 */
export function parseMergedIssueNumbers(subjects: string[]): Set<number> {
  const nums = new Set<number>();
  for (const subject of subjects) {
    const n = firstBranchIssueNumber(subject);
    if (n != null) nums.add(n);
  }
  return nums;
}

/**
 * Map each merged issue number to the (newest) merge commit's author date. Commits are
 * newest-first, so the first match for a given number is kept.
 */
function parseMergedBranchDates(commits: MergeCommitSubject[]): Map<number, string> {
  const dates = new Map<number, string>();
  for (const commit of commits) {
    const n = firstBranchIssueNumber(commit.subject);
    if (n == null || dates.has(n)) continue;
    dates.set(n, commit.date);
  }
  return dates;
}

export interface HandMergedBranchReconcilerDeps {
  database?: Database;
  /** Injectable for testing. Defaults to the real getMergeCommits from git-service. */
  getMergeCommits?: (repoPath: string, ref: string, sinceIso?: string) => Promise<MergeCommitSubject[]>;
  /** Injectable for testing. Defaults to the real getRevertedMergeCommitSubjects from git-service. */
  getRevertedMergeSubjects?: (repoPath: string, ref: string) => Promise<string[]>;
}

/**
 * Auto-transition an issue to Done when its `feature/ak-<N>` branch was landed by a manual
 * `--no-ff` merge to the default branch WITHOUT a board workspace (#113).
 *
 * The board's own dev fixes land as hand-merged `feature/ak-<N>-<slug>` branches, not board
 * workspaces. Every workspace-driven merge path reconciles the issue to Done, but a
 * no-workspace hand-merge leaves NO row to key off — so the linked issue #N sat open until a
 * human PATCHed it (the live friction this exercise surfaced). This git-history sweep closes
 * that gap: it scans the default branch's MERGE commits for merged `ak-<N>` branch names and
 * converges each still-open matching issue via the shared idempotent {@link reconcileMergedIssue}.
 *
 * Safety (#146 — issue numbers RECYCLE, so a naive scan of all history can force-Done an
 * in-flight issue whose number matches an old, unrelated merge):
 * - Only issues PAST Backlog and NOT terminal are candidates (a never-started Backlog ticket
 *   or a deliberately Cancelled/Closed one is never touched).
 * - Never transitions an issue that has a LIVE (non-closed) workspace — an issue actively
 *   being worked cannot have been proven done by an old merge commit.
 * - The matching merge commit's author date must be NEWER than the issue's `createdAt` — an
 *   old merge cannot be evidence that a younger issue (a recycled number) was merged.
 * - The match is anchored to the branch-name position in the subject (first `ak-<N>` only),
 *   not any occurrence anywhere in the subject text.
 * - The git scan window is bounded to merges since the earliest candidate issue's `createdAt`
 *   (plus a 1000-commit hard ceiling), instead of the last 1000 merges of ALL history.
 * - A branch whose merge was later reverted (`Revert "Merge ...'ak-<N>...'"` subject) is
 *   skipped.
 * - Per project (issue numbers are per-project), so a branch name never maps across projects.
 * - Idempotent: reconcileMergedIssue is a no-op once the issue is already on the target status.
 *
 * Best-effort and non-fatal throughout — safe to call on every boot. Returns the number of
 * issues actually transitioned.
 */
export async function reconcileHandMergedBranches(
  deps: HandMergedBranchReconcilerDeps = {},
): Promise<number> {
  const database = deps.database ?? db;
  const getCommits = deps.getMergeCommits ?? ((repoPath, ref, sinceIso) => getMergeCommits(repoPath, ref, sinceIso));
  const getReverts = deps.getRevertedMergeSubjects ?? ((repoPath, ref) => getRevertedMergeCommitSubjects(repoPath, ref));
  let reconciled = 0;

  try {
    const projectRows = await database
      .select({ id: projects.id, repoPath: projects.repoPath, defaultBranch: projects.defaultBranch, name: projects.name })
      .from(projects);

    for (const project of projectRows) {
      if (!project.repoPath || !project.defaultBranch) continue;

      // Candidate issues: open (past Backlog, non-terminal) issues of THIS project. If none,
      // skip the git scan entirely — the common steady-state cost is a single cheap query.
      const candidates = await database
        .select({
          issueId: issues.id,
          issueNumber: issues.issueNumber,
          statusName: projectStatuses.name,
          createdAt: issues.createdAt,
        })
        .from(issues)
        .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
        .where(and(eq(issues.projectId, project.id), notInArray(projectStatuses.name, PROTECTED_STATUS_NAMES)));

      const byNumber = new Map<number, { issueId: string; statusName: string | null; createdAt: string }>();
      for (const c of candidates) {
        if (c.issueNumber != null) byNumber.set(c.issueNumber, { issueId: c.issueId, statusName: c.statusName, createdAt: c.createdAt });
      }
      if (byNumber.size === 0) continue;

      // Guard: never Done an issue with a live (non-closed) workspace — active work cannot
      // have been "proven done" by an old merge commit matching a recycled number.
      const candidateIssueIds = [...byNumber.values()].map((c) => c.issueId);
      const liveWorkspaceRows = await database
        .select({ issueId: workspaces.issueId })
        .from(workspaces)
        .where(and(inArray(workspaces.issueId, candidateIssueIds), ne(workspaces.status, "closed")));
      const liveWorkspaceIssueIds = new Set(liveWorkspaceRows.map((r) => r.issueId));
      for (const [num, cand] of byNumber) {
        if (liveWorkspaceIssueIds.has(cand.issueId)) byNumber.delete(num);
      }
      if (byNumber.size === 0) continue;

      // Bound the scan window to merges since the earliest candidate issue was created.
      const sinceIso = [...byNumber.values()]
        .map((c) => c.createdAt)
        .reduce((min, createdAt) => (min == null || createdAt < min ? createdAt : min), null as string | null);

      let commits: MergeCommitSubject[];
      try {
        commits = await getCommits(project.repoPath, project.defaultBranch, sinceIso ?? undefined);
      } catch (err) {
        console.warn(`[hand-merge-reconciler] merge-history scan failed for ${project.repoPath}:`, err instanceof Error ? err.message : String(err));
        continue;
      }
      if (commits.length === 0) continue;
      const mergedDates = parseMergedBranchDates(commits);
      if (mergedDates.size === 0) continue;

      let revertedNumbers: Set<number>;
      try {
        revertedNumbers = parseMergedIssueNumbers(await getReverts(project.repoPath, project.defaultBranch));
      } catch {
        revertedNumbers = new Set();
      }

      const now = new Date().toISOString();
      for (const [num, cand] of byNumber) {
        const mergeDate = mergedDates.get(num);
        if (!mergeDate) continue;
        if (revertedNumbers.has(num)) continue;
        // The merge must postdate the issue itself — an old merge cannot be evidence that a
        // younger issue (a recycled issue number) was merged.
        if (!(new Date(mergeDate).getTime() > new Date(cand.createdAt).getTime())) continue;

        try {
          const res = await reconcileMergedIssue({ database, issueId: cand.issueId, now, projectId: project.id });
          if (!res.issueTransitioned) continue;
          reconciled++;
          console.log(
            `[hand-merge-reconciler] auto-Done: issue #${num} (was '${cand.statusName ?? "?"}') — feature/ak-${num} branch is merged into ${project.defaultBranch} of '${project.name}'`,
          );
          try {
            await logBoardHealthEvent({
              projectId: project.id,
              cycleId: `hand-merge-reconcile-${project.id}-${num}`,
              eventType: "action",
              category: "merge",
              issueNumber: num,
              summary: `Hand-merged-branch reconciliation: feature/ak-${num} was merged into ${project.defaultBranch} by hand (no board workspace) but issue #${num} was still '${cand.statusName ?? "?"}'. Moved it to Done.`,
              details: { issueNumber: num, previousStatus: cand.statusName, defaultBranch: project.defaultBranch, reconciledAt: now },
            }, database);
          } catch { /* health event logging is non-fatal */ }
        } catch (err) {
          console.warn(`[hand-merge-reconciler] failed to reconcile issue #${num}:`, err instanceof Error ? err.message : String(err));
        }
      }
    }
  } catch (err) {
    console.warn("[hand-merge-reconciler] reconcileHandMergedBranches failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }

  if (reconciled > 0) {
    console.log(`[hand-merge-reconciler] auto-transitioned ${reconciled} hand-merged issue(s) to Done`);
  }
  return reconciled;
}
