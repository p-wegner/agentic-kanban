// Stack-aware test scaffold derived from the stack profile (#793; #911 split).
//
// Derives + writes a single trivially-passing, runnable test file in the project's real
// test directory + runner syntax, so a freshly-registered project gets a green test from
// ticket #1. Re-exported byte-identically through ../stack-profile.service.ts.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StackProfile } from "@agentic-kanban/shared";
import { isKotlinGradle } from "../gradle-detect.service.js";

/**
 * A single runnable test file derived from a stack profile: where it goes (repo-relative,
 * forward-slashed) and what it contains. The board's `e2e-author` skill is hard-coded to
 * agentic-kanban's `packages/e2e/tests` + Playwright layout (C-rated); for a *driven* project
 * that means no runnable scaffold in its real layout. This produces one in the project's actual
 * test dir, written in the syntax its detected runner expects (pytest, cargo test, vitest,
 * go test, …), so a freshly-registered project gets a green, runnable test from ticket #1.
 */
export interface TestScaffold {
  /** Repo-relative path for the scaffold file, using forward slashes. */
  path: string;
  /** The file contents — a trivially-passing but real test in the runner's syntax. */
  content: string;
}

/** Default test directory for a stack family when the profile didn't detect one. */
const STACK_DEFAULT_TEST_DIR: Record<string, string> = {
  node: "tests",
  rust: "tests",
  go: ".",
  python: "tests",
  java: "src/test/java",
  ruby: "test",
  elixir: "test",
};

/**
 * Facts about the project that only an I/O-doing caller can know, threaded into the otherwise
 * pure derivation (#39). `writeTestScaffold` reads them off disk; callers that can't (or won't)
 * read the manifest simply omit them and get the conservative "write nothing" behaviour for a
 * Node project whose runner can't be established.
 */
export interface ScaffoldHints {
  /** `dependencies` + `devDependencies` names declared in the project's manifest. */
  declaredDeps?: readonly string[];
  /**
   * The project's test command with package-manager indirection resolved — e.g. a profile
   * `testCommand` of "npm test" resolved through package.json `scripts.test` to "node --test".
   */
  resolvedTestCommand?: string | null;
}

/** Node runners we can positively identify from a test command's text. */
function runnerFromCommand(command: string | null | undefined): string | null {
  const cmd = (command ?? "").toLowerCase();
  if (!cmd.trim()) return null;
  // The built-in runner: `node --test`, `node --experimental-test-runner`, or an explicit node:test.
  if (/\bnode\b[^&|]*\s--(?:experimental-)?test\b/.test(cmd) || /\bnode:test\b/.test(cmd)) return "node:test";
  if (/\bvitest\b/.test(cmd)) return "vitest";
  if (/\bjest\b/.test(cmd)) return "jest";
  if (/\bmocha\b/.test(cmd)) return "mocha";
  if (/\bplaywright\b/.test(cmd)) return "playwright";
  if (/\bpytest\b/.test(cmd)) return "pytest";
  if (/\bcargo\s+test\b/.test(cmd)) return "cargo";
  if (/\bgo\s+test\b/.test(cmd)) return "go";
  return null;
}

/** The first Node runner the project actually declares as a dependency, if any. */
function runnerFromDeps(declaredDeps: readonly string[] | undefined): string | null {
  if (!declaredDeps) return null;
  const deps = new Set(declaredDeps.map((d) => d.toLowerCase()));
  if (deps.has("vitest")) return "vitest";
  if (deps.has("jest")) return "jest";
  if (deps.has("mocha")) return "mocha";
  if (deps.has("@playwright/test") || deps.has("playwright")) return "playwright";
  return null;
}

