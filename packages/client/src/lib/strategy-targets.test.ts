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
  buildMigrationConfig,
  selectProviderFromPolicies,
  setProviderFillPolicy,
  clearProviderFillPolicy,
  PROVIDER_DEFAULT_POLICY_ID,
  type StrategySegment,
  type ProviderProfilePolicy,
} from "./strategy-targets.js";

describe("buildMigrationConfig", () => {
  it("uses the WIP limit as the active-agents target", () => {
    expect(buildMigrationConfig("8")).toEqual({
      version: 1,
      activeAgentsTarget: 8,
      backlogFloor: 3,
      maxNewStartsPerCycle: 3,
      segments: [],
    });
  });
  it("falls back to 5 when the WIP limit is missing or non-numeric", () => {
    expect(buildMigrationConfig(undefined).activeAgentsTarget).toBe(5);
    expect(buildMigrationConfig("abc").activeAgentsTarget).toBe(5);
  });
});

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

describe("normalizeConfig provider-policy round-trip (#983)", () => {
  const serverWrittenPolicy = {
    id: "policy-claude-work",
    provider: "claude",
    profileName: "work",
    label: "Claude (work)",
    mode: "fill",
    headroomPct: 20,
    notes: "",
    quotaProviderId: "claude-max",
    // Server-side field the old client interface didn't know about — the exact
    // field the field-list normalizer used to silently DROP on save.
    model: "sonnet",
  };

  it("preserves a per-policy model through open -> normalize -> save", () => {
    const cfg = normalizeConfig({ providerPolicies: [serverWrittenPolicy] });
    expect(cfg.providerPolicies).toHaveLength(1);
    expect(cfg.providerPolicies[0].model).toBe("sonnet");
    // Full save shape keeps everything the server wrote.
    expect(cfg.providerPolicies[0]).toMatchObject(serverWrittenPolicy);
    // And it survives a SECOND round-trip (save -> reload -> save).
    const again = normalizeConfig(JSON.parse(JSON.stringify(cfg)));
    expect(again.providerPolicies[0].model).toBe("sonnet");
  });

  it("preserves unknown future fields on round-trip", () => {
    const cfg = normalizeConfig({
      providerPolicies: [{ ...serverWrittenPolicy, futureField: "keep-me" }],
    });
    expect((cfg.providerPolicies[0] as unknown as Record<string, unknown>).futureField).toBe("keep-me");
  });

  it("drops an invalid/blank model instead of persisting garbage", () => {
    const blank = normalizeConfig({ providerPolicies: [{ ...serverWrittenPolicy, model: "  " }] });
    expect(blank.providerPolicies[0].model).toBeUndefined();
    expect("model" in blank.providerPolicies[0]).toBe(false);
    const nonString = normalizeConfig({ providerPolicies: [{ ...serverWrittenPolicy, model: 42 }] });
    expect(nonString.providerPolicies[0].model).toBeUndefined();
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

function mkPolicy(partial: Partial<ProviderProfilePolicy>): ProviderProfilePolicy {
  return {
    id: "p",
    provider: "claude",
    profileName: "",
    label: "Claude",
    mode: "throttle",
    headroomPct: 20,
    notes: "",
    quotaProviderId: "",
    ...partial,
  };
}

describe("selectProviderFromPolicies", () => {
  it("returns null when no policies (caller uses global default)", () => {
    expect(selectProviderFromPolicies([])).toBeNull();
  });

  it("prefers fill over throttle over fallback-only (mirrors server)", () => {
    const policies = [
      mkPolicy({ id: "fb", provider: "copilot", mode: "fallback-only" }),
      mkPolicy({ id: "th", provider: "codex", mode: "throttle" }),
      mkPolicy({ id: "fl", provider: "claude", profileName: "work", mode: "fill" }),
    ];
    expect(selectProviderFromPolicies(policies)).toEqual({ provider: "claude", profileName: "work" });
  });

  it("falls through to throttle then fallback when no fill exists", () => {
    expect(selectProviderFromPolicies([mkPolicy({ provider: "codex", mode: "throttle" })])).toEqual({ provider: "codex", profileName: "" });
    expect(selectProviderFromPolicies([mkPolicy({ provider: "pi", mode: "fallback-only" })])).toEqual({ provider: "pi", profileName: "" });
  });
});

describe("setProviderFillPolicy", () => {
  it("writes a single fill policy with the stable simple-control id", () => {
    const next = setProviderFillPolicy(DEFAULT_CONFIG, "codex", "default");
    const fills = next.providerPolicies.filter((p) => p.mode === "fill");
    expect(fills).toHaveLength(1);
    expect(fills[0].id).toBe(PROVIDER_DEFAULT_POLICY_ID);
    expect(fills[0]).toMatchObject({ provider: "codex", profileName: "default" });
    // Round-trips: reading it back yields what we set.
    expect(selectProviderFromPolicies(next.providerPolicies)).toEqual({ provider: "codex", profileName: "default" });
  });

  it("replaces the existing simple-control policy in place (no reorder)", () => {
    const seeded = setProviderFillPolicy(
      { ...DEFAULT_CONFIG, providerPolicies: [mkPolicy({ id: "th", provider: "codex", mode: "throttle" })] },
      "claude",
      "",
    );
    // simple fill prepended ahead of the throttle policy
    expect(seeded.providerPolicies.map((p) => p.id)).toEqual([PROVIDER_DEFAULT_POLICY_ID, "th"]);
    const changed = setProviderFillPolicy(seeded, "pi", "local");
    expect(changed.providerPolicies.map((p) => p.id)).toEqual([PROVIDER_DEFAULT_POLICY_ID, "th"]);
    expect(changed.providerPolicies[0]).toMatchObject({ provider: "pi", profileName: "local", mode: "fill" });
  });

  it("preserves throttle/fallback policies but drops other fill policies", () => {
    const next = setProviderFillPolicy(
      {
        ...DEFAULT_CONFIG,
        providerPolicies: [
          mkPolicy({ id: "other-fill", provider: "codex", mode: "fill" }),
          mkPolicy({ id: "th", provider: "copilot", mode: "throttle" }),
        ],
      },
      "claude",
      "work",
    );
    const ids = next.providerPolicies.map((p) => p.id);
    expect(ids).toContain(PROVIDER_DEFAULT_POLICY_ID);
    expect(ids).toContain("th");
    expect(ids).not.toContain("other-fill");
    // The picked provider is unambiguously selected.
    expect(selectProviderFromPolicies(next.providerPolicies)).toEqual({ provider: "claude", profileName: "work" });
  });
});

describe("clearProviderFillPolicy", () => {
  it("removes the simple-control policy and keeps the rest", () => {
    const seeded = setProviderFillPolicy(
      { ...DEFAULT_CONFIG, providerPolicies: [mkPolicy({ id: "th", provider: "codex", mode: "throttle" })] },
      "claude",
      "",
    );
    const cleared = clearProviderFillPolicy(seeded);
    expect(cleared.providerPolicies.map((p) => p.id)).toEqual(["th"]);
    // No fill policy → selection falls through to the remaining throttle policy.
    expect(selectProviderFromPolicies(cleared.providerPolicies)).toEqual({ provider: "codex", profileName: "" });
  });

  it("is a no-op when there is no simple-control policy", () => {
    const cfg = { ...DEFAULT_CONFIG, providerPolicies: [mkPolicy({ id: "th", mode: "throttle" })] };
    expect(clearProviderFillPolicy(cfg).providerPolicies).toEqual(cfg.providerPolicies);
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
