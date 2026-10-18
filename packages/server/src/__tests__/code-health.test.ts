import { describe, expect, it } from "vitest";
import {
  capsForLevel,
  classifyMetric,
  evaluateCleanupTrigger,
  planCleanupAction,
  resolveCodeHealthPosture,
} from "../lib/code-health.js";

describe("code-health posture (#1613)", () => {
  it("derives the level from the risk posture; an override wins; garbage falls back", () => {
    expect(resolveCodeHealthPosture("sprint").level).toBe("relaxed");
    expect(resolveCodeHealthPosture("standard").level).toBe("balanced");
    expect(resolveCodeHealthPosture("strict").level).toBe("strict");
    expect(resolveCodeHealthPosture("sprint", "strict")).toMatchObject({ level: "strict", source: "override" });
    expect(resolveCodeHealthPosture("sprint", "nonsense").source).toBe("risk-posture");
  });

  it("classifies soft vs hard, and a grandfathered baseline raises only the hard cap", () => {
    const c = capsForLevel("relaxed");
    expect(classifyMetric("lines", 1000, c)).toBe("ok");
    expect(classifyMetric("lines", 1200, c)).toBe("soft");
    expect(classifyMetric("lines", 1601, c)).toBe("hard");
    expect(classifyMetric("branches", 50, c, 55)).toBe("soft");
    expect(classifyMetric("branches", 56, c, 55)).toBe("hard");
  });

  it("pins the proposed table", () => {
    expect(capsForLevel("strict").lines).toEqual({ soft: 800, hard: 1000 });
    expect(capsForLevel("balanced").branches).toEqual({ soft: 25, hard: 35 });
    expect(capsForLevel("relaxed").cleanupTrigger).toEqual({ breaches: 10, days: 14 });
  });

  it("plans one ticket at a time", () => {
    const due = { due: true, reason: "", breaches: 10, files: 4 };
    expect(planCleanupAction(due, null)).toBe("file");
    expect(planCleanupAction(due, { issueId: "i", issueNumber: 1, started: false })).toBe("append");
    expect(planCleanupAction(due, { issueId: "i", issueNumber: 1, started: true })).toBe("hold");
    expect(planCleanupAction({ ...due, due: false }, null)).toBe("none");
    expect(evaluateCleanupTrigger([], capsForLevel("strict"), 0).due).toBe(false);
  });
});
