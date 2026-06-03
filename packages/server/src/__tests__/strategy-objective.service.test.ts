import { describe, expect, it } from "vitest";
import {
  deriveMonitorTunables,
  parseStrategyBullseyeConfig,
  resolveMonitorTunables,
  updateObjectiveWithStrategy,
} from "../services/strategy-objective.service.js";

describe("strategy objective translation", () => {
  it("maps bugfix-heavy bullseye weights to bugfix-only refill focus", () => {
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      activeAgentsTarget: 5,
      backlogFloor: 12,
      maxNewStartsPerCycle: 3,
      segments: [
        { id: "bugfix", label: "Bugfix", kind: "work-type", weight: 5, keywords: "bug fix regression" },
        { id: "feature", label: "Feature", kind: "work-type", weight: 2, keywords: "feature" },
        { id: "quality", label: "Quality", kind: "work-type", weight: 2, keywords: "quality" },
      ],
    }));

    expect(deriveMonitorTunables(config)).toEqual({
      activeAgentsTarget: 5,
      backlogFloor: 12,
      maxNewStartsPerCycle: 3,
      refillFocus: "bugfix-only",
    });
  });

  it("replaces only the tunables region and preserves monitor prose", () => {
    const objective = [
      "Intro prose",
      "",
      "## TUNABLE TARGETS - edit these live to steer the loop",
      "> old note",
      "- **ACTIVE_AGENTS_TARGET = 4** - old",
      "- **BACKLOG_FLOOR = 10** - old",
      "- **MAX_NEW_STARTS_PER_CYCLE = 2** - old",
      "- **REFILL_FOCUS = balanced** - old",
      "",
      "FIRST, READ YOUR RECENT MEMORY: keep this prose",
      "",
      "Each run, do work.",
    ].join("\n");
    const config = parseStrategyBullseyeConfig(JSON.stringify({
      segments: [
        { id: "feature", label: "Feature", kind: "work-type", weight: 5, keywords: "feature" },
        { id: "bugfix", label: "Bugfix", kind: "work-type", weight: 1, keywords: "bug fix" },
      ],
    }));

    const updated = updateObjectiveWithStrategy(objective, config);

    expect(updated).toContain("<!-- STRATEGY_BULLSEYE_GENERATED_START -->");
    expect(updated).toContain("<!-- STRATEGY_BULLSEYE_GENERATED_END -->");
    expect(updated).toContain("**REFILL_FOCUS = balanced**");
    expect(updated).toContain("Feature: weight 5/5");
    expect(updated).toContain("FIRST, READ YOUR RECENT MEMORY: keep this prose");
    expect(updated).toContain("Each run, do work.");
    expect(updated).not.toContain("> old note");
  });
});

describe("resolveMonitorTunables — in-process monitor wiring", () => {
  it("derives tunables from a saved Strategy Bullseye", () => {
    const prefMap = new Map<string, string>([
      ["board_strategy_proj-1", JSON.stringify({
        activeAgentsTarget: 6,
        backlogFloor: 12,
        maxNewStartsPerCycle: 3,
        segments: [{ id: "bugfix", label: "Bugfix", kind: "work-type", weight: 5, keywords: "bug fix regression" }],
      })],
    ]);
    const { tunables, source } = resolveMonitorTunables(prefMap, "proj-1");
    expect(source).toBe("strategy");
    expect(tunables).toEqual({ activeAgentsTarget: 6, backlogFloor: 12, maxNewStartsPerCycle: 3, refillFocus: "bugfix-only" });
  });

  it("falls back to legacy nudge prefs (floor 1, no per-cycle cap) when no strategy exists", () => {
    const prefMap = new Map<string, string>([["nudge_wip_limit", "5"]]);
    const { tunables, source } = resolveMonitorTunables(prefMap, "proj-1");
    expect(source).toBe("prefs");
    expect(tunables.activeAgentsTarget).toBe(5);
    expect(tunables.backlogFloor).toBe(1);
    expect(tunables.maxNewStartsPerCycle).toBe(Number.POSITIVE_INFINITY);
    expect(tunables.refillFocus).toBe("balanced");
  });

  it("falls back to legacy prefs when the strategy JSON is malformed", () => {
    const prefMap = new Map<string, string>([
      ["board_strategy_proj-1", "{not valid json"],
      ["nudge_wip_limit", "3"],
    ]);
    const { tunables, source } = resolveMonitorTunables(prefMap, "proj-1");
    expect(source).toBe("prefs");
    expect(tunables.activeAgentsTarget).toBe(3);
  });
});
