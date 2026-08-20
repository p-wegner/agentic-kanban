// @covers onboarding.banner.pendingCount [boundary]
//
// The persistent "setup incomplete" board affordance (#475) shows only when there is a
// non-optional step still pending — an optional step or one the user already skipped/applied
// must never trip it, or the banner would nag forever.

import { describe, expect, it } from "vitest";
import type { OnboardingPlan, OnboardingStep } from "@agentic-kanban/shared/lib/onboarding-plan";
import { pendingRequiredStepCount } from "./useOnboardingStatus.js";

function plan(steps: Partial<OnboardingStep>[]): OnboardingPlan {
  return {
    projectId: "p1",
    dismissedAt: null,
    steps: steps.map((s, i) => ({
      id: `s${i}`,
      kind: "config",
      configKey: "stack-profile",
      title: "",
      rationale: "",
      optional: false,
      status: "pending",
      ...s,
    })) as OnboardingStep[],
  };
}

describe("pendingRequiredStepCount", () => {
  it("returns 0 for a null plan", () => {
    expect(pendingRequiredStepCount(null)).toBe(0);
  });

  it("counts only non-optional, pending steps", () => {
    expect(pendingRequiredStepCount(plan([
      { optional: false, status: "pending" },
      { optional: true, status: "pending" }, // optional — must not count
      { optional: false, status: "done" }, // already applied — must not count
      { optional: false, status: "skipped" }, // explicitly skipped — must not count
      { optional: false, status: "not-applicable" },
    ]))).toBe(1);
  });

  it("is 0 once every required step is done or skipped", () => {
    expect(pendingRequiredStepCount(plan([
      { optional: false, status: "done" },
      { optional: false, status: "skipped" },
    ]))).toBe(0);
  });
});