/** Map a (possibly null) testRunner + stack to the canonical runner key we generate for. */
function resolveRunnerKey(profile: StackProfile, isKotlin?: boolean, hints?: ScaffoldHints): string | null {
  const runner = (profile.testRunner ?? "").toLowerCase();
  if (runner.includes("pytest")) return "pytest";
  if (runner.includes("vitest")) return "vitest";
  if (runner.includes("jest")) return "jest";
  if (runner.includes("mocha")) return "mocha";
  if (runner.includes("playwright")) return "playwright";
  if (runner.includes("cargo")) return "cargo";
  if (runner.includes("node:test") || runner === "node --test") return "node:test";
  if (runner.includes("go")) return "go";
  // Kotlin on Gradle/Maven uses the multiplatform `kotlin.test` API, not a JUnit `.java` file.
  if ((runner === "gradle" || runner === "maven") && isKotlin) return "kotlintest";
  if (runner === "gradle" || runner === "maven") return "junit";

  // No (or unrecognized) runner — the project's own test command is the next-best evidence, and
  // it is authoritative: a project running `node --test` must NOT be handed a vitest file (#39).
  const fromCommand = runnerFromCommand(hints?.resolvedTestCommand) ?? runnerFromCommand(profile.testCommand);
  if (fromCommand) return fromCommand;

  // Still unknown. For Node there is no safe conventional default: assuming vitest in a project
  // that doesn't depend on it writes an unresolvable import into the project's test dir and breaks
  // its previously-passing test command. Only fall back to a runner the project actually declares;
  // otherwise write nothing (callers treat null as a safe no-op) — a missing starter file costs
  // nothing, a wrong guess costs the project's test run.
  if (profile.stack === "node") return runnerFromDeps(hints?.declaredDeps);

  // Non-Node families have a genuinely conventional runner that needs no manifest dependency.
  switch (profile.stack) {
    case "python": return "pytest";
    case "rust": return "cargo";
    case "go": return "go";
    case "java": return "junit";
    default: return null;
  }
}

/** Whether a node test file should be `.ts` (TS project) or `.js`. */
function nodeTestExtension(profile: StackProfile, isTypeScript?: boolean): "ts" | "js" {
  if (isTypeScript) return "ts";
  // testCommand referencing tsc / a `.ts` path is a decent secondary signal; default to `.js`,
  // which runs under every Node runner regardless of TS setup.
  const cmd = `${profile.testCommand ?? ""} ${profile.typecheckCommand ?? ""}`;
  if (/\btsc\b|\.ts\b/.test(cmd)) return "ts";
  return "js";
}

