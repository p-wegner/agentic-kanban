import { describe, expect, it } from "vitest";
import type { QueuePressureSummary } from "@agentic-kanban/shared/types";
import {
  checkQueueFlushRails,
  DEFAULT_QUEUE_FLUSH_DAILY_CAP,
  evaluateQueueFlushThresholds,
  formatQueueFlushDryRun,
  isDailyCapReached,
  NEVER_TRIGGER_THRESHOLDS,
  parseQueueFlushDailyCap,
  parseQueueFlushMode,
  parseQueueFlushThresholds,
  supersedesInFlight,
} from "../services/queue-flush-trigger.service.js";

/**
 * #1248, decision 020 part 3 — the flush trigger's pure decision layer: pref parsing
 * (fail-closed), threshold evaluation, daily cap, supersede path, CLI dry-run text.
 */

describe("parseQueueFlushMode (#1248) — fail closed", () => {
  it("accepts manual and auto", () => {
    expect(parseQueueFlushMode("manual")).toBe("manual");
    expect(parseQueueFlushMode("auto")).toBe("auto");
  });

  it("defaults to off, and any unparseable value fails CLOSED to off", () => {
    expect(parseQueueFlushMode(null)).toBe("off");
    expect(parseQueueFlushMode(undefined)).toBe("off");
    expect(parseQueueFlushMode("")).toBe("off");
    expect(parseQueueFlushMode("bogus")).toBe("off");
    expect(parseQueueFlushMode("ON")).toBe("off");
  });
});

describe("parseQueueFlushThresholds (#1248) — fail closed to NEVER_TRIGGER", () => {
  it("parses a well-formed JSON object", () => {
    const thresholds = parseQueueFlushThresholds(
      JSON.stringify({ minWaiting: 5, maxOldestAgeMinutes: 60, arrivalsPerGateRatio: 2 }),
    );
    expect(thresholds).toEqual({ minWaiting: 5, maxOldestAgeMinutes: 60, arrivalsPerGateRatio: 2 });
  });

  it("unset, unparseable JSON, wrong shape, or a negative/non-finite field all fail closed", () => {
    expect(parseQueueFlushThresholds(null)).toEqual(NEVER_TRIGGER_THRESHOLDS);
    expect(parseQueueFlushThresholds("")).toEqual(NEVER_TRIGGER_THRESHOLDS);
    expect(parseQueueFlushThresholds("not json")).toEqual(NEVER_TRIGGER_THRESHOLDS);
    expect(parseQueueFlushThresholds("[]")).toEqual(NEVER_TRIGGER_THRESHOLDS);
    expect(parseQueueFlushThresholds(JSON.stringify({ minWaiting: 5 }))).toEqual(NEVER_TRIGGER_THRESHOLDS);
    expect(parseQueueFlushThresholds(JSON.stringify({ minWaiting: -1, maxOldestAgeMinutes: 1, arrivalsPerGateRatio: 1 }))).toEqual(NEVER_TRIGGER_THRESHOLDS);
    expect(parseQueueFlushThresholds(JSON.stringify({ minWaiting: "5", maxOldestAgeMinutes: 1, arrivalsPerGateRatio: 1 }))).toEqual(NEVER_TRIGGER_THRESHOLDS);
  });
});

// ── threshold evaluation table ──────────────────────────────────────────────────────────

const summary = (partial: Partial<QueuePressureSummary>): QueuePressureSummary => ({
  queueDepth: 0,
  oldestWaitingMs: null,
  arrivalsPerHour: 0,
  gateRunsPerHour: 0,
  windowMs: 60 * 60 * 1000,
  ...partial,
});

describe("evaluateQueueFlushThresholds (#1248) — any ONE threshold met is enough", () => {
  const thresholds = { minWaiting: 5, maxOldestAgeMinutes: 30, arrivalsPerGateRatio: 2 };

  it.each([
    ["depth alone", summary({ queueDepth: 5 }), true, ["minWaiting"]],
    ["depth below threshold", summary({ queueDepth: 4 }), false, []],
    ["age alone", summary({ oldestWaitingMs: 31 * 60_000 }), true, ["maxOldestAgeMinutes"]],
    ["age below threshold", summary({ oldestWaitingMs: 29 * 60_000 }), false, []],
    ["ratio alone", summary({ arrivalsPerHour: 4, gateRunsPerHour: 1 }), true, ["arrivalsPerGateRatio"]],
    ["ratio below threshold", summary({ arrivalsPerHour: 1, gateRunsPerHour: 1 }), false, []],
    ["arrivals with a stalled gate (0 gate-runs) — infinite ratio counts as met", summary({ arrivalsPerHour: 1, gateRunsPerHour: 0 }), true, ["arrivalsPerGateRatio"]],
    ["nothing arriving and nothing gating — 0/0 does not trigger", summary({ arrivalsPerHour: 0, gateRunsPerHour: 0 }), false, []],
    ["all three at once", summary({ queueDepth: 9, oldestWaitingMs: 90 * 60_000, arrivalsPerHour: 10, gateRunsPerHour: 1 }), true, ["minWaiting", "maxOldestAgeMinutes", "arrivalsPerGateRatio"]],
  ] as const)("%s", (_label, s, met, metBy) => {
    const result = evaluateQueueFlushThresholds(s, thresholds);
    expect(result.met).toBe(met);
    expect(result.metBy).toEqual(metBy);
  });
});

