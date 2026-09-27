import { describe, expect, it } from "vitest";
import type {
  DeliveryStatusResponse,
  FlushRecord,
  MergeActivitySummary,
  MergeActivityTicket,
  MergeActivityTrain,
  RiskPosture,
} from "@agentic-kanban/shared/types";
import { shortTrainLabel } from "./deliveryMergeActivity.js";
import {
  MERGE_WARNING_DOT,
  buildDeliveryChipView,
  buildFlushBadge,
  clampStep,
  describeFlush,
  describeQueuePressure,
  describeRedBase,
} from "./deliveryChip.js";

function posture(overrides: Partial<RiskPosture> = {}): RiskPosture {
  return {
    level: "iterate",
    source: "risk_posture",
    gateTier: "impact",
    reviewMode: "standard",
    sweepIntervalMs: 24 * 60 * 60 * 1000,
    redBasePolicy: "block",
    trainMaxSize: 1,
    trainMaxWaitMs: 0,
    mergesPerCycle: 2,
    relaunchesPerCycle: 2,
    builderStopChecks: "tests-capacity-gated",
    contentionMode: "serialize",
    placementBias: "host-preferred",
    summary: "iterate: per-merge gate is the test-impact selection",
    ...overrides,
  };
}

function status(overrides: Partial<DeliveryStatusResponse> = {}): DeliveryStatusResponse {
  return {
    projectId: "p",
    posture: posture(),
    trainSizeFromOverride: false,
    trainWindowMaxSize: 1,
    trainWindowMaxWaitMs: 0,
    trainWindowFromPosture: false,
    baseSweep: {
      scheduled: true,
      intervalMs: 24 * 60 * 60 * 1000,
      nominalIntervalMs: 24 * 60 * 60 * 1000,
      postureLevel: "iterate",
      postureSource: "risk_posture",
      reason: "risk posture 'iterate' sweeps the base every 24 h",
      nextDueAt: null,
    },
    redBase: {
      policy: "allow-file-debt-ticket",
      latestOutcome: null,
      latestSha: null,
      holdingWindow: false,
      openHealTickets: 0,
    },
    ...overrides,
  };
}

describe("describeRedBase (#1233)", () => {
  it("names a hold on a red base under block", () => {
    expect(describeRedBase({ policy: "block", latestOutcome: "red", latestSha: "deadbeefcafe", holdingWindow: true, openHealTickets: 0 }))
      .toBe("Red base: latest sweep red at deadbeef, HOLDING the train window");
  });

  it("names the policy that lets a red base through, and the heal tickets it filed", () => {
    expect(describeRedBase({ policy: "allow-file-debt-ticket", latestOutcome: "red", latestSha: "deadbeefcafe", holdingWindow: false, openHealTickets: 2 }))
      .toBe("Red base: latest sweep red at deadbeef, not holding the window (policy 'allow-file-debt-ticket'), 2 open heal tickets");
  });

  it("a never-swept project reads as such", () => {
    expect(describeRedBase({ policy: "block", latestOutcome: null, latestSha: null, holdingWindow: false, openHealTickets: 0 }))
      .toBe("Red base: never swept, not holding the window");
    expect(buildDeliveryChipView(status()).title).toContain("Red base: never swept");
  });
});

describe("buildDeliveryChipView (#1155)", () => {
  it("names the level and the un-batched train plainly", () => {
    const view = buildDeliveryChipView(status());
    expect(view.label).toBe("Iterate · train 1 (no batching)");
    expect(view.compactLabel).toBe("Iterate · 1");
    expect(view.title).toContain("Risk posture: Iterate (source: risk_posture)");
    expect(view.title).toContain("Merge train: max 1, wait 0 (never batches for time)");
  });

  it("a batching train shows its size and wait", () => {
    const view = buildDeliveryChipView(status({
      posture: posture({ level: "fast", trainMaxSize: 8, trainMaxWaitMs: 20 * 60 * 1000 }),
      trainWindowMaxSize: 8,
      trainWindowMaxWaitMs: 20 * 60 * 1000,
      trainWindowFromPosture: true,
    }));
    expect(view.label).toBe("Fast · train 8");
    expect(view.title).toContain("Merge train: max 8, wait 20 min");
  });

  it("an explicit project override is named in the tooltip", () => {
    const view = buildDeliveryChipView(status({ trainWindowMaxSize: 4, trainSizeFromOverride: true }));
    expect(view.title).toContain("Merge train: max 4, wait 0 (never batches for time) (project override)");
  });

  it("the dot color follows the posture level", () => {
    expect(buildDeliveryChipView(status({ posture: posture({ level: "strict" }) })).dotClass).toBe("bg-blue-500");
    expect(buildDeliveryChipView(status({ posture: posture({ level: "sprint" }) })).dotClass).toBe("bg-red-500");
  });

  it("clampStep keeps steppers inside their bounds", () => {
    expect(clampStep(0, 1, 20)).toBe(1);
    expect(clampStep(40, 1, 20)).toBe(20);
    expect(clampStep(Number.NaN, 1, 20)).toBe(1);
    expect(clampStep(3.4, 1, 20)).toBe(3);
  });
});

