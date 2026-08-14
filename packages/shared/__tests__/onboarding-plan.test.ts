import { describe, expect, it } from "vitest";
import {
  ONBOARDING_CONFIG_STEPS,
  ONBOARDING_TICKET_CATALOG,
  emptyOnboardingState,
  onboardingUnitKey,
  onboardingUnitKeyPrefix,
  parseOnboardingState,
  parseOnboardingUnitKey,
} from "../src/lib/onboarding-plan.js";
import { isProjectScopedDynamicKey } from "../src/lib/dynamic-preference-keys.js";
import type { StackProfile } from "../src/types/api/project.js";

const PROJECT_ID = "6f9b6a7a-1b2c-4d3e-8f9a-0a1b2c3d4e5f";

function profile(overrides: Partial<StackProfile>): StackProfile {
  return {
    stack: null,
    packageManager: null,
    isMonorepo: false,
    workspaces: [],
    installCommand: null,
    buildCommand: null,
    testCommand: null,
    quickTestCommand: null,
    lintCommand: null,
    typecheckCommand: null,
    devCommand: null,
    isWeb: false,
    devHealthUrl: null,
    devPort: null,
    testDir: null,
    testRunner: null,
    source: "detected",
    detectedMarkers: [],
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("onboardingUnitKey / parseOnboardingUnitKey", () => {
  it("round-trips a simple step id", () => {
    const key = onboardingUnitKey(PROJECT_ID, "ticket:write-readme");
    expect(key).toBe(`onboarding:${PROJECT_ID}:ticket:write-readme`);
    expect(parseOnboardingUnitKey(key)).toEqual({ projectId: PROJECT_ID, stepId: "ticket:write-readme" });
  });

  it("keeps a colon-bearing tail intact (unit id is unconstrained, only ever the tail)", () => {
    const key = onboardingUnitKey(PROJECT_ID, "init-skill:abc:def");
    expect(parseOnboardingUnitKey(key)).toEqual({ projectId: PROJECT_ID, stepId: "init-skill:abc:def" });
  });

  it("is recognized by the LIKE prefix helper", () => {
    const key = onboardingUnitKey(PROJECT_ID, "config:start-mode");
    expect(key.startsWith(onboardingUnitKeyPrefix(PROJECT_ID))).toBe(true);
  });

  it("returns null for a non-onboarding key", () => {
    expect(parseOnboardingUnitKey("plugin-loop:foo:bar:baz")).toBeNull();
    expect(parseOnboardingUnitKey(null)).toBeNull();
    expect(parseOnboardingUnitKey(undefined)).toBeNull();
  });

  it("returns null when there is no step-id tail", () => {
    expect(parseOnboardingUnitKey(`onboarding:${PROJECT_ID}:`)).toBeNull();
    expect(parseOnboardingUnitKey("onboarding:")).toBeNull();
  });
});

describe("onboarding state", () => {
  it("emptyOnboardingState has no skips and no dismissal", () => {
    expect(emptyOnboardingState()).toEqual({ version: 1, skippedStepIds: [] });
  });

  it("parseOnboardingState round-trips a written state", () => {
    const state = { version: 1 as const, skippedStepIds: ["a", "b"], dismissedAt: "2026-08-14T00:00:00.000Z" };
    expect(parseOnboardingState(JSON.stringify(state))).toEqual(state);
  });

  it("parseOnboardingState falls back to empty on null/garbage input", () => {
    expect(parseOnboardingState(null)).toEqual(emptyOnboardingState());
    expect(parseOnboardingState("not json {")).toEqual(emptyOnboardingState());
    expect(parseOnboardingState(JSON.stringify({ foo: "bar" }))).toEqual(emptyOnboardingState());
  });
});

describe("onboarding_state preference key is registered", () => {
  it("is recognized as a project-scoped dynamic key", () => {
    expect(isProjectScopedDynamicKey(`onboarding_state_${PROJECT_ID}`)).toBe(true);
  });
});

describe("ONBOARDING_CONFIG_STEPS", () => {
  it("has unique ids and matching configKeys", () => {
    const ids = ONBOARDING_CONFIG_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of ONBOARDING_CONFIG_STEPS) {
      expect(step.id).toBe(step.configKey);
    }
  });
});

describe("ONBOARDING_TICKET_CATALOG", () => {
  it("has unique ids", () => {
    const ids = ONBOARDING_TICKET_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("suggests a verify gate + first test only when there is no detected test command", () => {
    const entry = ONBOARDING_TICKET_CATALOG.find((e) => e.id === "add-verify-gate")!;
    expect(entry.appliesWhen(profile({ testCommand: null }))).toBe(true);
    expect(entry.appliesWhen(profile({ testCommand: "pnpm test" }))).toBe(false);
    expect(entry.appliesWhen(null)).toBe(true);
  });

  it("every entry applies to a project with no stack profile at all", () => {
    for (const entry of ONBOARDING_TICKET_CATALOG) {
      // Every catalog entry must have a defined opinion about the "no profile yet" case —
      // a freshly imported project before scaffolding finishes.
      expect(typeof entry.appliesWhen(null)).toBe("boolean");
    }
  });
});
