/**
 * What a workspace is doing while its PRE-MERGE GATE runs (#944) — a pure projection over a
 * merge job, so the board card can say "Verifying (attempt 2, 18m)" instead of an amber `idle`
 * dot next to a branch name.
 *
 * Why this is the gap worth closing. The server already tracks the gate richly: every attempt
 * records its source, start, duration, outcome and — for the case #936 exists for — WHY a
 * completed attempt did not land the merge. None of it reached a screen. `merge-status` has no
 * client consumer at all, and `WorkspaceStatus` has no member for "the agent is done and a
 * 30-45 minute test suite is running", so for the entire gate the card renders the same
 * `idle` amber dot it shows for a workspace nobody has touched in a week. The two states that
 * look identical are "working hard" and "abandoned" — which is exactly the confusion #936 was
 * originally MIS-filed on, from the operator side this time.
 *
 * Kept pure and in `shared/lib` (a pure-policy/projection module, per the sub-kind table in
 * this package's CLAUDE.md) because both halves need it and neither may own it: the server
 * projects it onto the board DTO, and the client formats and colours it. A duplicate
 * derivation on the client is how the two would come to disagree about what "stalled" means.
 */

/**
 * The gate phases a card distinguishes. Deliberately coarse — this is a card badge, not the
 * merge-status endpoint, and every extra phase is one more thing an operator has to learn
 * before the badge tells them anything.
 */
export type GateActivityPhase =
  /** A gate attempt is running right now — tests/build in flight. */
  | "verifying"
  /** The merge job is running but no gate attempt is in flight (taking the repo lock, resolving conflicts, gating elsewhere). */
  | "merging"
  /** The job is running, has been silent past {@link GATE_STALL_AFTER_MS}, and has no attempt of its own outstanding. */
  | "stalled";

/**
 * How long a running merge may go with no observed activity before the CARD calls it stalled.
 *
 * Deliberately far below `MERGE_JOB_ZOMBIE_AFTER_MS` (4h), and it means something different.
 * The zombie threshold is a BACKSTOP that *transitions* a job to failed, so it must never fire
 * against something healthy and is therefore set above the largest legitimate gate. This is a
 * DISPLAY hint that changes a colour and nothing else, so it is tuned to when a human would
 * start wondering — a gate whose attempt boundaries have gone quiet for 45 minutes is worth
 * looking at, and being wrong here costs an amber badge rather than a killed merge.
 *
 * Note the asymmetry this creates on purpose: a job with an attempt genuinely in flight is
 * NEVER stalled however long it has been running, because a 40-minute suite is not a stall.
 */
export const GATE_STALL_AFTER_MS = 45 * 60 * 1000;

/** The shape this projection needs from a merge job. Structural, so the server's `MergeJob` fits. */
export interface GateActivitySource {
  state: "running" | "succeeded" | "failed";
  startedAt: string;
  lastActivityAt?: string;
  attemptCount?: number;
  attempts?: Array<{
    attempt: number;
    source: string;
    startedAt: string;
    finishedAt?: string;
    outcome?: "passed" | "failed" | "skipped" | "discarded";
    detail?: string;
    stage?: string;
  }>;
}

/** The card-facing projection of an in-flight gate. */
export interface GateActivity {
  phase: GateActivityPhase;
  /** Short badge text, e.g. `Verifying · attempt 2`. */
  label: string;
  /**
   * The one thing that explains the state, for the tooltip — how long, and what the previous
   * attempt concluded. A discarded attempt's reason surfaces here: that reason previously
   * existed only in the server's process memory.
   */
  detail: string;
  /** Milliseconds since the gate was last observed doing anything. */
  quietMs: number;
  /** Total wall-clock milliseconds this merge job has been running. */
  elapsedMs: number;
  /** 1-based number of the attempt in flight; null when no attempt is running. */
  attempt: number | null;
  /** How many gate attempts this merge has made so far. */
  attemptCount: number;
}

function parseMs(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Compact duration for a badge: `45s`, `18m`, `3h12m`. */
export function formatGateDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.floor(ms / 1000)}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

