import { describe, expect, it } from "vitest";
import {
  aggregateFleetLiveStats,
  estimateContextCostUsd,
  providerForModel,
  type FleetAgentInput,
} from "./fleetLiveStats.js";

function agent(overrides: Partial<FleetAgentInput>): FleetAgentInput {
  return {
    issueId: overrides.issueId ?? "i1",
    issueNumber: overrides.issueNumber ?? 1,
    title: overrides.title ?? "Ticket",
    model: overrides.model ?? "sonnet",
    contextTokens: overrides.contextTokens ?? 0,
    toolUses: overrides.toolUses ?? 0,
    subagentCount: overrides.subagentCount ?? 0,
    active: overrides.active ?? true,
    lastTool: overrides.lastTool,
  };
}

describe("providerForModel", () => {
  it("maps Claude and Codex families to providers", () => {
    expect(providerForModel("opus")).toBe("claude");
    expect(providerForModel("claude-opus-4-8[1m]")).toBe("claude");
    expect(providerForModel("sonnet")).toBe("claude");
    expect(providerForModel("gpt-5.5")).toBe("codex");
    expect(providerForModel("gpt-5.3-codex")).toBe("codex");
  });

  it("returns unknown for empty / unrecognised ids", () => {
    expect(providerForModel("")).toBe("unknown");
    expect(providerForModel(null)).toBe("unknown");
  });
});

describe("estimateContextCostUsd", () => {
  it("prices by model family from context tokens", () => {
    // opus = $15/MTok input → 1M tokens = $15
    expect(estimateContextCostUsd("opus", 1_000_000)).toBeCloseTo(15, 5);
    // sonnet = $3/MTok → 500k = $1.50
    expect(estimateContextCostUsd("sonnet", 500_000)).toBeCloseTo(1.5, 5);
  });

  it("returns 0 for empty/zero token counts", () => {
    expect(estimateContextCostUsd("opus", 0)).toBe(0);
    expect(estimateContextCostUsd("opus", -5)).toBe(0);
  });
});

describe("aggregateFleetLiveStats", () => {
  // Deterministic price: $1 per 1000 context tokens, model-agnostic.
  const flatPrice = (_model: string | null | undefined, tokens: number) => tokens / 1000;

  it("returns an empty aggregate when there are no active agents", () => {
    const agg = aggregateFleetLiveStats([], flatPrice);
    expect(agg.activeAgentCount).toBe(0);
    expect(agg.totalContextTokens).toBe(0);
    expect(agg.estimatedCostUsd).toBe(0);
    expect(agg.agents).toEqual([]);
    expect(agg.byProvider).toEqual([]);
  });

  it("sums totals and builds provider/model splits across sessions", () => {
    const agg = aggregateFleetLiveStats(
      [
        agent({ issueId: "a", model: "opus", contextTokens: 100_000, toolUses: 3, subagentCount: 1 }),
        agent({ issueId: "b", model: "sonnet", contextTokens: 50_000, toolUses: 2, subagentCount: 0 }),
        agent({ issueId: "c", model: "gpt-5.5", contextTokens: 20_000, toolUses: 5, subagentCount: 2 }),
      ],
      flatPrice,
    );

    expect(agg.activeAgentCount).toBe(3);
    expect(agg.totalContextTokens).toBe(170_000);
    expect(agg.totalToolUses).toBe(10);
    expect(agg.totalSubagents).toBe(3);
    expect(agg.estimatedCostUsd).toBeCloseTo(170, 5);

    // Provider split: claude (opus+sonnet = 150k, 2 agents) + codex (20k, 1 agent).
    const claude = agg.byProvider.find((p) => p.key === "claude");
    const codex = agg.byProvider.find((p) => p.key === "codex");
    expect(claude).toMatchObject({ agentCount: 2, contextTokens: 150_000 });
    expect(codex).toMatchObject({ agentCount: 1, contextTokens: 20_000 });
    // Sorted by context desc → claude first.
    expect(agg.byProvider[0].key).toBe("claude");

    // Model split keeps opus/sonnet/gpt-5.5 distinct.
    expect(agg.byModel.map((m) => m.key).sort()).toEqual(["gpt-5.5", "opus", "sonnet"]);

    // Per-agent breakdown sorted by context desc.
    expect(agg.agents.map((a) => a.issueId)).toEqual(["a", "b", "c"]);
    expect(agg.agents[0].provider).toBe("claude");
  });

  it("drops idle sessions from every total and split", () => {
    const agg = aggregateFleetLiveStats(
      [
        agent({ issueId: "live", model: "opus", contextTokens: 80_000, active: true }),
        agent({ issueId: "idle", model: "gpt-5.5", contextTokens: 99_000, active: false }),
      ],
      flatPrice,
    );

    expect(agg.activeAgentCount).toBe(1);
    expect(agg.totalContextTokens).toBe(80_000);
    expect(agg.agents.map((a) => a.issueId)).toEqual(["live"]);
    // The idle codex session must not appear in the provider split.
    expect(agg.byProvider.map((p) => p.key)).toEqual(["claude"]);
  });
});
