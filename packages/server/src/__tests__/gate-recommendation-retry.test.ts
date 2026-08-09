/**
 * #367 — a gate whose recommendation attempt failed once must get another.
 *
 * MEASURED symptom: linklocker sat at gate `step-2:v1` for 23 hours with `gateRecommendation:
 * null`. `computeGateRecommendation` was called from exactly one place, inside
 * `if (plan.gate && plan.gate.id !== priorGate?.id)`, so it fired once per new gate id — no retry,
 * no backfill, no re-trigger. That gate's transition (04:32:46Z) also predated the #333 skip-trace
 * commit (06:38:18Z) by 2h06m, so the single attempt bailed out with no `gate-recommendation-skipped`
 * event either: 350 further advances, no evidence, no chip. Approving the gate produced a populated
 * recommendation for the next gate immediately, proving the path itself was healthy.
 *
 * The retry must not become the opposite bug. A blocked loop re-plans on EVERY monitor cycle, so an
 * unconditional "retry when missing" would be an LLM ask per cycle for as long as a human ignores a
 * gate — hence the backoff, the ceiling, and the in-flight guard tested below.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { insertPluginLoopEvent, type LoopEventKey } from "../repositories/plugin-loop-events.repository.js";
import {
  beginGateRecommendationAttempt,
  decideGateRecommendationRetry,
  endGateRecommendationAttempt,
  resetGateRecommendationAttempts,
  shouldRetryGateRecommendation,
  GATE_RECOMMENDATION_MAX_ATTEMPTS,
  GATE_RECOMMENDATION_RETRY_DELAYS_MS,
} from "../services/gate-recommendation-retry.js";

const NOW = "2026-08-09T12:00:00.000Z";
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

function facts(overrides: Partial<Parameters<typeof decideGateRecommendationRetry>[0]> = {}) {
  return {
    hasRecommendation: false,
    attempts: 0,
    lastAttemptAt: null,
    gateReachedAt: ago(24 * 60 * 60_000),
    nowIso: NOW,
    ...overrides,
  };
}

describe("#367 retry policy (pure)", () => {
  it("retries a gate that has been open for hours with no recommendation and no recorded attempt", () => {
    // This is linklocker exactly: the one attempt predated the skip-trace, so the gate's own age is
    // the only clock available.
    expect(decideGateRecommendationRetry(facts())).toEqual({ retry: true, attemptNumber: 1 });
  });

  it("never retries a gate that already has a recommendation", () => {
    expect(decideGateRecommendationRetry(facts({ hasRecommendation: true })))
      .toEqual({ retry: false, reason: "already-recommended" });
  });

  it("does not retry within the backoff window — a blocked loop advances every cycle", () => {
    expect(decideGateRecommendationRetry(facts({ gateReachedAt: ago(60_000) })))
      .toEqual({ retry: false, reason: "backoff" });
    expect(decideGateRecommendationRetry(facts({ attempts: 1, lastAttemptAt: ago(60_000) })))
      .toEqual({ retry: false, reason: "backoff" });
  });

  it("the shortest delay exceeds the butler ask timeout, so a retry cannot race the first attempt", () => {
    // `oneShotButlerAsk` is given 60s. A delay under that would let the retry fire while the
    // original fire-and-forget attempt is still waiting on its reply.
    expect(GATE_RECOMMENDATION_RETRY_DELAYS_MS[0]).toBeGreaterThan(60_000);
  });

  it("widens the delay as attempts accumulate", () => {
    for (let attempts = 0; attempts < GATE_RECOMMENDATION_MAX_ATTEMPTS; attempts++) {
      const delay = GATE_RECOMMENDATION_RETRY_DELAYS_MS[attempts];
      expect(decideGateRecommendationRetry(facts({ attempts, lastAttemptAt: ago(delay - 1_000) })))
        .toMatchObject({ retry: false, reason: "backoff" });
      expect(decideGateRecommendationRetry(facts({ attempts, lastAttemptAt: ago(delay + 1_000) })))
        .toMatchObject({ retry: true, attemptNumber: attempts + 1 });
    }
    expect(GATE_RECOMMENDATION_RETRY_DELAYS_MS.every((d, i) => i === 0 || d > GATE_RECOMMENDATION_RETRY_DELAYS_MS[i - 1])).toBe(true);
  });

  it("stops at the ceiling instead of asking forever", () => {
    expect(decideGateRecommendationRetry(facts({
      attempts: GATE_RECOMMENDATION_MAX_ATTEMPTS,
      lastAttemptAt: ago(365 * 24 * 60 * 60_000),
    }))).toEqual({ retry: false, reason: "attempts-exhausted" });
  });

  it("declines when there is no clock at all rather than retrying blind on every advance", () => {
    expect(decideGateRecommendationRetry(facts({ gateReachedAt: null })))
      .toEqual({ retry: false, reason: "no-anchor" });
    expect(decideGateRecommendationRetry(facts({ gateReachedAt: "not a date" })))
      .toEqual({ retry: false, reason: "no-anchor" });
  });
});

describe("#367 retry decision read from the real timeline", () => {
  let db: Database;
  let key: LoopEventKey;

  beforeEach(() => {
    db = createTestDb().db as unknown as Database;
    key = { pluginSlug: "pm-pipeline", loopName: "pipeline", projectId: randomUUID() };
    resetGateRecommendationAttempts();
  });

  it("retries the linklocker shape: gate-reached long ago, no recommendation, no skip event", async () => {
    await insertPluginLoopEvent(key, "gate-reached", { gateId: "step-2:v1" }, db);
    const decision = await shouldRetryGateRecommendation(key, "step-2:v1", NOW, db);
    expect(decision).toMatchObject({ retry: true });
  });

  it("does not retry once a recommendation for that gate exists", async () => {
    await insertPluginLoopEvent(key, "gate-reached", { gateId: "step-2:v1" }, db);
    await insertPluginLoopEvent(key, "gate-recommendation", { gateId: "step-2:v1", actionId: "approve", reason: "ok" }, db);
    expect(await shouldRetryGateRecommendation(key, "step-2:v1", NOW, db))
      .toEqual({ retry: false, reason: "already-recommended" });
  });

  it("a recommendation for a DIFFERENT gate does not satisfy this gate", async () => {
    // The chip is per gate id; an older gate's recommendation must not suppress this gate's retry.
    await insertPluginLoopEvent(key, "gate-reached", { gateId: "step-3:v1" }, db);
    await insertPluginLoopEvent(key, "gate-recommendation", { gateId: "step-2:v1", actionId: "approve", reason: "ok" }, db);
    expect(await shouldRetryGateRecommendation(key, "step-3:v1", NOW, db)).toMatchObject({ retry: true });
  });

  it("counts only this gate's skip events towards the ceiling", async () => {
    await insertPluginLoopEvent(key, "gate-reached", { gateId: "step-3:v1" }, db);
    for (let i = 0; i < GATE_RECOMMENDATION_MAX_ATTEMPTS; i++) {
      await insertPluginLoopEvent(key, "gate-recommendation-skipped", { gateId: "step-2:v1", reason: "auth-failed" }, db);
    }
    // All the recorded failures belong to the previous gate, so this one is still on attempt 1.
    expect(await shouldRetryGateRecommendation(key, "step-3:v1", NOW, db)).toMatchObject({ retry: true });
  });

  it("stops retrying a gate that has burned its attempts", async () => {
    await insertPluginLoopEvent(key, "gate-reached", { gateId: "step-2:v1" }, db);
    for (let i = 0; i < GATE_RECOMMENDATION_MAX_ATTEMPTS; i++) {
      await insertPluginLoopEvent(key, "gate-recommendation-skipped", { gateId: "step-2:v1", reason: "auth-failed" }, db);
    }
    expect(await shouldRetryGateRecommendation(key, "step-2:v1", NOW, db))
      .toEqual({ retry: false, reason: "attempts-exhausted" });
  });

  it("a just-recorded attempt holds the retry off", async () => {
    await insertPluginLoopEvent(key, "gate-reached", { gateId: "step-2:v1" }, db);
    await insertPluginLoopEvent(key, "gate-recommendation-skipped", { gateId: "step-2:v1", reason: "ask-failed" }, db);
    // `now` is the insert's own clock, so the newest attempt is seconds old.
    expect(await shouldRetryGateRecommendation(key, "step-2:v1", undefined, db))
      .toEqual({ retry: false, reason: "backoff" });
  });

  it("survives a malformed event payload instead of throwing out of the advance", async () => {
    await insertPluginLoopEvent(key, "gate-reached", { gateId: "step-2:v1" }, db);
    await insertPluginLoopEvent(key, "gate-recommendation", "not-an-object" as unknown, db);
    expect(await shouldRetryGateRecommendation(key, "step-2:v1", NOW, db)).toMatchObject({ retry: true });
  });
});

describe("#367 in-flight guard", () => {
  beforeEach(() => resetGateRecommendationAttempts());
  const key: LoopEventKey = { pluginSlug: "pm-pipeline", loopName: "pipeline", projectId: "p1" };

  it("lets only one attempt per gate run at a time", () => {
    expect(beginGateRecommendationAttempt(key, "step-2:v1")).toBe(true);
    // Cycles have been measured running back-to-back on this board, and the ask takes up to 60s —
    // so a second advance inside that window is the normal case, not an edge one.
    expect(beginGateRecommendationAttempt(key, "step-2:v1")).toBe(false);
    endGateRecommendationAttempt(key, "step-2:v1");
    expect(beginGateRecommendationAttempt(key, "step-2:v1")).toBe(true);
  });

  it("does not block a different gate or a different loop", () => {
    expect(beginGateRecommendationAttempt(key, "step-2:v1")).toBe(true);
    expect(beginGateRecommendationAttempt(key, "step-3:v1")).toBe(true);
    expect(beginGateRecommendationAttempt({ ...key, loopName: "other" }, "step-2:v1")).toBe(true);
  });
});