// ── daily cap ────────────────────────────────────────────────────────────────────────────

describe("parseQueueFlushDailyCap / isDailyCapReached (#1248)", () => {
  it("defaults to 2 on unset or a bad value", () => {
    expect(parseQueueFlushDailyCap(null)).toBe(DEFAULT_QUEUE_FLUSH_DAILY_CAP);
    expect(parseQueueFlushDailyCap("")).toBe(DEFAULT_QUEUE_FLUSH_DAILY_CAP);
    expect(parseQueueFlushDailyCap("0")).toBe(DEFAULT_QUEUE_FLUSH_DAILY_CAP);
    expect(parseQueueFlushDailyCap("-1")).toBe(DEFAULT_QUEUE_FLUSH_DAILY_CAP);
    expect(parseQueueFlushDailyCap("nope")).toBe(DEFAULT_QUEUE_FLUSH_DAILY_CAP);
  });

  it("parses a positive integer", () => {
    expect(parseQueueFlushDailyCap("5")).toBe(5);
  });

  it("counts only TODAY's flushes against the cap", () => {
    const now = "2026-09-26T12:00:00.000Z";
    expect(isDailyCapReached(["2026-09-26T01:00:00.000Z"], 2, now)).toBe(false);
    expect(isDailyCapReached(["2026-09-26T01:00:00.000Z", "2026-09-26T02:00:00.000Z"], 2, now)).toBe(true);
    // Yesterday's flushes don't count against today's cap.
    expect(isDailyCapReached(["2026-09-25T23:59:00.000Z", "2026-09-25T23:58:00.000Z"], 2, now)).toBe(false);
  });
});

// ── supersede path ───────────────────────────────────────────────────────────────────────

describe("supersedesInFlight (#1248) — a flush while the previous is red is ALLOWED, superseding it", () => {
  it("only a red previous flush supersedes", () => {
    expect(supersedesInFlight("red")).toBe(true);
    expect(supersedesInFlight("sweeping")).toBe(false);
    expect(supersedesInFlight("healed")).toBe(false);
    expect(supersedesInFlight(null)).toBe(false);
  });
});

// ── rails: off / posture / cap / promotion-in-flight ─────────────────────────────────────

describe("checkQueueFlushRails (#1248)", () => {
  const now = "2026-09-26T12:00:00.000Z";

  it("refuses when mode is off", () => {
    const refusal = checkQueueFlushRails({ mode: "off", posture: "flow", flushTimestamps: [], dailyCap: 2, now, promotionSweeping: false });
    expect(refusal?.reason).toContain("off");
  });

  it("refuses under strict/standard even when manual", () => {
    const refusal = checkQueueFlushRails({ mode: "manual", posture: "standard", flushTimestamps: [], dailyCap: 2, now, promotionSweeping: false });
    expect(refusal?.reason).toContain("standard");
  });

  it("refuses while a promotion sweep is in flight", () => {
    const refusal = checkQueueFlushRails({ mode: "manual", posture: "flow", flushTimestamps: [], dailyCap: 2, now, promotionSweeping: true });
    expect(refusal?.reason).toContain("sweeping");
  });

  it("refuses once the daily cap is reached", () => {
    const refusal = checkQueueFlushRails({
      mode: "manual", posture: "flow",
      flushTimestamps: ["2026-09-26T01:00:00.000Z", "2026-09-26T02:00:00.000Z"],
      dailyCap: 2, now, promotionSweeping: false,
    });
    expect(refusal?.reason).toContain("daily flush cap");
  });

  it("allows a flush when every rail is clear", () => {
    const refusal = checkQueueFlushRails({ mode: "manual", posture: "flow", flushTimestamps: [], dailyCap: 2, now, promotionSweeping: false });
    expect(refusal).toBeNull();
  });
});

// ── CLI dry-run text ─────────────────────────────────────────────────────────────────────

describe("formatQueueFlushDryRun (#1248)", () => {
  it("names the members, the gate, and the heal target when not refused", () => {
    const text = formatQueueFlushDryRun({ refusal: null, memberBranches: ["feature/a", "feature/b"], healTarget: "master" });
    expect(text).toBe("would flush 2 branch(es): feature/a, feature/b — gate = arch + typecheck, heal target: master");
  });

  it("names none ready when the queue is empty", () => {
    const text = formatQueueFlushDryRun({ refusal: null, memberBranches: [], healTarget: "rc/2026-09-26" });
    expect(text).toBe("would flush 0 branch(es): (none ready) — gate = arch + typecheck, heal target: rc/2026-09-26");
  });

  it("shows the refusal reason instead when refused", () => {
    const text = formatQueueFlushDryRun({ refusal: { reason: "risk posture 'standard' refuses a flush" }, memberBranches: ["a"], healTarget: "master" });
    expect(text).toBe("flush refused: risk posture 'standard' refuses a flush");
  });
});
