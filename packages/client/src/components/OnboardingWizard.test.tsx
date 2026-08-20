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
import {
  nextWizardPage,
  onboardingStepInput,
  prevWizardPage,
  visibleOnboardingSections,
  type OnboardingWizardPage,
} from "./OnboardingWizard.js";
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

describe("onboardingStepInput — strategy-bullseye (#475 inline apply)", () => {
  it("blocks apply until a provider is picked", () => {
    const step = configStep("strategy-bullseye", "strategy-bullseye");
    expect(onboardingStepInput(step, {})).toBeNull();
    // Junk provider values (e.g. a stray draft key collision) must not slip through.
    expect(onboardingStepInput(step, { "strategy-bullseye:provider": "not-a-provider" })).toBeNull();
  });

  it("sends a JSON-encoded config with a single fill policy for the picked provider", () => {
    const step = configStep("strategy-bullseye", "strategy-bullseye");
    const result = onboardingStepInput(step, { "strategy-bullseye:provider": "codex" });
    expect(result).not.toBeNull();
    const config = JSON.parse((result as { value: string }).value);
    expect(config.providerPolicies).toHaveLength(1);
    expect(config.providerPolicies[0]).toMatchObject({ provider: "codex", profileName: "", mode: "fill" });
  });

  it("carries an optional profile name into the fill policy", () => {
    const step = configStep("strategy-bullseye", "strategy-bullseye");
    const result = onboardingStepInput(step, {
      "strategy-bullseye:provider": "claude",
      "strategy-bullseye:profile": "  fast  ",
    });
    const config = JSON.parse((result as { value: string }).value);
    expect(config.providerPolicies[0]).toMatchObject({ provider: "claude", profileName: "fast" });
  });
});

describe("onboardingStepInput — extra-repos (#475: routed to its own control, not this apply path)", () => {
  it("always returns null — the extra-repos control posts to POST /api/projects/:id/repos directly", () => {
    expect(onboardingStepInput(configStep("extra-repos", "extra-repos"), {})).toBeNull();
    expect(onboardingStepInput(configStep("extra-repos", "extra-repos"), { "extra-repos:repo": "../sibling" })).toBeNull();
  });
});

describe("wizard paging (#475)", () => {
  function step(kind: OnboardingStep["kind"], id: string): OnboardingStep {
    return { id, kind, title: id, rationale: "", status: "pending", optional: true, ...(kind === "config" ? { configKey: "stack-profile" } : {}) } as OnboardingStep;
  }

  it("visibleOnboardingSections skips a section with no steps of that kind", () => {
    const steps = [step("config", "c1"), step("ticket", "t1")];
    const kinds = visibleOnboardingSections(steps).map((s) => s.kind);
    expect(kinds).toEqual(["config", "ticket"]);
  });

  it("nextWizardPage advances through sections and lands on summary after the last", () => {
    let page: OnboardingWizardPage = { kind: "section", index: 0 };
    page = nextWizardPage(page, 3);
    expect(page).toEqual({ kind: "section", index: 1 });
    page = nextWizardPage(page, 3);
    expect(page).toEqual({ kind: "section", index: 2 });
    page = nextWizardPage(page, 3);
    expect(page).toEqual({ kind: "summary" });
    // Idempotent once on the summary — no section beyond the last.
    page = nextWizardPage(page, 3);
    expect(page).toEqual({ kind: "summary" });
  });

  it("prevWizardPage steps back through sections, from the summary to the last section, and clamps at the first", () => {
    expect(prevWizardPage({ kind: "summary" }, 3)).toEqual({ kind: "section", index: 2 });
    expect(prevWizardPage({ kind: "section", index: 1 }, 3)).toEqual({ kind: "section", index: 0 });
    expect(prevWizardPage({ kind: "section", index: 0 }, 3)).toEqual({ kind: "section", index: 0 });
  });
});

describe("onboardingStepInput — steps that apply with no input", () => {
  it("confirms the stack profile with an empty body", () => {
    expect(onboardingStepInput(configStep("stack-profile", "stack-profile"), {})).toEqual({});
  });

  it("applies init-skill / ticket steps with no input", () => {
    const steps: OnboardingStep[] = [
      { id: "init-skill:y", kind: "init-skill", skillId: "y", skillName: "y", title: "", rationale: "", status: "pending", optional: true },
      { id: "ticket:z", kind: "ticket", catalogId: "z", title: "", rationale: "", status: "pending", optional: true },
    ];
    for (const step of steps) expect(onboardingStepInput(step, {})).toEqual({});
  });
});

describe("onboardingStepInput — plugin steps require an explicit output-location choice", () => {
  function pluginStep(overrides: Partial<Extract<OnboardingStep, { kind: "plugin" }>> = {}): OnboardingStep {
    return {
      id: "plugin:x",
      kind: "plugin",
      pluginRowId: "r",
      pluginSlug: "x",
      installSource: null,
      scaffoldPlaceholders: 0,
      title: "",
      rationale: "",
      status: "pending",
      optional: true,
      ...overrides,
    };
  }

  it("blocks apply until leading/sidecar is picked, then sends it — never a silent default", () => {
    const step = pluginStep();
    expect(onboardingStepInput(step, {})).toBeNull();
    expect(onboardingStepInput(step, { "plugin:x:location": "leading" })).toEqual({ location: "leading" });
    expect(onboardingStepInput(step, { "plugin:x:location": "sidecar" })).toEqual({ location: "sidecar" });
  });

  it("also applies to a not-yet-installed marketplace plugin (installSource set)", () => {
    const step = pluginStep({ pluginRowId: null, installSource: "https://example.com/plugin.git" });
    expect(onboardingStepInput(step, {})).toBeNull();
    expect(onboardingStepInput(step, { "plugin:x:location": "sidecar" })).toEqual({ location: "sidecar" });
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
