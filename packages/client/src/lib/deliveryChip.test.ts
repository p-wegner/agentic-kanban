import { describe, expect, it } from "vitest";
import type { DeliveryStatusResponse, RiskPosture } from "@agentic-kanban/shared/types";
import { buildDeliveryChipView, clampStep } from "./deliveryChip.js";

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
    ...overrides,
  };
}

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