function flushRecord(overrides: Partial<FlushRecord> = {}): FlushRecord {
  return {
    id: "flush/20260926-1",
    at: "2026-09-26T10:00:00.000Z",
    triggeredBy: "auto",
    memberIssueNumbers: [1200],
    memberBranches: ["feature/ak-1200-x"],
    landingSha: "abc123",
    tag: "flush/20260926-1",
    sweepTarget: "master",
    state: "flushed",
    openHealTickets: [],
    updatedAt: "2026-09-26T10:00:00.000Z",
    ...overrides,
  };
}

describe("describeQueuePressure (#1246)", () => {
  it("names the queue depth, oldest wait and both rates", () => {
    expect(describeQueuePressure({ queueDepth: 7, oldestWaitingMs: 48 * 60 * 1000, arrivalsPerHour: 3.2, gateRunsPerHour: 1.1, windowMs: 3_600_000 }))
      .toBe("Queue pressure: 7 waiting, oldest 48 min, 3.2 arrivals/h vs 1.1 gates/h");
  });

  it("names n/a for an empty queue's oldest age", () => {
    expect(describeQueuePressure({ queueDepth: 0, oldestWaitingMs: null, arrivalsPerHour: 0, gateRunsPerHour: 0, windowMs: 3_600_000 }))
      .toBe("Queue pressure: 0 waiting, oldest n/a, 0.0 arrivals/h vs 0.0 gates/h");
  });

  it("reads as not reported when absent", () => {
    expect(describeQueuePressure(undefined)).toBe("Queue pressure: not reported");
  });
});

describe("describeFlush (#1246)", () => {
  it("names the flush id, state, and open heal ticket count", () => {
    expect(describeFlush(flushRecord({ state: "red", openHealTickets: [1210, 1211] })))
      .toBe("Flush: flush/20260926-1 red, 2 open heal tickets");
  });

  it("omits the heal segment when there are none", () => {
    expect(describeFlush(flushRecord({ state: "merged-back" }))).toBe("Flush: flush/20260926-1 merged-back");
  });

  it("reads as none when the project never flushed", () => {
    expect(describeFlush(null)).toBe("Flush: none");
    expect(describeFlush(undefined)).toBe("Flush: none");
  });
});

describe("buildFlushBadge (#1246)", () => {
  it("is null when the project never flushed", () => {
    expect(buildFlushBadge(null)).toBeNull();
  });

  it("marks a red flush urgent, with the open heal count in the label", () => {
    const badge = buildFlushBadge(flushRecord({ state: "red", openHealTickets: [1210] }));
    expect(badge).toEqual({ label: "flush red (1)", urgent: true });
  });

  it("is not urgent once healed", () => {
    const badge = buildFlushBadge(flushRecord({ state: "healed", openHealTickets: [] }));
    expect(badge).toEqual({ label: "flush healed", urgent: false });
  });
});

