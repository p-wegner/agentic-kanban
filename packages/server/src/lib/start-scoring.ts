/**
 * #917 — scored ticket selection for the Todo-pull loop, replacing FIFO
 * `ORDER BY issue_number` (`runTodoPull`, startup/monitor-auto-start.ts).
 *
 * score = priorityWeight * (1 + unblockCount) * ageFactor / predictedCost * bullseyeMultiplier
 *
 * - `priorityWeight`: the issue's priority (critical/high/medium/low) mapped to a fixed
 *   weight — this is what makes a `high` ticket start before a `low` one, all else equal.
 * - `unblockCount`: how many OTHER open issues this one would unblock if it landed
 *   (supplied by the caller, derived from `issueDependencies` — see
 *   `computeUnblockCounts` in `start-scoring.repository.ts`). Multiplying by
 *   `(1 + unblockCount)` means a ticket that unblocks nothing still scores its base
 *   priority/age/cost value rather than zero.
 * - `ageFactor`: grows with how long the issue has sat in a startable status — the
 *   STARVATION GUARD. Without it a high-unblock-count ticket that keeps failing its
 *   dependency gate could permanently outrank a plain ready ticket every cycle; age
 *   compounds until it eventually wins anyway.
 * - `predictedCost`: cheaper tickets score higher for the same priority/unblock/age —
 *   absent (no stored estimate) defaults to 1, i.e. neutral.
 * - `bullseyeMultiplier`: the Strategy Bullseye's per-segment weight for a matching
 *   work-type/area segment (>= 1), else 1 (no matching segment = no adjustment).
 *
 * Pure and synchronous — no DB, no Node builtins — so it is unit-testable in isolation
 * and safe to call once per candidate per cycle without any I/O of its own.
 */
import type { IssuePriority } from "@agentic-kanban/shared/lib/issue-priority";
import type { StrategyBullseyeSegment } from "@agentic-kanban/shared/lib/strategy-objective-file";

/** Fixed points per priority level. Ordering matches the canonical `ISSUE_PRIORITIES` scale. */
export const PRIORITY_WEIGHTS: Record<IssuePriority, number> = {
  critical: 8,
  high: 4,
  medium: 2,
  low: 1,
};

/**
 * Age (in hours) at which the starvation guard's multiplier has doubled the ticket's
 * base score. Chosen so a ticket stuck for about a day (24h) has meaningfully grown
 * (+50%) without the age term swamping priority/unblock for a ticket that is merely a
 * few cycles old.
 */
const AGE_HALF_LIFE_HOURS = 24;

export interface StartScoreComponents {
  priority: IssuePriority;
  priorityWeight: number;
  unblockCount: number;
  ageHours: number;
  ageFactor: number;
  predictedCost: number;
  bullseyeMultiplier: number;
  bullseyeSegmentId: string | null;
}

export interface StartScoreResult extends StartScoreComponents {
  score: number;
}

/**
 * `ageFactor = 1 + ageHours / AGE_HALF_LIFE_HOURS` — linear rather than exponential so a
 * ticket ancient by an order of magnitude (weeks old) does not produce a score that
 * dwarfs every priority/cost signal; it grows steadily instead, which is all the
 * starvation guard needs (eventually every ready ticket outranks a repeatedly-retried
 * blocked one, without priority ceasing to matter for tickets of comparable age).
 */
function computeAgeFactor(ageHours: number): number {
  return 1 + Math.max(0, ageHours) / AGE_HALF_LIFE_HOURS;
}

export function computeStartScore(input: {
  priority: IssuePriority;
  unblockCount: number;
  ageHours: number;
  /** Absent/non-positive cost defaults to 1 (neutral — no cost signal). */
  predictedCost?: number | null;
  bullseyeMultiplier?: number | null;
  bullseyeSegmentId?: string | null;
}): StartScoreResult {
  const priorityWeight = PRIORITY_WEIGHTS[input.priority] ?? PRIORITY_WEIGHTS.medium;
  const unblockCount = Math.max(0, Math.trunc(input.unblockCount));
  const ageHours = Math.max(0, input.ageHours);
  const ageFactor = computeAgeFactor(ageHours);
  const predictedCost = input.predictedCost != null && input.predictedCost > 0 ? input.predictedCost : 1;
  const bullseyeMultiplier = input.bullseyeMultiplier != null && input.bullseyeMultiplier > 0 ? input.bullseyeMultiplier : 1;

  const score = (priorityWeight * (1 + unblockCount) * ageFactor * bullseyeMultiplier) / predictedCost;

  return {
    priority: input.priority,
    priorityWeight,
    unblockCount,
    ageHours,
    ageFactor,
    predictedCost,
    bullseyeMultiplier,
    bullseyeSegmentId: input.bullseyeSegmentId ?? null,
    score,
  };
}

/** Hours between two ISO timestamps (`from` earlier than `now`), floored at 0. */
export function hoursSince(from: string | null | undefined, nowMs: number): number {
  if (!from) return 0;
  const fromMs = Date.parse(from);
  if (!Number.isFinite(fromMs)) return 0;
  return Math.max(0, (nowMs - fromMs) / (1000 * 60 * 60));
}

/**
 * Pick the highest-weight Bullseye segment (`work-type` or `area` kind) whose keywords
 * match the issue's title/description/type, and return its weight (1-5, per
 * `segmentWeight` in `strategy-objective-file.ts`) as the score multiplier.
 *
 * Only `work-type`/`area` segments participate — `provider` and `custom` segments steer
 * other decisions (which agent launches, free-text notes) and have no bearing on WHICH
 * ticket to start next. A segment's `weight` (default 3, clamped 1-5) becomes the
 * multiplier directly: an unweighted/default segment (3) is a mild boost over the
 * neutral 1, matching how `segmentWeight` already treats an unset weight as "middling",
 * not "no preference".
 *
 * Returns `{ multiplier: 1, segmentId: null }` when no segment matches — the neutral
 * case, so an issue matching no Bullseye focus is scored purely on
 * priority/unblock/age/cost.
 */
export function matchBullseyeSegment(
  issue: { title: string; description?: string | null; issueType?: string | null },
  segments: readonly StrategyBullseyeSegment[],
): { multiplier: number; segmentId: string | null } {
  const haystack = `${issue.title} ${issue.description ?? ""} ${issue.issueType ?? ""}`.toLowerCase();
  let best: { weight: number; id: string } | null = null;
  for (const segment of segments) {
    if (segment.kind !== "work-type" && segment.kind !== "area") continue;
    const keywords = (segment.keywords ?? "")
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (keywords.length === 0) continue;
    if (!keywords.some((k) => haystack.includes(k))) continue;
    const weight = segment.weight != null && segment.weight > 0 ? segment.weight : 3;
    if (!best || weight > best.weight) best = { weight, id: segment.id };
  }
  return best ? { multiplier: best.weight, segmentId: best.id } : { multiplier: 1, segmentId: null };
}
