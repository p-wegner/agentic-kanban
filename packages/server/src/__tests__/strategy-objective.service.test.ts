import { describe, expect, it } from "vitest";
import {
  deriveMonitorTunables,
  parseStrategyBullseyeConfig,
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
