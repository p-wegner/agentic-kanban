import { describe, it, expect } from "vitest";
import { ISSUE_PRIORITIES, normalizeIssuePriority } from "../src/lib/issue-priority.js";

describe("normalizeIssuePriority (#516)", () => {
  it("passes canonical values through", () => {
    for (const p of ISSUE_PRIORITIES) {
      expect(normalizeIssuePriority(p)).toBe(p);
    }
  });

  it('folds "urgent" to "critical" — the AI vocabulary that leaked into stored issues', () => {
    // The decompose prompt asks the model for "urgent" and its validator accepted it, so
    // children were created with a priority that sorts at rank 0 (PRIORITY_ORDER lists
    // it) but has no colour in priorityColors and no lane in PRIORITY_LANE_STYLES.
    expect(normalizeIssuePriority("urgent")).toBe("critical");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeIssuePriority("  URGENT ")).toBe("critical");
    expect(normalizeIssuePriority("High")).toBe("high");
  });

  it("folds an unknown value to the fallback rather than storing it verbatim", () => {
    // Storing an unrecognised priority is what produced the unstyled-but-top-sorted issue.
    expect(normalizeIssuePriority("spicy")).toBe("medium");
    expect(normalizeIssuePriority("spicy", "low")).toBe("low");
  });

  it("handles absent input", () => {
    expect(normalizeIssuePriority(null)).toBe("medium");
    expect(normalizeIssuePriority(undefined)).toBe("medium");
    expect(normalizeIssuePriority("")).toBe("medium");
  });

  it("never returns a value outside the canonical set", () => {
    for (const raw of ["urgent", "crit", "normal", "", "nonsense", "LOW", null, undefined]) {
      expect(ISSUE_PRIORITIES).toContain(normalizeIssuePriority(raw as string | null));
    }
  });
});
