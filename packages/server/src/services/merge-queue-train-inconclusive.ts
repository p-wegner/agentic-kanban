/**
 * Inconclusive-gate handling and the red-gate log line for the release train (#1413), split out
 * of `merge-queue-train.ts` to keep it under the 1000-line god-module ceiling.
 */
import type { MergeQueueEvent } from "./merge-queue.service.js";
import { describeFailedSuites } from "./verify-failed-suites.js";

/** A watchdog kill / timeout / held run is inconclusive, not red — nothing for a fix agent to fix. */
export function isInconclusiveGate(gate: { passed: boolean; timedOut?: boolean; held?: boolean }): boolean {
  return !gate.passed && (gate.timedOut === true || gate.held === true);
}

export function describeInconclusiveGate(label: string, attemptLabel: string, message: string): string {
  return `[merge-train] ${label}: gate INCONCLUSIVE (${attemptLabel}) - not red, no fix agent, no bisect; will re-gate later: ${message.slice(0, 200)}`;
}

/**
 * The persisted final-state fields. An inconclusive gate is not a red train — it is closed out
 * `abandoned` (no active row, so the next window re-forms and re-gates the same members) with
 * the reason on record.
 */
export function finalTrainStateFields(result: { landed: readonly unknown[]; inconclusive?: boolean; gateFailure?: string | null }) {
  const inconclusive = result.landed.length === 0 && result.inconclusive === true;
  return {
    state: result.landed.length > 0 ? ("landed" as const) : inconclusive ? ("abandoned" as const) : ("red" as const),
    ...(inconclusive ? { reconciledReason: `gate inconclusive, will be retried: ${(result.gateFailure ?? "").slice(0, 300)}` } : {}),
  };
}

/** Nothing was judged — every member is merely withheld pending a retry, not failed. */
export function* inconclusiveSkipEvents(
  members: ReadonlyArray<{ workspaceId: string; issueNumber?: number | null }>,
  seenEvent: ReadonlySet<string>,
  gateFailure: string | null | undefined,
): Generator<MergeQueueEvent> {
  for (const m of members) {
    if (seenEvent.has(m.workspaceId)) continue;
    yield { type: "skipped", workspaceId: m.workspaceId, issueNumber: m.issueNumber ?? null, issueTitle: "", reason: `train gate inconclusive - pending a retry: ${(gateFailure ?? "").slice(0, 200)}` };
  }
}

/**
 * The ONE line the board log gets when a train's gate goes red (pure). MEASURED motivation:
 * `train/2026-09-26-01` went red and bisected with no line naming the failing suites — the only
 * trace was the control arm's `gated the bare base … - green` later. The per-branch path already
 * names suites (`describeVerifyFailedSkip`); this is the train's equivalent, in the same
 * `failing suite(s): …` vocabulary, for the whole train and for each bisect half.
 */
export function describeTrainGateRed(args: {
  label: string;
  attemptLabel: string;
  members: ReadonlyArray<{ workspaceId: string; issueNumber?: number | null }>;
  stage?: string;
  failedSuites?: readonly string[];
  guardFailure?: boolean;
  message: string;
}): string {
  const scope = args.attemptLabel === args.label ? "whole train" : `bisect attempt ${args.attemptLabel}`;
  const who = args.members.map((m) => (m.issueNumber != null ? `#${m.issueNumber}` : m.workspaceId.slice(0, 8))).join(", ") || "no members";
  const named = describeFailedSuites({ files: args.failedSuites ?? [], guardFailure: args.guardFailure === true });
  const firstLine = args.message.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "no gate output";
  const what = named || `no failing suite could be named; ${firstLine.slice(0, 200)}`;
  return `${args.label}: train gate RED (${scope}, ${args.members.length} member(s): ${who}) - stage ${args.stage ?? "unknown"} - ${what}`;
}

