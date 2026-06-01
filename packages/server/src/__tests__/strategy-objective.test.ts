import { describe, it, expect } from "vitest";
import {
  parseStrategyBullseyeConfig,
  selectProviderFromStrategy,
  renderGeneratedStrategyBlock,
  type ProviderProfilePolicy,
} from "../services/strategy-objective.service.js";

function makePolicy(overrides: Partial<ProviderProfilePolicy>): ProviderProfilePolicy {
  return {
    id: "test-policy",
    provider: "claude",
    profileName: "default",
    label: "Claude: Default",
    mode: "throttle",
    headroomPct: 20,
    notes: "",
    ...overrides,
  };
}

describe("parseStrategyBullseyeConfig - providerPolicies", () => {
  it("returns empty array when no providerPolicies field", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({ version: 1, segments: [] }));
    expect(config.providerPolicies).toEqual([]);
  });

  it("parses valid provider policies", () => {
    const raw = JSON.stringify({
      version: 1,
      segments: [],
      providerPolicies: [
        { id: "p1", provider: "claude", profileName: "work", label: "Claude Work", mode: "throttle", headroomPct: 20, notes: "5h/week" },
        { id: "p2", provider: "codex", profileName: "default", label: "Codex Default", mode: "fill", headroomPct: 0, notes: "" },
      ],
    });
    const config = parseStrategyBullseyeConfig(raw);
    expect(config.providerPolicies).toHaveLength(2);
    expect(config.providerPolicies![0].mode).toBe("throttle");
    expect(config.providerPolicies![1].mode).toBe("fill");
  });

  it("clamps headroomPct to 0-100", () => {
    const raw = JSON.stringify({
      version: 1,
      segments: [],
      providerPolicies: [
        { id: "p1", provider: "claude", profileName: "", label: "x", mode: "throttle", headroomPct: 999, notes: "" },
      ],
    });
    const config = parseStrategyBullseyeConfig(raw);
    expect(config.providerPolicies![0].headroomPct).toBe(100);
  });

  it("defaults invalid mode to throttle", () => {
    const raw = JSON.stringify({
      version: 1,
      segments: [],
      providerPolicies: [
        { id: "p1", provider: "claude", profileName: "", label: "x", mode: "invalid", headroomPct: 0, notes: "" },
      ],
    });
    const config = parseStrategyBullseyeConfig(raw);
    expect(config.providerPolicies![0].mode).toBe("throttle");
  });
});

describe("selectProviderFromStrategy", () => {
  it("returns null when no policies", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({ version: 1, segments: [], providerPolicies: [] }));
    expect(selectProviderFromStrategy(config)).toBeNull();
  });

  it("prefers fill over throttle", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      version: 1, segments: [],
      providerPolicies: [
        makePolicy({ id: "t", provider: "claude", profileName: "work", mode: "throttle" }),
        makePolicy({ id: "f", provider: "codex", profileName: "default", mode: "fill" }),
      ],
    }));
    const result = selectProviderFromStrategy(config);
    expect(result?.provider).toBe("codex");
    expect(result?.policy.mode).toBe("fill");
  });

  it("falls back to throttle when no fill", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      version: 1, segments: [],
      providerPolicies: [
        makePolicy({ id: "t1", provider: "claude", profileName: "work", mode: "throttle" }),
        makePolicy({ id: "fb", provider: "codex", profileName: "azure", mode: "fallback-only" }),
      ],
    }));
    const result = selectProviderFromStrategy(config);
    expect(result?.provider).toBe("claude");
    expect(result?.policy.mode).toBe("throttle");
  });

  it("returns null when all are fallback-only and allowFallback is false", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      version: 1, segments: [],
      providerPolicies: [
        makePolicy({ id: "fb", provider: "claude", profileName: "gateway", mode: "fallback-only" }),
      ],
    }));
    expect(selectProviderFromStrategy(config)).toBeNull();
  });

  it("returns fallback-only when allowFallback is true and no better option", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      version: 1, segments: [],
      providerPolicies: [
        makePolicy({ id: "fb", provider: "claude", profileName: "gateway", mode: "fallback-only" }),
      ],
    }));
    const result = selectProviderFromStrategy(config, { allowFallback: true });
    expect(result?.policy.mode).toBe("fallback-only");
  });
});

describe("renderGeneratedStrategyBlock - provider policies", () => {
  it("includes provider policy section when policies configured", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      version: 1, segments: [],
      providerPolicies: [
        makePolicy({ id: "p1", provider: "codex", profileName: "default", label: "Codex Default", mode: "fill", notes: "always busy" }),
        makePolicy({ id: "p2", provider: "claude", profileName: "work", label: "Claude Work", mode: "throttle", headroomPct: 30, notes: "preserve 30%" }),
      ],
    }));
    const block = renderGeneratedStrategyBlock(config);
    expect(block).toContain("PROVIDER POLICY");
    expect(block).toContain("**Codex Default** [codex:default]: FILL");
    expect(block).toContain("**Claude Work** [claude:work]: THROTTLE");
    expect(block).toContain("headroom 30%");
  });

  it("omits provider policy section when no policies", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({ version: 1, segments: [] }));
    const block = renderGeneratedStrategyBlock(config);
    expect(block).not.toContain("PROVIDER POLICY");
  });
});
