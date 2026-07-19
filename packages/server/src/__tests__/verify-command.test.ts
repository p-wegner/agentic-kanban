// Canonical per-stack verify command (#124).
import { describe, it, expect } from "vitest";
import {
  deriveVerifyCommandPlan,
  deriveVerifyCommand,
} from "@agentic-kanban/shared/lib/verify-command";
import { buildStackProfileSection } from "@agentic-kanban/shared/lib/ticket-context";
import type { StackProfile } from "@agentic-kanban/shared";

function makeProfile(overrides: Partial<StackProfile> = {}): StackProfile {
  return {
    stack: "node",
    packageManager: "pnpm",
    isMonorepo: false,
    workspaces: [],
    installCommand: "pnpm install",
    buildCommand: "pnpm build",
    testCommand: "pnpm test",
    quickTestCommand: "pnpm test:mine",
    lintCommand: null,
    typecheckCommand: null,
    devCommand: null,
    isWeb: false,
    devHealthUrl: null,
    devPort: null,
    testDir: null,
    testRunner: "vitest",
    source: "detected",
    detectedMarkers: ["package.json"],
    updatedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

const GRADLE = makeProfile({
  stack: "java",
  packageManager: "gradle",
  testRunner: "gradle",
  testCommand: "./gradlew test",
  buildCommand: "./gradlew build",
  quickTestCommand: "./gradlew test",
});

const PYTHON = makeProfile({
  stack: "python",
  packageManager: "pip",
  testRunner: "pytest",
  testCommand: "python -m pytest",
  buildCommand: null,
  quickTestCommand: "python -m pytest -x",
});

describe("deriveVerifyCommandPlan (#124)", () => {
  it("returns null when there is nothing to verify", () => {
    expect(deriveVerifyCommandPlan(null)).toBeNull();
    expect(deriveVerifyCommandPlan(makeProfile({ testCommand: null, buildCommand: null }))).toBeNull();
    expect(deriveVerifyCommand(null)).toBe("");
  });

  it("collapses same-runner test+build into ONE gradle invocation with plain console", () => {
    const plan = deriveVerifyCommandPlan(GRADLE)!;
    expect(plan.stackKey).toBe("gradle");
    expect(plan.command).toBe("./gradlew test build --console=plain");
    // One invocation, not two daemon round-trips.
    expect(plan.command).not.toContain("&&");
  });

  it("keeps gradle failure lines visible (no --quiet, which hides them)", () => {
    expect(deriveVerifyCommandPlan(GRADLE)!.command).not.toMatch(/(^|\s)(-q|--quiet)(\s|$)/);
  });

  it("does not duplicate a flag the detected command already carries", () => {
    const plan = deriveVerifyCommandPlan(
      makeProfile({
        packageManager: "gradle",
        stack: "java",
        testCommand: "./gradlew test --console=plain",
        buildCommand: null,
      }),
    )!;
    expect(plan.command.match(/--console=plain/g)).toHaveLength(1);
  });

  it("applies pytest's quiet + short-traceback flags", () => {
    const plan = deriveVerifyCommandPlan(PYTHON)!;
    expect(plan.stackKey).toBe("pytest");
    expect(plan.command).toBe("python -m pytest -q --no-header --tb=short");
  });

  it("routes a poetry-wrapped pytest project to the pytest plan", () => {
    const plan = deriveVerifyCommandPlan(
      makeProfile({ stack: "python", packageManager: "poetry", testRunner: "pytest", testCommand: "poetry run python -m pytest", buildCommand: null }),
    )!;
    expect(plan.stackKey).toBe("pytest");
    expect(plan.command).toContain("--tb=short");
  });

  it("applies maven batch mode", () => {
    const plan = deriveVerifyCommandPlan(
      makeProfile({ stack: "java", packageManager: "maven", testRunner: "maven", testCommand: "mvn test", buildCommand: "mvn package" }),
    )!;
    expect(plan.stackKey).toBe("maven");
    expect(plan.command).toBe("mvn test package -B");
  });

  it("leaves node commands untouched — project-authored scripts reject injected flags", () => {
    const plan = deriveVerifyCommandPlan(makeProfile())!;
    expect(plan.stackKey).toBe("node");
    expect(plan.command).toBe("pnpm test && pnpm build");
  });

  it("never merges a script runner's scripts — `pnpm test build` would pass 'build' as an arg", () => {
    const plan = deriveVerifyCommandPlan(makeProfile({ buildCommand: "pnpm run build" }))!;
    expect(plan.command).toBe("pnpm test && pnpm run build");
  });

  it("keeps pytest flags off a non-pytest build step in a chained command", () => {
    const plan = deriveVerifyCommandPlan(
      makeProfile({ stack: "python", packageManager: "pip", testRunner: "pytest", testCommand: "python -m pytest", buildCommand: "python -m build" }),
    )!;
    expect(plan.command).toBe("python -m pytest -q --no-header --tb=short && python -m build");
  });

  it("flags EACH segment when two gradle wrappers cannot be merged", () => {
    const plan = deriveVerifyCommandPlan(
      makeProfile({ stack: "java", packageManager: "gradle", testRunner: "gradle", testCommand: "./gradlew test", buildCommand: "./sub/gradlew build" }),
    )!;
    expect(plan.command).toBe("./gradlew test --console=plain && ./sub/gradlew build --console=plain");
  });

  it("joins different runners with && rather than merging their args", () => {
    const plan = deriveVerifyCommandPlan(
      makeProfile({ stack: "other", packageManager: "make", testRunner: null, testCommand: "make test", buildCommand: "cmake --build ." }),
    )!;
    expect(plan.command).toBe("make test && cmake --build .");
  });

  it("carries the PowerShell exit-honesty rules on every stack", () => {
    for (const profile of [GRADLE, PYTHON, makeProfile()]) {
      const rules = deriveVerifyCommandPlan(profile)!.rules.join(" ");
      expect(rules).toContain("2>&1");
      expect(rules).toContain("Select -Last N");
      expect(rules).toMatch(/XML/);
    }
  });

  it("directs a failing native-exe stack to a narrow re-run, not the report", () => {
    expect(deriveVerifyCommandPlan(GRADLE)!.onFailure).toContain("--tests");
    expect(deriveVerifyCommandPlan(PYTHON)!.onFailure).toContain("--tb=long");
  });
});

describe("buildStackProfileSection verify block (#124)", () => {
  it("renders the canonical command and its rules for the builder", () => {
    const section = buildStackProfileSection(GRADLE)!;
    expect(section).toContain("### Verify (the merge gate)");
    expect(section).toContain("./gradlew test build --console=plain");
    expect(section).toContain("2>&1");
    expect(section).toContain("do not hand-roll your own build/test invocation");
  });

  it("omits the verify block when nothing is verifiable", () => {
    const section = buildStackProfileSection(
      makeProfile({ testCommand: null, buildCommand: null, quickTestCommand: null, installCommand: "pnpm install" }),
    )!;
    expect(section).toContain("Install deps");
    expect(section).not.toContain("### Verify");
  });
});
