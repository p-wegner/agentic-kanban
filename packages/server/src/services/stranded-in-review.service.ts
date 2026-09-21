import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getWorkspacesForStrandedInReviewCheck } from "../repositories/stranded-in-review.repository.js";

/**
 * #1206 — an issue is "stranded In Review" when it has REAL branch work (a
 * non-direct, unmerged workspace exists) but no OPEN workspace currently holds
 * it: every workspace for the issue is closed. So no train can board it, no
 * review can run, and `get_board_status` shows nothing "in progress" for it —
 * the shape found live on #1120/#1125/#1140/#1149/#1150/#1152.
 *
 * A pure DB predicate (no git call): the LATEST workspace (by `updatedAt`) is
 * closed, non-direct, and not merged (`mergedAt` null). Deliberately does not
 * distinguish how far ahead the branch is — a branch fully CONTAINED in base (0
 * ahead) is handled separately and evidence-gated
 * (`reconcileContainedOpenWorkspaces` in hand-merged-branch-reconciler.ts, #1205),
 * and that sweep runs on its own periodic cadence, so anything still stranded
 * by the time this predicate is asked is, in practice, real unmerged work.
 */
export async function findStrandedInReviewIssueIds(
  issueIds: string[],
  database: Database = db,
): Promise<string[]> {
  if (issueIds.length === 0) return [];

  const wsRows = await getWorkspacesForStrandedInReviewCheck(issueIds, database);

  const byIssue = new Map<string, typeof wsRows>();
  for (const w of wsRows) {
    const arr = byIssue.get(w.issueId) ?? [];
    arr.push(w);
    byIssue.set(w.issueId, arr);
  }

  const stranded: string[] = [];
  for (const issueId of issueIds) {
    const workspacesForIssue = byIssue.get(issueId) ?? [];
    if (workspacesForIssue.length === 0) continue; // no branch work at all — untouched, not stranded
    if (workspacesForIssue.some((w) => w.status !== "closed")) continue; // an open workspace exists

    const latest = [...workspacesForIssue].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
    if (!latest.isDirect && !latest.mergedAt) stranded.push(issueId);
  }
  return stranded;
}
