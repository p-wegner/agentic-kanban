// @covers onboarding.wizard.stepInput [ui, boundary, state-transition]
//
// The onboarding wizard's apply-enable rules (#464). These decide whether the Apply button is
// live, what gets sent as `input`, and which steps have no inline apply path at all — the three
// ways this screen can be wrong in a way the user cannot see.
//
// The component fetches its plan on mount, which the package's static-markup test convention
// (no @testing-library/react — cf. ButlerQuestionCard.test.tsx) cannot drive, so the rules live
// in an exported pure function and are tested directly.

import { describe, expect, it } from "vitest";
import type { OnboardingStep } from "@agentic-kanban/shared/lib/onboarding-plan";
import { onboardingStepInput } from "./OnboardingWizard.js";
import { useOnboardingStore } from "../stores/onboardingStore.js";

function configStep(id: string, configKey: OnboardingStep extends { configKey: infer K } ? K : never): OnboardingStep {
  return { id, kind: "config", configKey, title: id, rationale: "", status: "pending", optional: true } as OnboardingStep;
}

describe("onboardingStepInput — config steps that need a value", () => {
  it("blocks apply until a start mode is picked, then sends it", () => {
    const step = configStep("start-mode", "start-mode");
    expect(onboardingStepInput(step, {})).toBeNull();
    expect(onboardingStepInput(step, { "start-mode": "monitor" })).toEqual({ value: "monitor" });
  });

  it("sends the WIP limit as a NUMBER and rejects junk or < 1", () => {
    const step = configStep("wip-limit", "wip-limit");
    expect(onboardingStepInput(step, {})).toBeNull();
    expect(onboardingStepInput(step, { "wip-limit": "abc" })).toBeNull();
    // The server requires a positive finite number; 0 and negatives must not reach it.
    expect(onboardingStepInput(step, { "wip-limit": "0" })).toBeNull();
    expect(onboardingStepInput(step, { "wip-limit": "-2" })).toBeNull();
    expect(onboardingStepInput(step, { "wip-limit": "2" })).toEqual({ value: 2 });
  });

  it("accepts either script alone, and omits the one left blank", () => {
    const step = configStep("setup-verify-scripts", "setup-verify-scripts");
    expect(onboardingStepInput(step, {})).toBeNull();
    // Whitespace is not a value — otherwise a stray space would write an empty setup script.
    expect(onboardingStepInput(step, { "setup-verify-scripts:setup": "   " })).toBeNull();
    expect(onboardingStepInput(step, { "setup-verify-scripts:setup": "pnpm install -r" }))
      .toEqual({ setupScript: "pnpm install -r" });
    expect(onboardingStepInput(step, { "setup-verify-scripts:verify": "pnpm test" }))
      .toEqual({ verifyScript: "pnpm test" });
    expect(onboardingStepInput(step, {
      "setup-verify-scripts:setup": "pnpm install -r",
      "setup-verify-scripts:verify": "pnpm test",
    })).toEqual({ setupScript: "pnpm install -r", verifyScript: "pnpm test" });
  });
});

describe("onboardingStepInput — steps with no inline apply path", () => {
  // extra-repos has no server apply path at all (it throws — repos go through
  // POST /api/projects/:id/repos), so offering an Apply button would be a guaranteed error.
  it.each(["strategy-bullseye", "extra-repos"] as const)("routes %s to its real editor", (key) => {
    expect(onboardingStepInput(configStep(key, key), {})).toBe("external");
  });
});

describe("onboardingStepInput — steps that apply with no input", () => {
  it("confirms the stack profile with an empty body", () => {
    expect(onboardingStepInput(configStep("stack-profile", "stack-profile"), {})).toEqual({});
  });

  it("applies plugin / init-skill / ticket steps with no input", () => {
    const steps: OnboardingStep[] = [
      { id: "plugin:x", kind: "plugin", pluginRowId: "r", pluginSlug: "x", title: "", rationale: "", status: "pending", optional: true },
      { id: "init-skill:y", kind: "init-skill", skillId: "y", skillName: "y", title: "", rationale: "", status: "pending", optional: true },
      { id: "ticket:z", kind: "ticket", catalogId: "z", title: "", rationale: "", status: "pending", optional: true },
    ];
    for (const step of steps) expect(onboardingStepInput(step, {})).toEqual({});
  });
});

describe("onboardingStore", () => {
  it("opens for a project and clears everything on close", () => {
    useOnboardingStore.getState().openOnboarding("p1", "Pantry", { justImported: true });
    expect(useOnboardingStore.getState()).toMatchObject({ projectId: "p1", projectName: "Pantry", justImported: true });

    useOnboardingStore.getState().closeOnboarding();
    expect(useOnboardingStore.getState()).toMatchObject({ projectId: null, projectName: null, justImported: false });
  });

  it("defaults justImported to false when reopened deliberately", () => {
    useOnboardingStore.getState().openOnboarding("p2", "Bookvault");
    expect(useOnboardingStore.getState().justImported).toBe(false);
    useOnboardingStore.getState().closeOnboarding();
  });
});
