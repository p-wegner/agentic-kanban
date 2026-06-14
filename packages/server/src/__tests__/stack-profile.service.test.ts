import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectStackProfile } from "../services/stack-profile.service.js";

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
