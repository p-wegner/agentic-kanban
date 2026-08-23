/**
 * #764 — ONE definition of "this workspace is already terminal, do not run the exit
 * workflow on it", plus the CAS status that makes the same predicate hold ATOMICALLY.
 *
 * Why this module exists. `runWorkflowOnExit` has carried the same defect four times, each
 * incident patching one more case into a hand-enumerated predicate:
 *
 * - #551 `fix(#551): skip exit-workflow for already-merged workspaces` — added case 1
 *   (`status === "closed" && mergedAt`), because a merge landing while a fix-and-merge
 *   session ran reset the workspace back to "idle" and stranded the issue in In Review.
 * - #950 `fix(exit): classify session exits from persisted triggerType, not in-memory Sets`
 *   — the same shape one level up: the ROLE was read from process-local state that a
 *   restart emptied, so the exit was routed to the wrong terminal handler.
 * - #966 `fix(server): CAS-guard the exit-workflow idle write against concurrent terminal
 *   transitions` — case 1 was checked on a snapshot ~60 lines before the write, so the
 *   guard was made atomic in `setWorkspaceStatus`'s UPDATE ... WHERE.
 * - #1003 `fix(#1003): don't reopen a joined/cancelled/failed fork child on its own session
 *   exit` — "the already-merged guard ONLY checked status==='closed' && mergedAt", so a fork
 *   child closed by its JOIN (which never sets `mergedAt`) slipped past. Added case 2.
 *
 * #966 and #1003 landed independently and never met: #1003 extended the SNAPSHOT predicate
 * with the fork-terminal statuses, while #966's atomic enforcement lives in
 * `setWorkspaceStatus`, whose write-time guard is
 * `or(ne(status, "closed"), isNull(mergedAt))` — it has no knowledge of `forkStatus`. So
 * #1003's own bug still reproduces in its CONCURRENT form: a child joined AFTER
 * `runWorkflowOnExit` reads the row but BEFORE the idle write passes the snapshot guard
 * (not yet closed) and then passes the atomic guard (mergedAt is null), and the child is
 * flapped to `status="idle"` with `closedAt` still stamped from the join — the exact symptom
 * #1003 reports.
 *
 * That window is not hypothetical: `workflow-fork-join.repository.ts` documents it in the
 * opposite direction, noting that the fire-and-forget `notifyWorkflowAdvanced` "has no
 * delivery guarantee and can be lost/raced by a concurrent session-exit status write".
 * A fork child's join and its own CLI exit are inherently concurrent — that is what #1003
 * was about.
 */

import type { WorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";

/**
 * `forkStatus` values that mean the JOIN has already disposed of this child. Such a child is
 * "closed" with `mergedAt` null — it is never individually merged.
 */
export const FORK_TERMINAL_STATUSES = ["joined", "cancelled", "failed"] as const;

export type ForkTerminalStatus = (typeof FORK_TERMINAL_STATUSES)[number];

export function isForkTerminalStatus(forkStatus: string | null | undefined): boolean {
  return !!forkStatus && (FORK_TERMINAL_STATUSES as readonly string[]).includes(forkStatus);
}

export interface WorkspaceTerminalSnapshot {
  status: string | null;
  mergedAt: string | null;
  forkStatus: string | null;
  /** Non-null for a fork child — the workspace whose JOIN can close it concurrently. */
  parentWorkspaceId: string | null;
}

/**
 * The snapshot predicate: is this workspace ALREADY in a state the exit workflow must not
 * touch? Union of #551's merged-terminal case and #1003's fork-terminal case.
 */
export function isWorkspaceTerminalOnExit(ws: WorkspaceTerminalSnapshot): boolean {
  if (ws.status !== "closed") return false;
  return !!ws.mergedAt || isForkTerminalStatus(ws.forkStatus);
}

/**
 * The status to compare-and-set the idle write on, or `undefined` for an unconditional
 * write.
 *
 * Returns the OBSERVED status for a fork child, so any concurrent transition — including the
 * join's `closed` + `forkStatus="joined"` write, which `setWorkspaceStatus`'s own terminal
 * guard cannot see because `mergedAt` stays null — makes the idle write a CAS miss. The
 * caller then takes its existing "a terminal transition won the race" path instead of
 * reviving a joined child.
 *
 * Deliberately `undefined` for a NON-fork workspace. Those are fully covered by
 * `setWorkspaceStatus`'s atomic closed+mergedAt guard (#966), and only a fork child has a
 * join that can close it without stamping `mergedAt`. CAS-ing every workspace on its
 * observed status would turn any benign concurrent non-terminal status write into a skipped
 * exit workflow — a new stranding risk in exchange for no fixed defect.
 */
export function terminalGuardCasStatus(ws: WorkspaceTerminalSnapshot): WorkspaceStatus | undefined {
  if (!ws.parentWorkspaceId) return undefined;
  // The row column is a plain string; a value outside the union simply never matches the
  // CAS predicate, which fails CLOSED (no idle write) — the safe direction here.
  return (ws.status ?? undefined) as WorkspaceStatus | undefined;
}
