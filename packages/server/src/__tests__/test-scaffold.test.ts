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

  it("defaults a node project with no runner to vitest and .js without TypeScript", () => {
    const s = deriveTestScaffold(profile({ testRunner: null, testDir: "tests" }), false);
    expect(s!.path).toBe("tests/scaffold.test.js");
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
