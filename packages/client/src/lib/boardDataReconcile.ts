import type { StatusWithIssues } from "@agentic-kanban/shared";
import { stringifyForIssueCard } from "./boardCardSnapshot.js";

/**
 * Pure board-data reconciliation helpers used by `BoardPage.refetchBoard`.
 *
 * A board refetch is two concerns glued together: HTTP transport (ETag /
 * conditional GET / sequence guards) and reconciling the freshly-fetched
 * columns against the live React state. The reconciliation half is pure — it
 * depends only on the previous and next data — so it lives here, unit-tested,
 * instead of inline in the component (mirrors `selectedIssueSync`).
 */

/**
 * Reuse unchanged issue object references from the previous columns in the
 * freshly-fetched board, so `IssueCard`'s `React.memo` can skip re-rendering
 * rows whose data is byte-identical (compared via their IssueCard signature).
 *
 * Mutates `board` in place — each issue is replaced with the prior reference
 * when their signatures match — and returns it for convenience. When there is
 * no previous board (first load) the input is returned untouched.
 */
export function reconcileBoardIssueIdentity(
  prevCols: StatusWithIssues[],
  board: StatusWithIssues[],
): StatusWithIssues[] {
  if (prevCols.length === 0) return board;
  const prevByIssueId = new Map(prevCols.flatMap((c) => c.issues).map((i) => [i.id, i]));
  const prevIssueSignatures = new Map<string, string>(
    Array.from(prevByIssueId, ([issueId, issue]) => [issueId, stringifyForIssueCard(issue)]),
  );
  for (const col of board) {
    col.issues = col.issues.map((issue) => {
      const prev = prevByIssueId.get(issue.id);
      if (!prev) return issue;
      const prevSignature = prevIssueSignatures.get(issue.id);
      if (prevSignature !== undefined && prevSignature === stringifyForIssueCard(issue)) return prev;
      return issue;
    });
  }
  return board;
}

/**
 * Issue IDs whose main workspace is not actively running — no workspace at all,
 * or a status that is neither `"active"` nor `"fixing"`. Used to prune stale
 * live-session bookkeeping (liveStats, sessionActivity) after a refresh.
 */
export function deriveInactiveIssueIds(board: StatusWithIssues[]): Set<string> {
  const inactive = new Set<string>();
  for (const col of board) {
    for (const issue of col.issues) {
      const ws = issue.workspaceSummary?.main;
      if (!ws || (ws.status !== "active" && ws.status !== "fixing")) {
        inactive.add(issue.id);
      }
    }
  }
  return inactive;
}

/**
 * Drop issue IDs from the optimistic "pending workspace" set once the board
 * shows their main workspace has materialized (any non-`closed` status).
 * Returns the same set reference when nothing changed so callers can bail out
 * of a state update (and the resulting re-render).
 */
export function prunePendingWorkspaceIssueIds(
  prev: Set<string>,
  board: StatusWithIssues[],
): Set<string> {
  if (prev.size === 0) return prev;
  const next = new Set(prev);
  for (const col of board) {
    for (const issue of col.issues) {
      const ws = issue.workspaceSummary?.main;
      if (ws && ws.status !== "closed") next.delete(issue.id);
    }
  }
  return next.size === prev.size ? prev : next;
}

/**
 * Remove every key in `drop` from `record`, returning the same reference when
 * no key was actually present (so a `setState` caller can skip the update).
 * Generic over the value type — used to prune both `liveStats` and the raw
 * session-activity map keyed by issue id.
 */
export function pruneRecordKeys<T>(
  record: Record<string, T>,
  drop: Set<string>,
): Record<string, T> {
  const next = { ...record };
  let changed = false;
  for (const id of drop) {
    if (id in next) {
      delete next[id];
      changed = true;
    }
  }
  return changed ? next : record;
}
