import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StackProfile } from "@agentic-kanban/shared";
import { deriveTestScaffold, writeTestScaffold } from "../services/stack-profile.service.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kanban-test-scaffold-"));
}

function profile(overrides: Partial<StackProfile>): StackProfile {
  return {
    stack: "node", packageManager: "pnpm", isMonorepo: false, workspaces: [],
    installCommand: "pnpm install", buildCommand: null, testCommand: null, quickTestCommand: null,
    lintCommand: null, typecheckCommand: null, devCommand: null, isWeb: false,
    devHealthUrl: null, devPort: null, testDir: null, testRunner: null,
    source: "detected", detectedMarkers: [], updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

describe("deriveTestScaffold", () => {
  it("returns null for a null profile", () => {
    expect(deriveTestScaffold(null)).toBeNull();
  });

  it("returns null when the stack/runner is unknown", () => {
    expect(deriveTestScaffold(profile({ stack: null, testRunner: null }))).toBeNull();
  });

  it("scaffolds a vitest test in the profile's testDir, .ts when TypeScript", () => {
    const s = deriveTestScaffold(profile({ testRunner: "vitest", testDir: "src/__tests__" }), true);
    expect(s).not.toBeNull();
    expect(s!.path).toBe("src/__tests__/scaffold.test.ts");
    expect(s!.content).toContain('from "vitest"');
    expect(s!.content).toContain("expect(1 + 1).toBe(2)");
  });

  it("falls back to vitest (.js without TypeScript) for a node project that declares vitest", () => {
    const s = deriveTestScaffold(profile({ testRunner: null, testDir: "tests" }), false, false, {
      declaredDeps: ["vitest"],
    });
    expect(s!.path).toBe("tests/scaffold.test.js");
    expect(s!.content).toContain('from "vitest"');
  });

  it("writes nothing for a node project with no runner and no known test dependency (#39)", () => {
    // Guessing vitest here breaks the project's own `node --test` command with ERR_MODULE_NOT_FOUND.
    expect(deriveTestScaffold(profile({ testRunner: null, testDir: "tests" }), false, false, {
      declaredDeps: ["pg"],
    })).toBeNull();
    // No hints at all = the runner cannot be established either.
    expect(deriveTestScaffold(profile({ testRunner: null, testDir: "tests" }), false)).toBeNull();
  });

  it("derives node:test from the resolved test command instead of assuming vitest (#39)", () => {
    const s = deriveTestScaffold(profile({ testRunner: null, testCommand: "npm test", testDir: "tests" }), false, false, {
      declaredDeps: ["pg"],
      resolvedTestCommand: "node --test",
    });
    expect(s!.path).toBe("tests/scaffold.test.js");
    expect(s!.content).not.toContain("vitest");
    // A `.js` file in a CommonJS package (no isEsm hint) must use require, not ESM import, or Node
    // prints MODULE_TYPELESS_PACKAGE_JSON and reparses on every run (#67).
    expect(s!.content).toContain('require("node:test")');
    expect(s!.content).toContain('const assert = require("node:assert")');
    expect(s!.content).not.toContain("import");
    expect(s!.content).toContain("assert.strictEqual(1 + 1, 2)");
  });

  it("emits ESM import for a node:test .js scaffold when the package is type:module (#67)", () => {
    const s = deriveTestScaffold(profile({ testRunner: null, testCommand: "node --test", testDir: "tests" }), false, false, {
      resolvedTestCommand: "node --test",
      isEsm: true,
    });
    expect(s!.path).toBe("tests/scaffold.test.js");
    expect(s!.content).toContain('import test from "node:test"');
    expect(s!.content).toContain('import assert from "node:assert"');
    expect(s!.content).not.toContain("require(");
  });

  it("keeps ESM import for a node:test .ts scaffold regardless of module type (#67)", () => {
    const s = deriveTestScaffold(profile({ testRunner: null, testCommand: "node --test", testDir: "tests" }), true);
    expect(s!.path).toBe("tests/scaffold.test.ts");
    expect(s!.content).toContain('import test from "node:test"');
    expect(s!.content).not.toContain("require(");
  });

  it("derives the runner from the profile's own testCommand when no runner is detected", () => {
    expect(deriveTestScaffold(profile({ testRunner: null, testCommand: "npx vitest run" }))!.content)
      .toContain('from "vitest"');
    expect(deriveTestScaffold(profile({ testRunner: null, testCommand: "npx jest" }))!.content)
      .toContain('describe("scaffold"');
    expect(deriveTestScaffold(profile({ testRunner: null, testCommand: "node --test" }))!.content)
      .toContain("node:test");
  });

  it("prefers the declared runner over a declared-dep fallback when the command names one", () => {
    // vitest is installed, but the project runs the built-in runner — the command wins.
    const s = deriveTestScaffold(profile({ testRunner: null, testCommand: "node --test", testDir: "tests" }), false, false, {
      declaredDeps: ["vitest"],
    });
    expect(s!.content).not.toContain("vitest");
  });

  it("scaffolds a pytest test (test_*.py) for python", () => {
    const s = deriveTestScaffold(profile({ stack: "python", testRunner: "pytest", testDir: "tests" }));
    expect(s!.path).toBe("tests/test_scaffold.py");
    expect(s!.content).toContain("def test_scaffold_runs():");
    expect(s!.content).toContain("assert 1 + 1 == 2");
  });

  it("scaffolds a cargo integration test under tests/", () => {
    const s = deriveTestScaffold(profile({ stack: "rust", testRunner: "cargo", testDir: "tests" }));
    expect(s!.path).toBe("tests/scaffold.rs");
    expect(s!.content).toContain("#[test]");
    expect(s!.content).toContain("assert_eq!(1 + 1, 2)");
  });

  it("scaffolds a go test alongside source (package main)", () => {
    const s = deriveTestScaffold(profile({ stack: "go", testRunner: "go test", testDir: null }));
    expect(s!.path).toBe("scaffold_test.go");
    expect(s!.content).toContain("package main");
    expect(s!.content).toContain("func TestScaffoldRuns(t *testing.T)");
  });

  it("scaffolds a JUnit test for a gradle/java project", () => {
    const s = deriveTestScaffold(profile({ stack: "java", testRunner: "gradle", testDir: "src/test/java" }));
    expect(s!.path).toBe("src/test/java/ScaffoldTest.java");
    expect(s!.content).toContain("import org.junit.jupiter.api.Test;");
    expect(s!.content).toContain("assertEquals(2, 1 + 1)");
  });

  it("falls back to the stack's default test dir when none is detected", () => {
    const s = deriveTestScaffold(profile({ stack: "python", testRunner: "pytest", testDir: null }));
    expect(s!.path).toBe("tests/test_scaffold.py");
  });

  it("uses .ts when testCommand references tsc even without the TypeScript hint", () => {
    const s = deriveTestScaffold(profile({ testRunner: "vitest", typecheckCommand: "tsc --noEmit", testDir: "tests" }));
    expect(s!.path).toBe("tests/scaffold.test.ts");
  });
});

describe("writeTestScaffold", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tmp();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the scaffold into the real test dir and reports the path", async () => {
    const written = writeTestScaffold(dir, profile({ stack: "python", testRunner: "pytest", testDir: "tests" }));
    expect(written).toBe("tests/test_scaffold.py");
    const body = await readFile(join(dir, "tests", "test_scaffold.py"), "utf8");
    expect(body).toContain("def test_scaffold_runs():");
  });

  it("picks .ts when the repo has a tsconfig.json", async () => {
    await writeFile(join(dir, "tsconfig.json"), "{}");
    const written = writeTestScaffold(dir, profile({ testRunner: "vitest", testDir: "tests" }));
    expect(written).toBe("tests/scaffold.test.ts");
  });

  it("never clobbers an existing test file (idempotent)", async () => {
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "tests", "test_scaffold.py"), "# real test\n");
    const written = writeTestScaffold(dir, profile({ stack: "python", testRunner: "pytest", testDir: "tests" }));
    expect(written).toBeNull();
    const body = await readFile(join(dir, "tests", "test_scaffold.py"), "utf8");
    expect(body).toBe("# real test\n");
  });

  it("scaffolds node:test — not vitest — for a `node --test` project (#39)", async () => {
    // The verified repro: profile says testCommand "npm test", testRunner null, and vitest is in
    // neither dependencies nor devDependencies. A vitest scaffold made the project's own passing
    // test command die with ERR_MODULE_NOT_FOUND.
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" }, dependencies: { pg: "^8.11.3" } }),
    );
    const written = writeTestScaffold(dir, profile({ testCommand: "npm test", testRunner: null, testDir: "tests" }));
    expect(written).toBe("tests/scaffold.test.js");
    const body = await readFile(join(dir, "tests", "scaffold.test.js"), "utf8");
    expect(body).not.toContain("vitest");
    // No "type":"module" in package.json → CommonJS → require, not ESM import (#67).
    expect(body).toContain('require("node:test")');
    expect(body).not.toContain("import");
  });

  it("emits ESM import for node:test when package.json declares type:module (#67)", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ type: "module", scripts: { test: "node --test" }, dependencies: { pg: "^8.11.3" } }),
    );
    const written = writeTestScaffold(dir, profile({ testCommand: "npm test", testRunner: null, testDir: "tests" }));
    expect(written).toBe("tests/scaffold.test.js");
    const body = await readFile(join(dir, "tests", "scaffold.test.js"), "utf8");
    expect(body).toContain('import test from "node:test"');
    expect(body).not.toContain("require(");
  });

  it("still scaffolds vitest for a genuine vitest project (#39 no regression)", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^2.0.0" } }),
    );
    const written = writeTestScaffold(dir, profile({ testCommand: "npm test", testRunner: null, testDir: "tests" }));
    expect(written).toBe("tests/scaffold.test.js");
    expect(await readFile(join(dir, "tests", "scaffold.test.js"), "utf8")).toContain('from "vitest"');
  });

  it("writes nothing for a node project whose runner can't be established (#39)", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { pg: "^8.11.3" } }));
    expect(writeTestScaffold(dir, profile({ testCommand: null, testRunner: null, testDir: "tests" }))).toBeNull();
    expect(await exists(join(dir, "tests"))).toBe(false);
  });

  it("is a no-op for an unknown stack (writes nothing)", async () => {
    const written = writeTestScaffold(dir, profile({ stack: null, testRunner: null }));
    expect(written).toBeNull();
    expect(await exists(join(dir, "tests"))).toBe(false);
  });

  it("skips when the test dir already has tests under a different name (no redundant scaffold)", async () => {
    // The kmp-toolkit case: commonTest already has real tests (in a package subdir), so a
    // ScaffoldTest with a different path must NOT be written — it would reappear on every profile
    // refresh and dirty main, blocking auto-merge.
    await mkdir(join(dir, "tests", "pkg"), { recursive: true });
    await writeFile(join(dir, "tests", "pkg", "test_real.py"), "def test_real():\n    assert True\n");
    const written = writeTestScaffold(dir, profile({ stack: "python", testRunner: "pytest", testDir: "tests" }));
    expect(written).toBeNull();
    expect(await exists(join(dir, "tests", "test_scaffold.py"))).toBe(false);
  });
});
