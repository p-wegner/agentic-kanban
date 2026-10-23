/**
 * #1679 — a train the reconciler abandoned because its gate ran too long (the hard ceiling) must
 * not be re-assembled into an IDENTICAL gate: the next window would cover the same scope, run as
 * long and be abandoned again. Instead the next train takes half the members; the rest wait for
 * the following window. A single member cannot be split, so that case escalates to the operator.
 *
 * Pure over the member list and the project's recent train rows.
 */
import type { MergeTrainRow } from "../repositories/merge-train.repository.js";

/** Substring of the reconciler's reason when a gate was abandoned for its age (ceiling), not for lack of progress. */
export const GATE_AGE_ABANDON_MARKER = "gate-age-ceiling";

export type AgeSplitDecision =
  | { action: "none" }
  | { action: "split"; members: string[]; deferred: string[]; reason: string }
  | { action: "escalate"; reason: string };

function parseMembers(row: Pick<MergeTrainRow, "memberWorkspaceIds">): string[] {
  try {
    const parsed = JSON.parse(row.memberWorkspaceIds) as unknown;
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

export function decideAgeAbandonSplit(
  members: string[],
  recentTrains: Pick<MergeTrainRow, "state" | "reconciledReason" | "memberWorkspaceIds">[],
  projectLabel = "<project>",
): AgeSplitDecision {
  // recentTrains is newest first: only the most recent finished train matters.
  const last = recentTrains.find((t) => t.state !== "assembling" && t.state !== "gating");
  if (!last || last.state !== "abandoned" || !last.reconciledReason?.includes(GATE_AGE_ABANDON_MARKER)) return { action: "none" };
  const prior = new Set(parseMembers(last));
  if (members.length === 0 || !members.every((m) => prior.has(m))) return { action: "none" };
  if (members.length === 1) {
    return {
      action: "escalate",
      reason: `a single-member train was already abandoned for gate age - splitting cannot help; run it on a worker: train land-local --on-worker (${projectLabel})`,
    };
  }
  const keep = Math.ceil(members.length / 2);
  return {
    action: "split",
    members: members.slice(0, keep),
    deferred: members.slice(keep),
    reason: `the previous train over the same members was abandoned for gate age - gating ${keep} of ${members.length} now, the rest wait for the next window`,
  };
}
