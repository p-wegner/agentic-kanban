import { findRunningCreateJobForIssue, startCreateJob, type CreateJob } from "./create-job.service.js";

/**
 * Mutual exclusion between the automatic workspace starters, keyed by issue (#366).
 *
 * The board has several paths that decide on their own to start an issue: the plugin-loop
 * direct start, the post-merge dependency cascade, and the dependency-wave launcher. Each
 * one checked "does this issue already have an open workspace?" against the `workspaces`
 * TABLE — and that check is blind for the whole provisioning window, because the row and the
 * move to In Progress are one transaction at the END of provisioning, 80s to 8+ minutes
 * later. So two starters could both read "no workspace" and both provision.
 *
 * That is not theoretical: it was reproduced 2 of 2 on pm-pipeline gate approvals. One unit
 * got two workspaces, two worktrees (`ak-8` and `ak-8-2`) and two branches 2m34s apart, and
 * the duplicate was NOT inert — it ran a full agent and committed a DIVERGENT artifact (97
 * lines vs the 135 that merged, 208 lines differing) stranded on an unmerged branch. Which
 * document became the product of record was decided by merge ordering.
 *
 * The create-job registry (#357/#360) is the only in-process evidence that separates "a
 * launch is in flight" from "nothing will ever start", so it is also the right lock: a
 * starter CLAIMS the issue there before provisioning, and every other starter sees the claim
 * immediately instead of minutes later. `claimIssueForAutoStart` does the check and the
 * registration with no `await` between them, which on a single-threaded event loop makes it
 * atomic against the other in-process starters.
 *
 * This does NOT restrict deliberate multi-workspace creation (the provider showdown, or a
 * human creating a second workspace on purpose) — those paths register no create job and are
 * not claimants.
 */
export function claimIssueForAutoStart(issueId: string): CreateJob | null {
  // No await between these two statements — that is what makes the claim atomic.
  const inFlight = findRunningCreateJobForIssue(issueId);
  if (inFlight) return null;
  return startCreateJob(issueId);
}

/** Whether some starter is already provisioning a workspace for this issue. */
export function isAutoStartClaimed(issueId: string): boolean {
  return findRunningCreateJobForIssue(issueId) !== null;
}
