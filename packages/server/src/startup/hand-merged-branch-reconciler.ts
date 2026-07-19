import { and, eq, notInArray } from "drizzle-orm";
import { issues, projectStatuses, projects } from "@agentic-kanban/shared/schema";
import { getMergeCommitSubjects } from "@agentic-kanban/shared/lib/git-service";
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

/**
 * Extract the issue numbers of merged `feature/ak-<N>` (or bare `ak-<N>`) branches from a
 * list of MERGE-commit subjects. A hand `--no-ff` merge of `feature/ak-113-slug` produces
 * a subject like `Merge branch 'feature/ak-113-slug'` (or `Merge feature/ak-113-slug`),
 * so the branch name — and thus the issue number — is recoverable even after the branch
 * is deleted. The match is anchored on the `ak-<N>` convention (`suggestBranchName`), so a
 * subject that merely mentions a number without the branch prefix is ignored.
 */
export function parseMergedIssueNumbers(subjects: string[]): Set<number> {
  const nums = new Set<number>();
  const re = /(?:feature\/)?ak-(\d+)\b/gi;
  for (const subject of subjects) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(subject)) !== null) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isInteger(n) && n > 0) nums.add(n);
    }
  }
  return nums;
}

export interface HandMergedBranchReconcilerDeps {
  database?: Database;
  /** Injectable for testing. Defaults to the real getMergeCommitSubjects from git-service. */
  getMergeSubjects?: (repoPath: string, ref: string) => Promise<string[]>;
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
 * Safety (never mass-transition on an ambiguous match):
 * - Only issues PAST Backlog and NOT terminal are candidates (a never-started Backlog ticket
 *   or a deliberately Cancelled/Closed one is never touched).
 * - Each candidate is transitioned only when its OWN issue number appears as a merged
 *   `ak-<N>` branch in a real merge commit on the default branch — positive evidence of an
 *   actual merge, surviving branch deletion.
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
  const getSubjects = deps.getMergeSubjects ?? ((repoPath, ref) => getMergeCommitSubjects(repoPath, ref));
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
        .select({ issueId: issues.id, issueNumber: issues.issueNumber, statusName: projectStatuses.name })
        .from(issues)
        .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
        .where(and(eq(issues.projectId, project.id), notInArray(projectStatuses.name, PROTECTED_STATUS_NAMES)));

      const byNumber = new Map<number, { issueId: string; statusName: string | null }>();
      for (const c of candidates) {
        if (c.issueNumber != null) byNumber.set(c.issueNumber, { issueId: c.issueId, statusName: c.statusName });
      }
      if (byNumber.size === 0) continue;

      let subjects: string[];
      try {
        subjects = await getSubjects(project.repoPath, project.defaultBranch);
      } catch (err) {
        console.warn(`[hand-merge-reconciler] merge-history scan failed for ${project.repoPath}:`, err instanceof Error ? err.message : String(err));
        continue;
      }
      if (subjects.length === 0) continue;
      const mergedNumbers = parseMergedIssueNumbers(subjects);
      if (mergedNumbers.size === 0) continue;

      const now = new Date().toISOString();
      for (const [num, cand] of byNumber) {
        if (!mergedNumbers.has(num)) continue;
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
