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

/**
 * #646 — the derived plan composed `<test> && <build>` and never read `typecheckCommand`,
 * though the profile persists it. On THIS repo the gap was invisible: its build IS tsc, and
 * its operator had hand-added `pnpm typecheck` to the verify_script. Any project whose build
 * is vite/esbuild-only merged with no typecheck in its gate while carrying a perfectly good
 * typecheckCommand — a gate that depended on per-operator luck rather than on the derivation.
 */
describe("deriveVerifyCommandPlan typecheck composition (#646)", () => {
  it("runs typecheck FIRST, so a type error fails fast before the suite", () => {
    const plan = deriveVerifyCommandPlan(makeProfile({ typecheckCommand: "pnpm typecheck" }));
    expect(plan?.command).toBe("pnpm typecheck && pnpm test:mine && pnpm build");
  });

  it("composes with only a typecheck and a test (no build step)", () => {
    const plan = deriveVerifyCommandPlan(
      makeProfile({ typecheckCommand: "tsc --noEmit", buildCommand: null }),
    );
    expect(plan?.command).toBe("tsc --noEmit && pnpm test:mine");
  });

  it("is unchanged when the profile carries no typecheckCommand", () => {
    expect(deriveVerifyCommandPlan(makeProfile())?.command).toBe("pnpm test:mine && pnpm build");
  });

  it("skips typecheck on gradle/maven, where check/verify already compiles", () => {
    const plan = deriveVerifyCommandPlan({ ...GRADLE, typecheckCommand: "./gradlew compileJava" });
    expect(plan?.command).not.toContain("compileJava");
  });

  it("does NOT wire in lintCommand — a style gate must not withhold a merge", () => {
    const plan = deriveVerifyCommandPlan(
      makeProfile({ lintCommand: "pnpm lint", typecheckCommand: "pnpm typecheck" }),
    );
    expect(plan?.command).toContain("pnpm typecheck");
    expect(plan?.command).not.toContain("pnpm lint");
  });

  it("still returns null when typecheck is the only thing configured is FALSE — it counts", () => {
    // A typecheck alone IS a verification, so a profile carrying only that is not a no-op.
    const plan = deriveVerifyCommandPlan(
      makeProfile({ testCommand: null, quickTestCommand: null, buildCommand: null, typecheckCommand: "tsc --noEmit" }),
    );
    expect(plan?.command).toBe("tsc --noEmit");
  });
});

describe("deriveVerifyCommandPlan (#124)", () => {
  it("returns null when there is nothing to verify", () => {
    expect(deriveVerifyCommandPlan(null)).toBeNull();
    expect(
      deriveVerifyCommandPlan(makeProfile({ testCommand: null, buildCommand: null, quickTestCommand: null })),
    ).toBeNull();
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

  // #120: the uv profile must produce a gate that runs pytest inside the project venv,
  // and its failure hint must not point back at the global `python -m pytest`.
  it("routes a uv project to the pytest plan and keeps `uv run` in the failure hint", () => {
    const plan = deriveVerifyCommandPlan(
      makeProfile({ stack: "python", packageManager: "uv", testRunner: "pytest", testCommand: "uv run pytest", buildCommand: null }),
    )!;
    expect(plan.stackKey).toBe("pytest");
    expect(plan.command).toBe("uv run pytest -q --no-header --tb=short");
    expect(plan.onFailure).toContain("uv run pytest '<path>::<test_name>'");
    expect(plan.onFailure).not.toContain("python -m pytest");
  });

  it("keeps the poetry runner in the pytest failure hint", () => {
    const plan = deriveVerifyCommandPlan(
      makeProfile({ stack: "python", packageManager: "poetry", testRunner: "pytest", testCommand: "poetry run python -m pytest", buildCommand: null }),
    )!;
    expect(plan.onFailure).toContain("poetry run python -m pytest '<path>::<test_name>'");
  });

  it("applies maven batch mode", () => {
    const plan = deriveVerifyCommandPlan(
      makeProfile({ stack: "java", packageManager: "maven", testRunner: "maven", testCommand: "mvn test", buildCommand: "mvn package" }),
    )!;
    expect(plan.stackKey).toBe("maven");
    expect(plan.command).toBe("mvn test package -B");
  });

  it("leaves node commands untouched — project-authored scripts reject injected flags", () => {
    const plan = deriveVerifyCommandPlan(makeProfile({ quickTestCommand: null }))!;
    expect(plan.stackKey).toBe("node");
    expect(plan.command).toBe("pnpm test && pnpm build");
  });

  // #173: a full-suite node gate flaked red under CPU contention (single files timing out at
  // 15-17min) even though every failing suite was green in isolation, and leaked a worker
  // fleet on every retry — a self-amplifying stall. The gate now defaults to the profile's
  // quick/affected-only command instead of the full suite.
  it("prefers quickTestCommand over the full testCommand for the node gate (#173)", () => {
    const plan = deriveVerifyCommandPlan(makeProfile())!;
    expect(plan.stackKey).toBe("node");
    expect(plan.command).toBe("pnpm test:mine && pnpm build");
  });

  it("falls back to the full testCommand when no quickTestCommand is set", () => {
    const plan = deriveVerifyCommandPlan(makeProfile({ quickTestCommand: null }))!;
    expect(plan.command).toBe("pnpm test && pnpm build");
  });

  it("never merges a script runner's scripts — `pnpm test build` would pass 'build' as an arg", () => {
    const plan = deriveVerifyCommandPlan(makeProfile({ quickTestCommand: null, buildCommand: "pnpm run build" }))!;
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

  it("never merges a build that SKIPS tests — the merged run would verify nothing", () => {
    // `-DskipTests` / `-x test` are run-global, not goal-scoped: merged into the test
    // invocation they disable the very tests the gate exists to run, and it still exits 0.
    const maven = deriveVerifyCommandPlan(
      makeProfile({ stack: "java", packageManager: "maven", testRunner: "maven", testCommand: "mvn test", buildCommand: "mvn package -DskipTests" }),
    )!;
    expect(maven.command).toBe("mvn test -B && mvn package -DskipTests -B");

    const gradle = deriveVerifyCommandPlan(
      makeProfile({ stack: "java", packageManager: "gradle", testRunner: "gradle", testCommand: "./gradlew test", buildCommand: "./gradlew build -x test" }),
    )!;
    expect(gradle.command).toBe("./gradlew test --console=plain && ./gradlew build -x test --console=plain");
  });

  it("never merges option flags that carry a value — dedup would strand one of them", () => {
    const plan = deriveVerifyCommandPlan(
      makeProfile({ stack: "java", packageManager: "maven", testRunner: "maven", testCommand: "mvn test -pl core", buildCommand: "mvn package -pl web" }),
    )!;
    // Merging would yield `mvn test package -pl core web` — a malformed invocation.
    expect(plan.command).toBe("mvn test -pl core -B && mvn package -pl web -B");
  });

  it("still merges when both invocations are bare task lists", () => {
    const plan = deriveVerifyCommandPlan(
      makeProfile({ stack: "java", packageManager: "gradle", testRunner: "gradle", testCommand: "./gradlew allTests", buildCommand: "./gradlew build" }),
    )!;
    expect(plan.command).toBe("./gradlew allTests build --console=plain");
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