/** Build the runnable scaffold (path + content) for a given runner key. Pure. */
function scaffoldForRunner(runner: string, profile: StackProfile, isTypeScript?: boolean): TestScaffold | null {
  const dir = (profile.testDir ?? STACK_DEFAULT_TEST_DIR[profile.stack ?? ""] ?? "tests").replace(/\\/g, "/").replace(/\/+$/, "");
  const join2 = (d: string, f: string) => (d === "." || d === "" ? f : `${d}/${f}`);

  switch (runner) {
    case "vitest": {
      const ext = nodeTestExtension(profile, isTypeScript);
      return {
        path: join2(dir, `scaffold.test.${ext}`),
        content: `import { describe, it, expect } from "vitest";

// Stack-aware scaffold (agentic-kanban): a runnable starting point in this project's real test
// dir + runner. Replace with a real test for the feature you're building.
describe("scaffold", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
`,
      };
    }
    case "node:test": {
      // Node's built-in runner (`node --test`): no dependency, so the scaffold must import only
      // from node: builtins — the whole point being that it runs under the project's own command.
      const ext = nodeTestExtension(profile, isTypeScript);
      return {
        path: join2(dir, `scaffold.test.${ext}`),
        content: `import test from "node:test";
import assert from "node:assert";

// Stack-aware scaffold (agentic-kanban): a runnable starting point in this project's real test
// dir + runner. Replace with a real test for the feature you're building.
test("scaffold", () => {
  assert.strictEqual(1 + 1, 2);
});
`,
      };
    }
    case "jest":
    case "mocha": {
      const ext = nodeTestExtension(profile, isTypeScript);
      // jest + mocha share the BDD describe/it globals; mocha pairs with node:assert.
      const body =
        runner === "jest"
          ? `describe("scaffold", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
`
          : `import assert from "node:assert";

describe("scaffold", () => {
  it("runs", () => {
    assert.strictEqual(1 + 1, 2);
  });
});
`;
      return {
        path: join2(dir, `scaffold.test.${ext}`),
        content: `// Stack-aware scaffold (agentic-kanban): a runnable starting point in this project's real test
// dir + runner. Replace with a real test for the feature you're building.
${body}`,
      };
    }
    case "playwright": {
      const ext = nodeTestExtension(profile, isTypeScript);
      return {
        path: join2(dir, `scaffold.spec.${ext}`),
        content: `import { test, expect } from "@playwright/test";

// Stack-aware scaffold (agentic-kanban): a runnable starting point in this project's real test
// dir + runner. Replace with a real test for the feature you're building.
test("scaffold runs", async () => {
  expect(1 + 1).toBe(2);
});
`,
      };
    }
    case "pytest": {
      return {
        path: join2(dir, "test_scaffold.py"),
        content: `"""Stack-aware scaffold (agentic-kanban): a runnable starting point in this project's real
test dir + runner. Replace with a real test for the feature you're building."""


def test_scaffold_runs():
    assert 1 + 1 == 2
`,
      };
    }
    case "cargo": {
      // Cargo integration tests live as files directly under tests/ and need #[test] fns.
      return {
        path: join2(dir, "scaffold.rs"),
        content: `// Stack-aware scaffold (agentic-kanban): a runnable starting point in this project's real test
// dir + runner. Replace with a real test for the feature you're building.
#[test]
fn scaffold_runs() {
    assert_eq!(1 + 1, 2);
}
`,
      };
    }
    case "go": {
      // Go test files live alongside source (package main is the safest default for a fresh repo).
      return {
        path: join2(dir, "scaffold_test.go"),
        content: `package main

// Stack-aware scaffold (agentic-kanban): a runnable starting point in this project's real test
// dir + runner. Replace with a real test for the feature you're building.
import "testing"

func TestScaffoldRuns(t *testing.T) {
	if 1+1 != 2 {
		t.Fatal("math is broken")
	}
}
`,
      };
    }
    case "kotlintest": {
      // Kotlin (incl. Kotlin Multiplatform): tests live under commonTest/kotlin (or test/kotlin) and
      // use the multiplatform `kotlin.test` API, NOT JUnit in src/test/java. A `.java` JUnit file in a
      // KMP project sits in no source set (no java plugin) — dead, untracked, and dirties main.
      const ktDir = (profile.testDir ?? "src/commonTest/kotlin").replace(/\\/g, "/").replace(/\/+$/, "");
      return {
        path: ktDir === "." ? "ScaffoldTest.kt" : `${ktDir}/ScaffoldTest.kt`,
        content: `import kotlin.test.Test
import kotlin.test.assertEquals

// Stack-aware scaffold (agentic-kanban): a runnable starting point in this project's real test
// dir + runner (kotlin.test, multiplatform). Replace with a real test for the feature you're building.
class ScaffoldTest {
    @Test
    fun scaffoldRuns() {
        assertEquals(2, 1 + 1)
    }
}
`,
      };
    }
    case "junit": {
      return {
        path: join2(dir, "ScaffoldTest.java"),
        content: `import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

// Stack-aware scaffold (agentic-kanban): a runnable starting point in this project's real test
// dir + runner. Replace with a real test for the feature you're building.
class ScaffoldTest {
    @Test
    void scaffoldRuns() {
        assertEquals(2, 1 + 1);
    }
}
`,
      };
    }
    default:
      return null;
  }
}