describe("buildDeliveryChipView live merge state", () => {
  const NOW = Date.parse("2026-09-27T12:00:00.000Z");
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const member = (n: number): MergeActivityTicket => ({ workspaceId: `ws-${n}`, issueNumber: n, title: `Ticket ${n}` });
  function trainRow(overrides: Partial<MergeActivityTrain> = {}): MergeActivityTrain {
    return {
      label: "train/2026-09-27-05", state: "gating", bisecting: false,
      members: [member(1), member(2), member(3), member(4)],
      startedAt: ago(12), finishedAt: null, landedCount: null, failureSummary: null,
      ...overrides,
    };
  }
  function activity(overrides: Partial<MergeActivitySummary> = {}): MergeActivitySummary {
    return { current: null, lastFinished: null, waiting: [], recentWindowMs: 3 * 60 * 60_000, ...overrides };
  }
  const waiting = (n: number) => Array.from({ length: n }, (_, i) => ({ ...member(10 + i), readySince: ago(5) }));

  it("a gating train leads: label, members, elapsed, then the posture", () => {
    const view = buildDeliveryChipView(status({ mergeActivity: activity({ current: trainRow(), waiting: waiting(2) }) }), NOW);
    expect(view.label).toBe("Merging train-05 · 4 tickets · 12m · Iterate");
    expect(view.compactLabel).toBe("Merging 4 · 12m");
    expect(view.dotClass).toBe("bg-emerald-500");
    expect(view.title).toContain("Merging now: train/2026-09-27-05 merging, 12m (#1 #2 #3 #4)");
    expect(view.title).toContain("Ready and waiting: 2");
  });

  it("a bisecting train warns", () => {
    const view = buildDeliveryChipView(status({ mergeActivity: activity({ current: trainRow({ bisecting: true, startedAt: ago(75) }) }) }), NOW);
    expect(view.label).toBe("Bisecting train-05 · 4 tickets · 1h 15m · Iterate");
    expect(view.dotClass).toBe(MERGE_WARNING_DOT);
  });

  it("waiting branches: batching window, plain wait, and a red-base hold", () => {
    expect(buildDeliveryChipView(status({ mergeActivity: activity({ waiting: waiting(5) }) }), NOW).label).toBe("5 ready · waiting · Iterate");
    const windowed = buildDeliveryChipView(status({ trainWindowMaxSize: 4, mergeActivity: activity({ waiting: waiting(5) }) }), NOW);
    expect(windowed.label).toBe("5 ready · waiting for window · Iterate");
    expect(windowed.compactLabel).toBe("5 ready");
    const held = buildDeliveryChipView(status({
      redBase: { policy: "block", latestOutcome: "red", latestSha: null, holdingWindow: true, openHealTickets: 1 },
      mergeActivity: activity({ waiting: waiting(1) }),
    }), NOW);
    expect(held.label).toBe("1 ready · held: red base · Iterate");
    expect(held.dotClass).toBe(MERGE_WARNING_DOT);
  });

  it("a just-landed train shows briefly, then gives way to idle", () => {
    const landed = trainRow({ label: "train/2026-09-27-04", state: "landed", finishedAt: ago(4), landedCount: 3 });
    const view = buildDeliveryChipView(status({ mergeActivity: activity({ lastFinished: landed }) }), NOW);
    expect(view.label).toBe("Last: train-04 landed 3 tickets · Iterate");
    expect(view.compactLabel).toBe("train-04 landed");
    const later = buildDeliveryChipView(status({ mergeActivity: activity({ lastFinished: { ...landed, finishedAt: ago(45) } }) }), NOW);
    expect(later.label).toBe("Queue idle · Iterate");
    expect(later.compactLabel).toBe("Idle");
    expect(later.title).toContain("Last train: train/2026-09-27-04 landed 3 tickets, 45m ago");
  });

  it("a just-red train outranks waiting branches and warns", () => {
    const red = trainRow({ label: "train/2026-09-27-04", state: "red", finishedAt: ago(2), failureSummary: "failing suite(s): a.test.ts" });
    const view = buildDeliveryChipView(status({ mergeActivity: activity({ lastFinished: red, waiting: waiting(3) }) }), NOW);
    expect(view.label).toBe("Last: train-04 red · Iterate");
    expect(view.compactLabel).toBe("train-04 red");
    expect(view.dotClass).toBe(MERGE_WARNING_DOT);
    expect(view.title).toContain("Last train: train/2026-09-27-04 red, 2m ago - failing suite(s): a.test.ts");
  });

  it("an older label shape is shown as is, capped", () => {
    expect(shortTrainLabel("train/2026-09-27-12")).toBe("train-12");
    expect(shortTrainLabel("q17900000000001")).toBe("q179000000000…");
    expect(shortTrainLabel("q1790000000000")).toBe("q1790000000000");
  });
});
