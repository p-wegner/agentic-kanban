import { describe, expect, it } from "vitest";
import {
  clampWeight,
  clampPolicy,
  normalizeConfig,
  deriveRefillFocus,
  matchesSegment,
  makeAgentBrief,
  presetMatchesConfig,
  settingsKey,
  presetsKey,
  DEFAULT_CONFIG,
  BUILTIN_PRESETS,
  type StrategySegment,
} from "./strategy-targets.js";

function mkIssue(partial: Record<string, unknown>) {
  // Only the fields issueSearchText reads matter.
  return {
    title: "",
    description: "",
    issueType: "task",
    priority: "medium",
    statusName: "Backlog",
    tags: [],
    ...partial,
  } as unknown as Parameters<typeof matchesSegment>[0];
}

function mkSegment(partial: Partial<StrategySegment>): StrategySegment {
  return {
    id: "s1",
    label: "Seg",
    description: "",
    kind: "work-type",
    weight: 3,
    color: "#000",
    keywords: "",
    provider: "",
    ...partial,
  };
}

describe("settingsKey / presetsKey", () => {
  it("namespaces by projectId", () => {
    expect(settingsKey("p1")).toBe("board_strategy_p1");
    expect(presetsKey("p1")).toBe("monitor_policy_presets_p1");
  });
});

describe("clampWeight", () => {
  it("rounds and clamps into 1..5", () => {
    expect(clampWeight(0)).toBe(1);
    expect(clampWeight(9)).toBe(5);
    expect(clampWeight(3.4)).toBe(3);
    expect(clampWeight(NaN)).toBe(1);
  });
});

describe("clampPolicy", () => {
  it("clamps into [min,max] and falls back on non-finite", () => {
    expect(clampPolicy(50, 4, 1, 12)).toBe(12);
    expect(clampPolicy(-5, 4, 0, 100)).toBe(0);
    expect(clampPolicy(NaN, 7, 1, 12)).toBe(7);
  });
});

describe("normalizeConfig", () => {
  it("returns defaults for garbage input", () => {
    const cfg = normalizeConfig(null);
    expect(cfg.version).toBe(1);
    expect(cfg.activeAgentsTarget).toBe(DEFAULT_CONFIG.activeAgentsTarget);
    expect(cfg.segments.length).toBe(DEFAULT_CONFIG.segments.length);
    expect(cfg.providerPolicies).toEqual([]);
  });

  it("clamps numeric targets and drops blank-label segments", () => {
    const cfg = normalizeConfig({
      activeAgentsTarget: 999,
      backlogFloor: -10,
      maxNewStartsPerCycle: 0,
      segments: [{ label: "  ", weight: 3 }],
    });
    expect(cfg.activeAgentsTarget).toBe(12);
    expect(cfg.backlogFloor).toBe(0);
    expect(cfg.maxNewStartsPerCycle).toBe(1);
    // blank-label segment filtered out -> falls back to defaults
    expect(cfg.segments.length).toBe(DEFAULT_CONFIG.segments.length);
  });
});

describe("matchesSegment", () => {
  it("matches when an issue's text contains a segment token (>=3 chars)", () => {
    const seg = mkSegment({ keywords: "bug regression" });
    expect(matchesSegment(mkIssue({ title: "Fix login bug" }), seg)).toBe(true);
    expect(matchesSegment(mkIssue({ title: "Add dark mode" }), seg)).toBe(false);
  });
});

describe("deriveRefillFocus", () => {
  it("is bugfix-only when bugfix weight dominates work segments", () => {
    const segs = [
      mkSegment({ id: "b", label: "Bugfix", kind: "work-type", keywords: "bug fix", weight: 5 }),
      mkSegment({ id: "f", label: "Feature", kind: "work-type", keywords: "feature", weight: 2 }),
    ];
    expect(deriveRefillFocus(segs)).toBe("bugfix-only");
  });

  it("is balanced when other work outweighs bugfix", () => {
    const segs = [
      mkSegment({ id: "b", label: "Bugfix", kind: "work-type", keywords: "bug fix", weight: 1 }),
      mkSegment({ id: "f", label: "Feature", kind: "work-type", keywords: "feature", weight: 5 }),
    ];
    expect(deriveRefillFocus(segs)).toBe("balanced");
  });
});

describe("presetMatchesConfig", () => {
  it("matches the balanced builtin against the default config", () => {
    const balanced = BUILTIN_PRESETS.find((p) => p.id === "balanced")!;
    expect(presetMatchesConfig(balanced, DEFAULT_CONFIG)).toBe(true);
    const bugBash = BUILTIN_PRESETS.find((p) => p.id === "bug-bash")!;
    expect(presetMatchesConfig(bugBash, DEFAULT_CONFIG)).toBe(false);
  });
});

describe("makeAgentBrief", () => {
  it("includes the bullseye header, tunables, and top segments", () => {
    const brief = makeAgentBrief(DEFAULT_CONFIG, []);
    expect(brief).toContain("Strategy Bullseye monitor policy:");
    expect(brief).toContain(`ACTIVE_AGENTS_TARGET=${DEFAULT_CONFIG.activeAgentsTarget}`);
    expect(brief).toMatch(/REFILL_FOCUS=(bugfix-only|balanced)/);
  });
});
