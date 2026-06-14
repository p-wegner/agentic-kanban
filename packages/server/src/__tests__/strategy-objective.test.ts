import { describe, it, expect } from "vitest";
import {
  parseStrategyBullseyeConfig,
  selectProviderFromStrategy,
  isPolicyBlockedByQuota,
  renderGeneratedStrategyBlock,
  type ProviderProfilePolicy,
} from "../services/strategy-objective.service.js";
import type { QuotaUsageResult } from "../services/quota-usage.service.js";

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

  it("parses an optional per-policy model and exposes it on the selected policy (#818)", () => {
    const raw = JSON.stringify({
      version: 1,
      segments: [],
      providerPolicies: [
        { id: "p1", provider: "claude", profileName: "anth", label: "Claude anth", mode: "fill", headroomPct: 0, notes: "", model: "sonnet" },
      ],
    });
    const config = parseStrategyBullseyeConfig(raw);
    expect(config.providerPolicies![0].model).toBe("sonnet");
    const selected = selectProviderFromStrategy(config);
    expect(selected?.policy.model).toBe("sonnet");
  });

  it("leaves model undefined when absent or blank (#818)", () => {
    const raw = JSON.stringify({
      version: 1,
      segments: [],
      providerPolicies: [
        { id: "p1", provider: "claude", profileName: "anth", label: "x", mode: "fill", headroomPct: 0, notes: "" },
        { id: "p2", provider: "codex", profileName: "default", label: "y", mode: "throttle", headroomPct: 0, notes: "", model: "   " },
      ],
    });
    const config = parseStrategyBullseyeConfig(raw);
    expect(config.providerPolicies![0].model).toBeUndefined();
    expect(config.providerPolicies![1].model).toBeUndefined();
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

function makeQuota(providers: Array<{ id: string; percent: number; status?: "ok" | "auth" | "error" }>): QuotaUsageResult {
  return {
    scrapedAt: new Date().toISOString(),
    providers: providers.map(({ id, percent, status = "ok" }) => ({
      id,
      label: id,
      accent: "#000",
      loginUrl: "",
      transport: "browser" as const,
      hasCreds: true,
      status,
      metrics: [{ label: "Messages", percent, detail: null, resetAt: null, resetIso: null, resetInSeconds: null }],
    })),
  };
}

describe("isPolicyBlockedByQuota", () => {
  it("returns false when quota is null", () => {
    const policy = makePolicy({ mode: "fill", quotaProviderId: "claude-pro" });
    expect(isPolicyBlockedByQuota(policy, null)).toBe(false);
  });

  it("returns false when policy has no quotaProviderId", () => {
    const policy = makePolicy({ mode: "fill" });
    expect(isPolicyBlockedByQuota(policy, makeQuota([{ id: "claude-pro", percent: 100 }]))).toBe(false);
  });

  it("returns false for fallback-only regardless of usage", () => {
    const policy = makePolicy({ mode: "fallback-only", quotaProviderId: "claude-pro" });
    expect(isPolicyBlockedByQuota(policy, makeQuota([{ id: "claude-pro", percent: 100 }]))).toBe(false);
  });

  it("fill: not blocked below 100%", () => {
    const policy = makePolicy({ mode: "fill", quotaProviderId: "claude-pro" });
    expect(isPolicyBlockedByQuota(policy, makeQuota([{ id: "claude-pro", percent: 99 }]))).toBe(false);
  });

  it("fill: blocked at 100%", () => {
    const policy = makePolicy({ mode: "fill", quotaProviderId: "claude-pro" });
    expect(isPolicyBlockedByQuota(policy, makeQuota([{ id: "claude-pro", percent: 100 }]))).toBe(true);
  });

  it("throttle: blocked when usage reaches capacity threshold", () => {
    const policy = makePolicy({ mode: "throttle", headroomPct: 20, quotaProviderId: "claude-pro" });
    // threshold = 80%, so 80% usage is blocked
    expect(isPolicyBlockedByQuota(policy, makeQuota([{ id: "claude-pro", percent: 80 }]))).toBe(true);
  });

  it("throttle: not blocked when usage is below threshold", () => {
    const policy = makePolicy({ mode: "throttle", headroomPct: 20, quotaProviderId: "claude-pro" });
    expect(isPolicyBlockedByQuota(policy, makeQuota([{ id: "claude-pro", percent: 79 }]))).toBe(false);
  });

  it("returns false when provider is not found in quota data", () => {
    const policy = makePolicy({ mode: "fill", quotaProviderId: "unknown-provider" });
    expect(isPolicyBlockedByQuota(policy, makeQuota([{ id: "claude-pro", percent: 100 }]))).toBe(false);
  });

  it("returns false when provider status is not ok", () => {
    const policy = makePolicy({ mode: "fill", quotaProviderId: "claude-pro" });
    expect(isPolicyBlockedByQuota(policy, makeQuota([{ id: "claude-pro", percent: 100, status: "auth" }]))).toBe(false);
  });
});

describe("selectProviderFromStrategy - quota-aware", () => {
  it("skips fill policy when quota is exhausted, falls back to throttle", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      version: 1, segments: [],
      providerPolicies: [
        makePolicy({ id: "f", provider: "codex", profileName: "default", mode: "fill", quotaProviderId: "codex-sub" }),
        makePolicy({ id: "t", provider: "claude", profileName: "anth", mode: "throttle", headroomPct: 20 }),
      ],
    }));
    const quota = makeQuota([{ id: "codex-sub", percent: 100 }]);
    const result = selectProviderFromStrategy(config, { quota });
    expect(result?.provider).toBe("claude");
    expect(result?.policy.mode).toBe("throttle");
  });

  it("skips throttle policy when headroom is consumed, falls to fallback-only with allowFallback", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      version: 1, segments: [],
      providerPolicies: [
        makePolicy({ id: "t", provider: "claude", profileName: "anth", mode: "throttle", headroomPct: 20, quotaProviderId: "claude-pro" }),
        makePolicy({ id: "fb", provider: "claude", profileName: "zai", mode: "fallback-only" }),
      ],
    }));
    const quota = makeQuota([{ id: "claude-pro", percent: 85 }]);
    const result = selectProviderFromStrategy(config, { quota, allowFallback: true });
    expect(result?.policy.mode).toBe("fallback-only");
    expect(result?.profileName).toBe("zai");
  });

  it("returns throttle when quota data is absent (graceful degradation)", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      version: 1, segments: [],
      providerPolicies: [
        makePolicy({ id: "t", provider: "claude", profileName: "anth", mode: "throttle", headroomPct: 20, quotaProviderId: "claude-pro" }),
      ],
    }));
    const result = selectProviderFromStrategy(config, { quota: null });
    expect(result?.provider).toBe("claude");
    expect(result?.policy.mode).toBe("throttle");
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
