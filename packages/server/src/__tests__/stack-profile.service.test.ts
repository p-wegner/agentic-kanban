import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import type { StackProfile } from "@agentic-kanban/shared";
import {
  detectStackProfile,
  buildSmartHooksRules,
  writeSmartHooksRules,
  smartHooksRulesPath,
} from "../services/stack-profile.service.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kanban-stack-"));
}

describe("detectStackProfile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tmp();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects a node single-package pnpm project with scripts", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      scripts: { test: "vitest", build: "tsc", lint: "eslint .", dev: "vite --port 5173" },
      devDependencies: { vitest: "^4", react: "^18", vite: "^5" },
    }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const p = detectStackProfile(dir);
    expect(p.stack).toBe("node");
    expect(p.packageManager).toBe("pnpm");
    expect(p.isMonorepo).toBe(false);
    expect(p.testCommand).toBe("pnpm test");
    expect(p.buildCommand).toBe("pnpm build");
    expect(p.lintCommand).toBe("pnpm lint");
    expect(p.devCommand).toBe("pnpm dev");
    expect(p.testRunner).toBe("vitest");
    expect(p.isWeb).toBe(true);
    expect(p.devPort).toBe(5173);
    expect(p.devHealthUrl).toBe("http://localhost:5173");
    expect(p.source).toBe("detected");
    expect(p.detectedMarkers).toContain("package.json");
  });

  it("detects a pnpm monorepo from pnpm-workspace.yaml", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      scripts: { test: "vitest", "test:mine": "vitest run", build: "tsc" },
    }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n  - 'apps/*'\n");

    const p = detectStackProfile(dir);
    expect(p.isMonorepo).toBe(true);
    expect(p.workspaces).toEqual(["packages/*", "apps/*"]);
    expect(p.quickTestCommand).toBe("pnpm test:mine");
  });

  it("detects an npm project and uses npm run prefix", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest", build: "webpack" } }));
    const p = detectStackProfile(dir);
    expect(p.packageManager).toBe("npm");
    expect(p.testCommand).toBe("npm test");
    expect(p.buildCommand).toBe("npm run build");
    expect(p.installCommand).toBe("npm install");
  });

  it("populates cargo profile", async () => {
    await writeFile(join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n");
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("rust");
    expect(p.packageManager).toBe("cargo");
    expect(p.testCommand).toBe("cargo test");
    expect(p.buildCommand).toBe("cargo build");
    expect(p.testRunner).toBe("cargo");
  });

  it("populates go profile", async () => {
    await writeFile(join(dir, "go.mod"), "module x\n\ngo 1.22\n");
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("go");
    expect(p.testCommand).toBe("go test ./...");
    expect(p.buildCommand).toBe("go build ./...");
  });

  it("populates python profile (requirements.txt → pip + pytest)", async () => {
    await writeFile(join(dir, "requirements.txt"), "pytest\n");
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("python");
    expect(p.packageManager).toBe("pip");
    expect(p.testCommand).toBe("python -m pytest");
    expect(p.testRunner).toBe("pytest");
  });

  it("populates python profile with poetry from pyproject.toml", async () => {
    await writeFile(join(dir, "pyproject.toml"), "[tool.poetry]\nname = \"x\"\n");
    const p = detectStackProfile(dir);
    expect(p.packageManager).toBe("poetry");
    expect(p.installCommand).toBe("poetry install");
    expect(p.testCommand).toBe("poetry run python -m pytest");
  });

  it("populates java/gradle profile with wrapper", async () => {
    await writeFile(join(dir, "build.gradle"), "plugins { id 'java' }\n");
    await writeFile(join(dir, "gradlew"), "#!/bin/sh\n");
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("java");
    expect(p.packageManager).toBe("gradle");
    expect(p.testCommand).toBe("./gradlew test");
    expect(p.buildCommand).toBe("./gradlew build");
  });

  it("returns an empty-but-valid profile when no markers are present", () => {
    const p = detectStackProfile(dir);
    expect(p.stack).toBeNull();
    expect(p.testCommand).toBeNull();
    expect(p.isMonorepo).toBe(false);
    expect(p.workspaces).toEqual([]);
    expect(p.source).toBe("detected");
  });

  it("finds the test directory when present", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    await mkdir(join(dir, "src", "__tests__"), { recursive: true });
    const p = detectStackProfile(dir);
    expect(p.testDir).toBe("src/__tests__");
  });
});

