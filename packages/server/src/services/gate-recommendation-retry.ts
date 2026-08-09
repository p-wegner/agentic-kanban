/**
 * Should a gate that has no pre-read recommendation get another attempt? (#367)
 *
 * ── The defect this exists for ──
 *
 * `computeGateRecommendation` was called from exactly ONE place, inside
 * `if (plan.gate && plan.gate.id !== priorGate?.id)` — i.e. once per new gate id, with no retry,
 * no backfill and no manual re-trigger. So a single transient failure cost that gate its chip for
 * as long as the human took to decide.
 *
 * MEASURED: linklocker sat at gate `step-2:v1` for 23 HOURS with `gateRecommendation: null` while
 * two sibling projects had populated ones. Its gate-2 transition (2026-08-08T04:32:46Z) predated
 * the #333 skip-trace commit (06:38:18Z) by 2h06m, so the one attempt bailed out SILENTLY — no
 * recommendation and no `gate-recommendation-skipped` event either. 350 subsequent `advance` events
 * never retried. Approving that gate produced a populated recommendation for the NEXT gate
 * immediately, which proves the path was healthy and the null was frozen state.
 *
 * The failure modes are ordinary and transient — measured on this board: "Not logged in ·
 * Please run /login", "There's an issue with the selected model", usage limits. None of them is a
 * reason to give up permanently.
 *
 * ── Why a policy module and not an `if` at the call site ──
 *
 * A blocked loop re-plans on EVERY monitor cycle, so "retry when missing" without a rate limit
 * would fire an LLM ask per cycle for as long as a human ignores a gate. That is the opposite
 * failure. The decision therefore needs a clock, an attempt count and a ceiling — enough logic to
 * be worth testing on its own, without a database or a butler.
 *
 * The pure `decideGateRecommendationRetry` holds the whole policy; the async wrapper only supplies
 * it with facts from the timeline.
 */
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import {
  latestPluginLoopEvent,
  listPluginLoopEventsOfType,
  type LoopEventKey,
} from "../repositories/plugin-loop-events.repository.js";

/**
 * Delay before attempt N+1, indexed by attempts already made. Front-loaded: the common case is a
 * transient provider error that clears in minutes, and a gate is most useful to a human early.
 * The tail is long so an ignored gate cannot turn into an LLM-ask heartbeat.
 */
export const GATE_RECOMMENDATION_RETRY_DELAYS_MS = [
  5 * 60_000,
  15 * 60_000,
  45 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
];

/** Hard ceiling on attempts per gate id, including the original one-shot. */
export const GATE_RECOMMENDATION_MAX_ATTEMPTS = GATE_RECOMMENDATION_RETRY_DELAYS_MS.length;

export interface GateRecommendationRetryFacts {
  /** A `gate-recommendation` event already exists for THIS gate id. */
  hasRecommendation: boolean;
  /** Recorded `gate-recommendation-skipped` events for this gate id. */
  attempts: number;
  /** When the newest recorded attempt happened — null when none was ever recorded. */
  lastAttemptAt: string | null;
  /** When this gate was reached (`gate-reached`) — the anchor when no attempt was recorded. */
  gateReachedAt: string | null;
  nowIso: string;
}

export type GateRecommendationRetryDecision =
  | { retry: true; attemptNumber: number }
  | { retry: false; reason: "already-recommended" | "attempts-exhausted" | "backoff" | "no-anchor" };

/**
 * The whole retry policy, as a pure function.
 *
 * The `lastAttemptAt === null` branch is the one that would have fixed linklocker: a gate whose
 * only attempt predates the skip-trace left NO evidence at all, so the age of the GATE is the only
 * available clock. Anchoring on `gate-reached` also means the first retry cannot race the original
 * fire-and-forget attempt, which has a 60s butler timeout — the shortest delay is 5 minutes.
 */
export function decideGateRecommendationRetry(facts: GateRecommendationRetryFacts): GateRecommendationRetryDecision {
  if (facts.hasRecommendation) return { retry: false, reason: "already-recommended" };
  if (facts.attempts >= GATE_RECOMMENDATION_MAX_ATTEMPTS) return { retry: false, reason: "attempts-exhausted" };

  const anchor = facts.lastAttemptAt ?? facts.gateReachedAt;
  // No clock at all (events pruned, or a gate that predates the timeline). Retrying blind would
  // mean retrying on every advance, which is the failure this module exists to avoid.
  if (!anchor) return { retry: false, reason: "no-anchor" };

  const elapsed = Date.parse(facts.nowIso) - Date.parse(anchor);
  if (!Number.isFinite(elapsed)) return { retry: false, reason: "no-anchor" };
  const delay = GATE_RECOMMENDATION_RETRY_DELAYS_MS[Math.min(facts.attempts, GATE_RECOMMENDATION_RETRY_DELAYS_MS.length - 1)];
  if (elapsed < delay) return { retry: false, reason: "backoff" };
  return { retry: true, attemptNumber: facts.attempts + 1 };
}

function payloadGateId(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as { gateId?: unknown };
    return typeof parsed.gateId === "string" ? parsed.gateId : null;
  } catch {
    return null;
  }
}

/**
 * Read the timeline facts for one gate id and apply the policy.
 *
 * Three indexed single-type queries, only ever run while a gate is OPEN — deliberately not a scan
 * of the 500-event timeline, because this runs on every advance of a blocked loop and cycle cost
 * on this board is already the subject of its own tickets.
 */
export async function shouldRetryGateRecommendation(
  key: LoopEventKey,
  gateId: string,
  nowIso = new Date().toISOString(),
  database: Database = db,
): Promise<GateRecommendationRetryDecision> {
  const [recoRow, skippedRows, reachedRow] = await Promise.all([
    latestPluginLoopEvent(key, "gate-recommendation", database),
    listPluginLoopEventsOfType(key, "gate-recommendation-skipped", GATE_RECOMMENDATION_MAX_ATTEMPTS * 4, database),
    latestPluginLoopEvent(key, "gate-reached", database),
  ]);

  const forThisGate = skippedRows.filter((r) => payloadGateId(r.payloadJson) === gateId);
  const reached = payloadGateId(reachedRow?.payloadJson ?? null) === gateId ? reachedRow : null;

  return decideGateRecommendationRetry({
    hasRecommendation: payloadGateId(recoRow?.payloadJson ?? null) === gateId,
    attempts: forThisGate.length,
    // Rows come back newest-first.
    lastAttemptAt: forThisGate[0]?.createdAt ?? null,
    gateReachedAt: reached?.createdAt ?? null,
    nowIso,
  });
}

/**
 * In-process guard against two overlapping asks for the same gate.
 *
 * A recommendation attempt is fire-and-forget with a 60s butler timeout, and this board's monitor
 * cycles have been measured running back-to-back — so without this, two advances inside one
 * attempt's window would both see "no event yet" and both ask.
 */
const inFlight = new Set<string>();

export function beginGateRecommendationAttempt(key: LoopEventKey, gateId: string): boolean {
  const token = `${key.projectId}::${key.pluginSlug}::${key.loopName}::${gateId}`;
  if (inFlight.has(token)) return false;
  inFlight.add(token);
  return true;
}

export function endGateRecommendationAttempt(key: LoopEventKey, gateId: string): void {
  inFlight.delete(`${key.projectId}::${key.pluginSlug}::${key.loopName}::${gateId}`);
}

/** Test seam. */
export function resetGateRecommendationAttempts(): void {
  inFlight.clear();
}
