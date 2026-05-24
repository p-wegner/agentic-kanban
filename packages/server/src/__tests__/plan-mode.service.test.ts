import { describe, it, expect } from "vitest";
import { extractPlan, PLAN_FILE, buildImplementPrompt } from "../services/plan-mode.service.js";
import { PLAN_BEGIN_MARKER, PLAN_END_MARKER } from "../services/agent-provider.js";

describe("extractPlan", () => {
  it("extracts the block between sentinels", () => {
    const text = `Some preamble.\n${PLAN_BEGIN_MARKER}\n# Plan\n1. Do a thing\n${PLAN_END_MARKER}\ntrailing`;
    expect(extractPlan(text)).toBe("# Plan\n1. Do a thing");
  });

  it("uses the last sentinel pair when markers appear more than once", () => {
    const text = `${PLAN_BEGIN_MARKER}\nold\n${PLAN_END_MARKER}\n${PLAN_BEGIN_MARKER}\nnew plan\n${PLAN_END_MARKER}`;
    expect(extractPlan(text)).toBe("new plan");
  });

  it("falls back to the full trimmed text when markers are absent", () => {
    expect(extractPlan("  just a plan, no markers  ")).toBe("just a plan, no markers");
  });

  it("returns null for empty/whitespace text", () => {
    expect(extractPlan("   \n  ")).toBeNull();
    expect(extractPlan("")).toBeNull();
  });

  it("falls back to full text when the block is empty", () => {
    const text = `before\n${PLAN_BEGIN_MARKER}\n\n${PLAN_END_MARKER}`;
    expect(extractPlan(text)).toContain(PLAN_BEGIN_MARKER);
  });
});

describe("plan-mode constants", () => {
  it("persists to PLAN.md", () => {
    expect(PLAN_FILE).toBe("PLAN.md");
  });

  it("implementation prompt references the plan file", () => {
    expect(buildImplementPrompt()).toContain(PLAN_FILE);
  });
});