function profile(overrides: Partial<StackProfile>): StackProfile {
  return {
    stack: null, packageManager: null, isMonorepo: false, workspaces: [],
    installCommand: null, buildCommand: null, testCommand: null, quickTestCommand: null,
    lintCommand: null, typecheckCommand: null, devCommand: null, isWeb: false,
    devHealthUrl: null, devPort: null, testDir: null, testRunner: null,
    source: "detected", detectedMarkers: [], updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildSmartHooksRules", () => {
  it("emits a typecheck + quick-test rule for a node project, scoped to JS/TS source patterns", () => {
    const out = buildSmartHooksRules(
      profile({ stack: "node", typecheckCommand: "pnpm tsc --noEmit", quickTestCommand: "pnpm test:mine", testCommand: "pnpm test" }),
    );
    expect(out.generated).toBe(true);
    expect(out.stack).toBe("node");
    const names = out.rules.map((r) => r.name);
    expect(names).toContain("Typecheck");
    expect(names).toContain("Quick tests");
    const tc = out.rules.find((r) => r.name === "Typecheck")!;
    expect(tc.command).toBe("pnpm tsc --noEmit");
    expect(tc.filePatterns).toContain("**/*.ts");
    expect(tc.filePatterns).toContain("**/*.tsx");
    // No Rust/Go patterns leak into a node project.
    expect(tc.filePatterns).not.toContain("**/*.rs");
  });

  it("derives a non-TS stack's quick check from its profile (rust → cargo, .rs patterns)", () => {
    const out = buildSmartHooksRules(
      profile({ stack: "rust", typecheckCommand: "cargo check", testCommand: "cargo test", quickTestCommand: "cargo test" }),
    );
    const tc = out.rules.find((r) => r.name === "Typecheck")!;
    expect(tc.command).toBe("cargo check");
    expect(tc.filePatterns).toEqual(["**/*.rs"]);
  });

  it("falls back to the full test command when no quick variant exists", () => {
    const out = buildSmartHooksRules(profile({ stack: "go", testCommand: "go test ./...", typecheckCommand: null }));
    expect(out.rules.map((r) => r.name)).toEqual(["Tests"]);
    expect(out.rules[0].command).toBe("go test ./...");
  });

  it("produces no rules when the profile has no usable command", () => {
    const out = buildSmartHooksRules(profile({ stack: "python" }));
    expect(out.rules).toEqual([]);
  });

  it("uses a broad source pattern union for an unknown stack", () => {
    const out = buildSmartHooksRules(profile({ stack: null, typecheckCommand: "make check" }));
    const tc = out.rules[0];
    expect(tc.filePatterns).toContain("**/*.ts");
    expect(tc.filePatterns).toContain("**/*.rs");
    expect(tc.filePatterns).toContain("**/*.py");
  });
});

describe("writeSmartHooksRules", () => {
  let dir: string;
  beforeEach(async () => { dir = await tmp(); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("writes .claude/smart-hooks-rules.json derived from the profile", async () => {
    writeSmartHooksRules(dir, profile({ stack: "go", testCommand: "go test ./...", typecheckCommand: "go build ./..." }));
    const written = JSON.parse(await readFile(smartHooksRulesPath(dir), "utf8"));
    expect(written.generated).toBe(true);
    expect(written.stack).toBe("go");
    expect(written.rules.some((r: { command: string }) => r.command === "go test ./...")).toBe(true);
  });

  it("regenerates (overwrites) the file when the profile changes", async () => {
    writeSmartHooksRules(dir, profile({ stack: "node", typecheckCommand: "tsc --noEmit" }));
    writeSmartHooksRules(dir, profile({ stack: "rust", typecheckCommand: "cargo check" }));
    const written = JSON.parse(await readFile(smartHooksRulesPath(dir), "utf8"));
    expect(written.stack).toBe("rust");
    expect(written.rules[0].command).toBe("cargo check");
  });
});
