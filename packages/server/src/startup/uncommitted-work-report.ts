/**
 * "The agent finished but committed nothing" — telling the two meanings apart (#469).
 *
 * A builder session that ends with no commits ahead of base is either harmless or a total loss,
 * and the board could not tell which:
 *
 *   - CLEAN worktree  → the agent genuinely produced nothing. Nothing to report.
 *   - DIRTY worktree  → it did the work and never committed it. Indistinguishable from success
 *                       at the exit path: the session ended (often with code 0), the workspace
 *                       goes idle, and only a hand-run `git rev-list --count base..HEAD` reveals
 *                       that nothing landed.
 *
 * The second case is not rare. In one day three separate sessions produced correct, complete work
 * and committed none of it — one killed by the hang watchdog mid-verify, two by ending their turn
 * to wait on background work the harness then terminated (in print mode, ending the turn ends the
 * session, so nothing they waited on could ever report back). Two of the three exited 0. ~$17 of
 * agent time, zero commits, no signal.
 *
 * Recovery is cheap once it is visible — relaunching with "your work is uncommitted, commit it
 * first" recovered all three — so the only missing piece was the signal.
 *
 * Lives in its own module because `exit-workflow.ts` sits at the god-module gate's ceiling: this
 * check is cohesive on its own and adding it inline pushed that file over (1004 lines).
 */
import * as gitService from "../services/git.service.js";

export interface UncommittedWorkReport {
  /** Paths still uncommitted in the worktree (tracked modifications AND untracked new files). */
  paths: string[];
  /** Operator-facing summary naming the remedy — the work is recoverable, not lost. */
  summary: string;
}

/**
 * Inspect a finished session's worktree for work it never committed.
 *
 * Returns `null` when there is nothing to report (clean tree, or no worktree to look at), so the
 * caller's happy path stays a single falsy check.
 *
 * Uses `getWorkingTreeChanges`, NOT `getUncommittedTrackedChanges`: the latter excludes untracked
 * files because they do not block a merge, but lost work is very often mostly NEW files (a
 * decomposition that extracts 14 modules is almost entirely `??`), so the tracked-only reader
 * would report a clean tree for exactly the case worth catching.
 */
export async function findUncommittedWork(
  workingDir: string | null | undefined,
): Promise<UncommittedWorkReport | null> {
  if (!workingDir) return null;
  const paths = await gitService.getWorkingTreeChanges(workingDir);
  if (paths.length === 0) return null;
  return {
    paths,
    summary:
      `Agent session finished without committing, but its worktree has ${paths.length} uncommitted change(s). ` +
      `The work is still there — relaunch the workspace and tell it to commit first.`,
  };
}