/**
 * Describe what the LAST finished attempt concluded, when that explains the current state.
 *
 * Only `failed` and `discarded` are described. A `passed`/`skipped` predecessor followed by
 * another attempt is the ordinary retry path and adds nothing to a badge; a discarded one is
 * the #936 case where a full suite ran and its verdict went nowhere, which is precisely what
 * an operator is missing when they see attempt 2 start.
 */
function describePreviousAttempt(source: GateActivitySource): string | null {
  const attempts = source.attempts ?? [];
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const attempt = attempts[i];
    if (!attempt?.finishedAt) continue;
    if (attempt.outcome !== "failed" && attempt.outcome !== "discarded") return null;
    const reason = attempt.detail ? `: ${attempt.detail}` : "";
    return `attempt ${attempt.attempt} ${attempt.outcome}${reason}`;
  }
  return null;
}

/**
 * Project a merge job onto the card state, or `null` when there is nothing to show.
 *
 * A FINISHED job returns null on purpose: the board already renders the outcome of a finished
 * merge (a merged/closed workspace, or a merge error on the workspace card), and a badge that
 * lingered after the fact would compete with those and go stale as soon as the process evicted
 * the job. This projection is strictly about work in flight.
 */
export function deriveGateActivity(
  source: GateActivitySource | null | undefined,
  nowMs: number = Date.now(),
): GateActivity | null {
  if (!source || source.state !== "running") return null;

  const startedMs = parseMs(source.startedAt, nowMs);
  const lastActivityMs = parseMs(source.lastActivityAt, startedMs);
  const elapsedMs = Math.max(0, nowMs - startedMs);
  const quietMs = Math.max(0, nowMs - lastActivityMs);

  const attempts = source.attempts ?? [];
  const attemptCount = source.attemptCount ?? attempts.length;
  const inFlight = attempts.find((a) => !a.finishedAt) ?? null;
  const previous = describePreviousAttempt(source);

  if (inFlight) {
    const runningMs = Math.max(0, nowMs - parseMs(inFlight.startedAt, nowMs));
    const attemptLabel = attemptCount > 1 ? ` · attempt ${inFlight.attempt}` : "";
    return {
      phase: "verifying",
      label: `Verifying${attemptLabel} · ${formatGateDuration(runningMs)}`,
      detail:
        `Pre-merge gate attempt ${inFlight.attempt} (${inFlight.source}) has been running for `
        + `${formatGateDuration(runningMs)}; the merge started ${formatGateDuration(elapsedMs)} ago.`
        + (previous ? ` Previously: ${previous}.` : ""),
      quietMs,
      elapsedMs,
      attempt: inFlight.attempt,
      attemptCount,
    };
  }

  // No attempt of its own in flight. Past the display threshold this is worth flagging; below
  // it, it is the ordinary gap between merge start and the gate taking the build semaphore.
  if (quietMs >= GATE_STALL_AFTER_MS) {
    return {
      phase: "stalled",
      label: `Merge quiet · ${formatGateDuration(quietMs)}`,
      detail:
        `This merge has been running for ${formatGateDuration(elapsedMs)} with no gate attempt in `
        + `flight and nothing observed for ${formatGateDuration(quietMs)}. It may be waiting on the `
        + `repo lock or the build semaphore, or it may be wedged — check the merge status.`
        + (previous ? ` Last attempt: ${previous}.` : ""),
      quietMs,
      elapsedMs,
      attempt: null,
      attemptCount,
    };
  }

  return {
    phase: "merging",
    label: `Merging · ${formatGateDuration(elapsedMs)}`,
    detail:
      attemptCount === 0
        ? `Merge started ${formatGateDuration(elapsedMs)} ago; no gate attempt has begun yet `
          + `(taking the repo lock, resolving conflicts, or waiting for the build semaphore).`
        : `Merge started ${formatGateDuration(elapsedMs)} ago; ${attemptCount} gate attempt(s) made, `
          + `none in flight right now.`
          + (previous ? ` Last attempt: ${previous}.` : ""),
    quietMs,
    elapsedMs,
    attempt: null,
    attemptCount,
  };
}