/**
 * Derive a runnable test scaffold (path + content) from a stack profile (#793).
 *
 * Source of truth = the persisted #786 stack profile's `testRunner` + `testDir`. The file is
 * placed in the project's REAL test directory and written in the syntax the detected runner
 * expects, so the generated test actually runs under the project's own `testCommand`. Returns
 * null when the stack/runner is unknown (no scaffold we could confidently make runnable) — callers
 * treat that as a safe no-op. Pure — no I/O; every fact that needs the filesystem arrives as a hint.
 *
 * @param isTypeScript hint that a Node project is TypeScript (so the scaffold gets a `.ts`
 *   extension); writeTestScaffold derives it from a tsconfig.json on disk. Ignored for non-Node.
 * @param isKotlin hint that a Gradle/Maven project is Kotlin (so the scaffold is a `kotlin.test`
 *   `.kt` file under commonTest, not a JUnit `.java` file). Ignored for non-JVM stacks.
 * @param hints manifest-derived facts (declared deps, resolved test command) that writeTestScaffold
 *   reads off disk. Without them a Node project with an undetected runner yields null rather than a
 *   guess (#39).
 */
export function deriveTestScaffold(
  profile: StackProfile | null,
  isTypeScript?: boolean,
  isKotlin?: boolean,
  hints?: ScaffoldHints,
): TestScaffold | null {
  if (!profile) return null;
  const runner = resolveRunnerKey(profile, isKotlin, hints);
  if (!runner) return null;
  return scaffoldForRunner(runner, profile, isTypeScript);
}

/**
 * Read the manifest-derived hints deriveTestScaffold can't get for itself (#39). All I/O lives
 * here, on the impure side of the split; failures degrade to "no hints" (→ no scaffold), never throw.
 */
function readScaffoldHints(repoPath: string, profile: StackProfile): ScaffoldHints {
  if (profile.stack !== "node") return {};
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      declaredDeps: [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ],
      resolvedTestCommand: resolveScriptCommand(profile.testCommand, pkg.scripts),
    };
  } catch {
    return {};
  }
}

/**
 * Resolve package-manager indirection: "npm test" / "pnpm run test:unit" is not evidence of a
 * runner — the script it points at ("node --test") is.
 */
function resolveScriptCommand(
  testCommand: string | null,
  scripts: Record<string, string> | undefined,
): string | null {
  if (!testCommand || !scripts) return null;
  const m = /^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/.exec(testCommand);
  if (!m) return null;
  return scripts[m[1]] ?? null;
}

/**
 * Write the derived test scaffold into the project's worktree (#793).
 *
 * Clobber-safe and idempotent: never overwrites an existing file at the target path (so a real
 * test the project already has is preserved, and a second run is a no-op). Creates the test
 * directory if absent. Non-fatal on any error — scaffolding must never block profile persistence
 * (same contract as writeSmartHooksRules). Returns the repo-relative path written, or null when
 * nothing was written (no derivable scaffold, file already present, or an error).
 *
 * The scaffold exists only to give a project with NO tests a runnable starting point. If the
 * project's test directory already contains tests, writing a redundant `ScaffoldTest` there just
 * dirties the worktree — and because saveStackProfile re-runs this on every profile refresh, that
 * stray untracked file reappears and can block future auto-merges on `dirty_main`. So skip when the
 * detected test dir already has content (observed on the kmp-toolkit drive).
 */
export function writeTestScaffold(repoPath: string, profile: StackProfile): string | null {
  try {
    const isTypeScript = existsSync(join(repoPath, "tsconfig.json"));
    const isKotlin = profile.stack === "java" && isKotlinGradle(repoPath);
    const scaffold = deriveTestScaffold(profile, isTypeScript, isKotlin, readScaffoldHints(repoPath, profile));
    if (!scaffold) return null;
    // Don't scaffold into a test dir that already has tests — the project doesn't need a starter,
    // and a redundant file would be regenerated on every profile refresh and dirty main.
    if (testDirHasContent(repoPath, profile.testDir)) return null;
    const outPath = join(repoPath, scaffold.path);
    if (existsSync(outPath)) return null; // never clobber an existing test
    mkdirSync(join(outPath, ".."), { recursive: true });
    writeFileSync(outPath, scaffold.content, "utf8");
    return scaffold.path;
  } catch {
    return null; // non-fatal: must never block profile persistence
  }
}

/** True when the profile's detected test directory exists and already contains at least one entry. */
function testDirHasContent(repoPath: string, testDir: string | null): boolean {
  if (!testDir) return false;
  try {
    const dir = join(repoPath, testDir);
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
