import { dedupeConflictClusters, type TrainMember } from "./merge-train-assembly.js";
import type { TrainRunResult } from "./merge-train.service.js";

/**
 * Suite-owner shortcut for a red train: name the culprit without bisecting when the gate says
 * which suites failed and exactly one member wrote all of them.
 *
 * Observed case: `train/2026-09-27-10` (#1253 + #1261) went red on
 * `packages/server/src/__tests__/test-impact-budget-cap-lockstep.test.mjs`, a file only #1261
 * adds, and still paid a control arm plus two halves to learn that. With one bad member in N the
 * bisect costs about 2·log N + 1 gate runs; this costs one (the rest, re-gated without it).
 *
 * Deliberately narrow: every failing suite must sit in the changed-file set of the SAME single
 * member and of no other. A suite nobody touched (a semantic break elsewhere), a suite two members
 * touched, or a red that named no suite falls back to the bisect unchanged. If the owner's suite
 * failed only because of another member's change, rejecting the owner is still the right call:
 * the rest lands, and the owner's suite is red against that new base, which is its author's to fix.
 */
export interface SuiteOwnerShortcut<M extends TrainMember> {
  owner: M;
  suites: string[];
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function decideSuiteOwnerShortcut<M extends TrainMember>(
  failedSuites: readonly string[] | undefined,
  members: readonly M[],
): SuiteOwnerShortcut<M> | null {
  const suites = [...new Set((failedSuites ?? []).map(normalizePath).filter(Boolean))];
  if (suites.length === 0 || members.length < 2) return null;
  const changed = members.map((m) => new Set((m.changedFiles ?? []).map(normalizePath)));
  let ownerIndex = -1;
  for (const suite of suites) {
    const owners = changed.flatMap((set, i) => (set.has(suite) ? [i] : []));
    if (owners.length !== 1) return null;
    if (ownerIndex !== -1 && owners[0] !== ownerIndex) return null;
    ownerIndex = owners[0];
  }
  return { owner: members[ownerIndex], suites };
}

/**
 * #1577 — the members that OWN a red train's failing suites (any number, unlike the single-owner
 * shortcut), for the one targeted regate without them. Null when the failure is unattributed (no
 * suite named, or none of them in any member's changed files: environment / semantic break) or
 * when every member owns one (nothing innocent would be left to land).
 */
export function decideAttributedOwners<M extends TrainMember>(
  failedSuites: readonly string[] | undefined,
  members: readonly M[],
): { owners: M[]; innocent: M[]; suites: string[] } | null {
  const suites = [...new Set((failedSuites ?? []).map(normalizePath).filter(Boolean))];
  if (suites.length === 0 || members.length < 2) return null;
  const suiteSet = new Set(suites);
  const owners = members.filter((m) => (m.changedFiles ?? []).some((f) => suiteSet.has(normalizePath(f))));
  if (owners.length === 0 || owners.length === members.length) return null;
  const ownerIds = new Set(owners.map((o) => o.workspaceId));
  return { owners, innocent: members.filter((m) => !ownerIds.has(m.workspaceId)), suites };
}

/** "landed N, held back #A #B (owners of <suite>)" — the train row's visible summary (#1577). */
export function formatHeldBackSummary(landed: number, held: ReadonlyArray<{ issueNumber?: number | null }>, suites: readonly string[]): string {
  const nums = held.map((h) => (h.issueNumber != null ? `#${h.issueNumber}` : "?")).join(" ");
  return `landed ${landed}, held back ${nums} (owners of ${suites.join(", ")})`;
}

/** The `gateRejected` reason for a member the shortcut named. */
export function formatSuiteOwnerReason(suites: readonly string[], gateFailure: string): string {
  return `failing suite(s) are this branch's own (${suites.join(", ")}); no other train member touched them. ${gateFailure}`;
}

/** Fold the one regate-without-owners (`rest`) into the red root `attempt` (#1577). */
export function combineHeldBackRegate(
  attempt: TrainRunResult,
  rest: TrainRunResult,
  attributed: { owners: TrainMember[]; suites: string[] },
): TrainRunResult {
  const gateRuns = attempt.gateRuns + rest.gateRuns;
  const attempts = [...attempt.attempts, ...rest.attempts];
  if (rest.landed.length === 0) return { ...attempt, gateRuns, attempts };
  const summary = formatHeldBackSummary(rest.landed.length, attributed.owners, attributed.suites);
  return {
    trainRef: attempt.trainRef,
    landed: rest.landed,
    dropped: [...attempt.dropped, ...rest.dropped],
    gateRejected: attributed.owners.map((member) => ({ member, reason: `${summary}; ${attempt.gateFailure ?? ""}`, failedSuites: attributed.suites })),
    sided: rest.sided,
    closeFailures: rest.closeFailures,
    gateRuns,
    attempts,
    mergeSha: rest.mergeSha,
    conflictClusters: dedupeConflictClusters([...(attempt.conflictClusters ?? []), ...(rest.conflictClusters ?? [])]),
    heldBack: { members: attributed.owners.map((m) => m.workspaceId), suites: attributed.suites, summary },
  };
}
