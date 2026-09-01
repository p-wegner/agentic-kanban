// Pure view-model for the "start next dependency wave" feedback (#972).
//
// Starting a wave used to be invisible: the only signal was the trigger button
// swapping its label to "Starting...", so between the click and the toast
// nothing on the board said which issues were being launched — while starting a
// SINGLE ticket workspace has always marked that issue's card with a spinner and
// a "Setting up workspace…" badge (`pendingWorkspaceIssueIds`, see
// `createBoardIssueActions.handleStartWorkspace`). A wave is N of exactly that
// operation, so it should read the same way.
//
// This module holds the two pure halves so they are testable without a DOM:
//  - `selectWaveStartCandidates` — which issues a start will actually attempt,
//    i.e. what to mark pending; the same min(startable, available slots) rule
//    the panel's button label already displays.
//  - `summarizeWaveStart` — the outcome line rendered in the panel (and the
//    toast text), so "what happened" survives after the spinners clear.
import type { DependencyWavePlan, DependencyWaveStartResult } from "@agentic-kanban/shared";

/** Phase of a wave start, as the panel narrates it. */
export type WaveStartPhase = "idle" | "starting" | "done";

export interface WaveStartProgress {
  phase: WaveStartPhase;
  /** Issue ids being started (phase "starting") or that were attempted (phase "done"). */
  attemptedIssueIds: string[];
  /** Human-readable line describing what is happening / what happened. */
  message: string;
  /** True when the finished start had at least one failure — renders as an error tone. */
  failed: boolean;
}

export const IDLE_WAVE_PROGRESS: WaveStartProgress = {
  phase: "idle",
  attemptedIssueIds: [],
  message: "",
  failed: false,
};

/**
 * The issues a "Start Next Wave" click will actually attempt: the startable
 * ready-now issues, capped by the open WIP slots.
 *
 * The cap matters for the feedback, not just for the server: marking every
 * ready issue pending would put a "Setting up workspace…" badge on cards that
 * the WIP limit is going to leave untouched.
 */
export function selectWaveStartCandidates(plan: DependencyWavePlan | null): string[] {
  if (!plan) return [];
  const startable = plan.readyNow.filter((issue) => issue.startEligible);
  const slots = Math.max(0, plan.wip.available);
  return startable.slice(0, slots).map((issue) => issue.id);
}

/** The in-flight line, e.g. "Starting 3 issues — creating worktrees…". */
export function describeWaveStarting(candidateIds: string[]): WaveStartProgress {
  const count = candidateIds.length;
  return {
    phase: "starting",
    attemptedIssueIds: [...candidateIds],
    message: count === 1
      ? "Starting 1 issue — creating the worktree and running setup…"
      : `Starting ${count} issues — creating worktrees and running setup…`,
    failed: false,
  };
}

/**
 * The outcome line for a completed start. Mirrors the toast wording so the
 * panel and the toast never disagree about what happened.
 */
export function summarizeWaveStart(
  result: DependencyWaveStartResult,
  candidateIds: string[],
): WaveStartProgress {
  const started = result.started.length;
  const failed = result.failed.length;
  const attempted = [
    ...result.started.map((entry) => entry.issueId),
    ...result.failed.map((entry) => entry.issueId),
  ];

  let message: string;
  if (started > 0 && failed > 0) {
    message = `Started ${started}, ${failed} failed — ${describeFailures(result)}`;
  } else if (started > 0) {
    message = `Started ${started} issue${started === 1 ? "" : "s"}: ${listIssueNumbers(result.started)}`;
  } else if (failed > 0) {
    message = `Nothing started — ${describeFailures(result)}`;
  } else if (result.skipped.availableSlots <= 0) {
    message = `WIP limit reached (${result.skipped.currentWip}/${result.skipped.wipLimit}) — nothing started`;
  } else {
    message = "No ready issues to start";
  }

  return {
    phase: "done",
    attemptedIssueIds: attempted.length > 0 ? attempted : [...candidateIds],
    message,
    failed: failed > 0,
  };
}

/** The outcome line when the request itself threw (network/500). */
export function describeWaveStartError(error: unknown, candidateIds: string[]): WaveStartProgress {
  return {
    phase: "done",
    attemptedIssueIds: [...candidateIds],
    message: error instanceof Error ? error.message : "Failed to start wave",
    failed: true,
  };
}

/**
 * Add this start's issues to the shared pending-workspace set.
 *
 * Pure so the merge/clear pair below can be tested: the package's convention is
 * pure-function tests without a hook harness (see `useApiResource.test.ts`), so
 * anything that must not regress has to be expressible without React.
 */
export function markWaveIssuesPending(prev: Set<string>, candidateIds: string[]): Set<string> {
  return new Set([...prev, ...candidateIds]);
}

/**
 * Remove ONLY the ids this start marked. A concurrent single-ticket start owns
 * its own entry in the same set and must keep its badge — clearing the whole set
 * would silently strip it.
 */
export function clearWaveIssuesPending(prev: Set<string>, candidateIds: string[]): Set<string> {
  const next = new Set(prev);
  for (const id of candidateIds) next.delete(id);
  return next;
}

function listIssueNumbers(entries: Array<{ issueNumber: number | null }>): string {
  return entries.map((entry) => (entry.issueNumber != null ? `#${entry.issueNumber}` : "?")).join(", ");
}

function describeFailures(result: DependencyWaveStartResult): string {
  const first = result.failed[0];
  if (!first) return "no details";
  const label = first.issueNumber != null ? `#${first.issueNumber}` : "an issue";
  const rest = result.failed.length - 1;
  return rest > 0 ? `${label}: ${first.error} (+${rest} more)` : `${label}: ${first.error}`;
}
