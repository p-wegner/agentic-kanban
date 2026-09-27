import type { TrainMember } from "./merge-train-assembly.js";

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

/** The `gateRejected` reason for a member the shortcut named. */
export function formatSuiteOwnerReason(suites: readonly string[], gateFailure: string): string {
  return `failing suite(s) are this branch's own (${suites.join(", ")}); no other train member touched them. ${gateFailure}`;
}
