import { describe, expect, it } from "vitest";
import { isProjectScopedDynamicKey } from "../src/lib/dynamic-preference-keys";
import {
  MERGE_TRAIN_AGENT_FIX_DEFAULT_COST_CAP_USD,
  MERGE_TRAIN_AGENT_FIX_DEFAULT_MAX_TURNS,
  MERGE_TRAIN_AGENT_FIX_DEFAULT_TIMEOUT_MS,
  mergeTrainAgentFixCostCapUsdPref,
  mergeTrainAgentFixMaxTurnsPref,
  mergeTrainAgentFixTimeoutMsPref,
  mergeTrainRedStrategyPref,
  parseMergeTrainRedStrategy,
  resolveMergeTrainRedPolicy,
} from "../src/lib/merge-train-red-strategy";

const PROJECT = "0b1f6a52-3c1e-4c0a-9d0a-1c2d3e4f5a6b";

describe("merge-train red strategy (#1277)", () => {
  it("defaults to agent-fix-then-bisect with the documented caps", () => {
    const policy = resolveMergeTrainRedPolicy(new Map(), PROJECT);
    expect(policy).toEqual({
      strategy: "agent-fix-then-bisect",
      agentFix: true,
      bisectAfter: true,
      caps: {
        maxTurns: MERGE_TRAIN_AGENT_FIX_DEFAULT_MAX_TURNS,
        timeoutMs: MERGE_TRAIN_AGENT_FIX_DEFAULT_TIMEOUT_MS,
        costCapUsd: MERGE_TRAIN_AGENT_FIX_DEFAULT_COST_CAP_USD,
      },
    });
  });

  it("bisect restores today's behaviour: no agent", () => {
    const prefs = new Map([[mergeTrainRedStrategyPref.key(PROJECT), "bisect"]]);
    expect(resolveMergeTrainRedPolicy(prefs, PROJECT)).toMatchObject({ strategy: "bisect", agentFix: false, bisectAfter: true });
  });

  it("agent-fix has no bisect fallback", () => {
    const prefs = new Map([[mergeTrainRedStrategyPref.key(PROJECT), "agent-fix"]]);
    expect(resolveMergeTrainRedPolicy(prefs, PROJECT)).toMatchObject({ strategy: "agent-fix", agentFix: true, bisectAfter: false });
  });

  it("is per project", () => {
    const prefs = new Map([[mergeTrainRedStrategyPref.key(PROJECT), "bisect"]]);
    expect(resolveMergeTrainRedPolicy(prefs, "ffffffff-0000-4000-8000-000000000000").strategy).toBe("agent-fix-then-bisect");
  });

  it("falls back to the default for a case-wrong or unknown value instead of coercing it", () => {
    expect(parseMergeTrainRedStrategy("Bisect")).toBe("agent-fix-then-bisect");
    expect(parseMergeTrainRedStrategy("nonsense")).toBe("agent-fix-then-bisect");
    expect(parseMergeTrainRedStrategy("")).toBe("agent-fix-then-bisect");
    expect(parseMergeTrainRedStrategy(undefined)).toBe("agent-fix-then-bisect");
  });

  it("reads the caps, ignoring non-positive and non-numeric values", () => {
    const prefs = new Map([
      [mergeTrainAgentFixMaxTurnsPref.key(PROJECT), "3"],
      [mergeTrainAgentFixTimeoutMsPref.key(PROJECT), "60000"],
      [mergeTrainAgentFixCostCapUsdPref.key(PROJECT), "0.5"],
    ]);
    expect(resolveMergeTrainRedPolicy(prefs, PROJECT).caps).toEqual({ maxTurns: 3, timeoutMs: 60000, costCapUsd: 0.5 });
    const bad = new Map([
      [mergeTrainAgentFixMaxTurnsPref.key(PROJECT), "0"],
      [mergeTrainAgentFixTimeoutMsPref.key(PROJECT), "soon"],
      [mergeTrainAgentFixCostCapUsdPref.key(PROJECT), "-1"],
    ]);
    expect(resolveMergeTrainRedPolicy(bad, PROJECT).caps.maxTurns).toBe(MERGE_TRAIN_AGENT_FIX_DEFAULT_MAX_TURNS);
    expect(resolveMergeTrainRedPolicy(bad, PROJECT).caps.timeoutMs).toBe(MERGE_TRAIN_AGENT_FIX_DEFAULT_TIMEOUT_MS);
    expect(resolveMergeTrainRedPolicy(bad, PROJECT).caps.costCapUsd).toBe(MERGE_TRAIN_AGENT_FIX_DEFAULT_COST_CAP_USD);
  });

  it("every key goes through the preference layer's per-project allow-list", () => {
    for (const pref of [mergeTrainRedStrategyPref, mergeTrainAgentFixMaxTurnsPref, mergeTrainAgentFixTimeoutMsPref, mergeTrainAgentFixCostCapUsdPref]) {
      expect(isProjectScopedDynamicKey(pref.key(PROJECT))).toBe(true);
    }
  });
});
