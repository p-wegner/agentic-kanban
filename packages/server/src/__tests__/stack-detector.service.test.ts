/**
 * Focused tests for the stack detector at its own home after the #853 god-file split
 * (detectStackProfile + the Gradle/KMP/Ktor/Node/Python detectors were extracted from
 * stack-profile.service into stack-detector.service). Imports directly from the new
 * module to prove it stands alone; the comprehensive matrix lives in
 * stack-profile.service.test.ts (which exercises the re-export).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectStackProfile } from "../services/stack-detector.service.js";

describe("stack-detector.service detectStackProfile", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "kanban-detector-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("detects a Node pnpm project", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("node");
    expect(p.packageManager).toBe("pnpm");
    expect(p.installCommand).toBe("pnpm install");
    expect(p.source).toBe("detected");
  });

  /**
   * #644 — `isWeb` was derived from the ROOT package.json's deps alone. In a pnpm monorepo the
   * root is a thin orchestrator (it owns the `dev` script, not the framework), so EVERY
   * monorepo with a client sub-package reported `isWeb: false` — including this board, whose
   * boot/render smoke gate was therefore a permanent no-op on its own UI.
   */
  it("finds web markers in WORKSPACE packages, not just the root (#644)", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "node scripts/dev.mjs" } }));
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    await mkdir(join(dir, "packages", "client"), { recursive: true });
    await writeFile(
      join(dir, "packages", "client", "package.json"),
      JSON.stringify({ scripts: { dev: "vite --port 5173" }, dependencies: { react: "^19" }, devDependencies: { vite: "^7" } }),
    );
    await mkdir(join(dir, "packages", "shared"), { recursive: true });
    await writeFile(join(dir, "packages", "shared", "package.json"), JSON.stringify({ name: "shared" }));

    const p = detectStackProfile(dir);
    expect(p.isMonorepo).toBe(true);
    expect(p.isWeb).toBe(true);
    // …and the port literal in the sub-package's own dev script is what makes a health URL
    // resolvable at all, so the smoke check can actually be built.
    expect(p.devPort).toBe(5173);
    expect(p.devHealthUrl).toBe("http://localhost:5173");
  });

  it("does not invent a web project from a workspace with no web markers (#644)", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "node cli.js" } }));
    await writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    await mkdir(join(dir, "packages", "core"), { recursive: true });
    await writeFile(join(dir, "packages", "core", "package.json"), JSON.stringify({ dependencies: { lodash: "^4" } }));

    expect(detectStackProfile(dir).isWeb).toBe(false);
  });

  it("survives a workspace glob pointing at nothing (a detector must never throw)", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vite: "^7" } }));
    await writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'nope/*'\n  - '!excluded/*'\n");
    expect(() => detectStackProfile(dir)).not.toThrow();
    expect(detectStackProfile(dir).isWeb).toBe(true);
  });

  it("detects a Gradle/Java multi-module project", async () => {
    await writeFile(join(dir, "build.gradle"), "plugins { id 'java' }\n");
    await writeFile(join(dir, "settings.gradle"), "include 'app', 'lib'\n");
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("java");
    expect(p.isMonorepo).toBe(true);
    expect(p.installCommand).toBe("gradle assemble");
  });

  it("detects a Kotlin Multiplatform project (commonTest, not web)", async () => {
    await writeFile(join(dir, "build.gradle.kts"), `plugins { kotlin("multiplatform") version "2.0.21" }\n`);
    await mkdir(join(dir, "src", "commonTest", "kotlin"), { recursive: true });
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("java");
    expect(p.isWeb).toBe(false);
    expect(p.testDir).toBe("src/commonTest/kotlin");
  });

  it("detects a Ktor server (kotlin-jvm + application + ktor dep) as web", async () => {
    await writeFile(
      join(dir, "build.gradle.kts"),
      `plugins { kotlin("jvm") version "2.0.21"; application }\ndependencies { implementation("io.ktor:ktor-server-netty:2.3.12") }\n`,
    );
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("java");
    expect(p.isWeb).toBe(true);
    expect(p.typecheckCommand).toContain("compileKotlin");
  });

  it("detects a Python project from requirements.txt", async () => {
    await writeFile(join(dir, "requirements.txt"), "pytest\n");
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("python");
    expect(p.testCommand).toBe("python -m pytest");
  });

  // #120: a uv project's deps live in a project-local .venv, so `pip install -r
  // requirements.txt` + bare `python -m pytest` produced a merge gate that always failed
  // with "No module named pytest" and blocked every merge.
  it("detects a uv project (pyproject.toml + uv.lock) as uv sync / uv run pytest", async () => {
    await writeFile(join(dir, "pyproject.toml"), '[project]\nname = "bookvault"\n');
    await writeFile(join(dir, "uv.lock"), 'version = 1\n');
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("python");
    expect(p.packageManager).toBe("uv");
    expect(p.installCommand).toBe("uv sync");
    expect(p.testCommand).toBe("uv run pytest");
    expect(p.quickTestCommand).toBe("uv run pytest -x");
    expect(p.lintCommand).toBe("uv run ruff check .");
    expect(p.typecheckCommand).toBe("uv run mypy .");
  });

  it("detects uv from a [tool.uv] section when no uv.lock is committed", async () => {
    await writeFile(join(dir, "pyproject.toml"), '[project]\nname = "x"\n\n[tool.uv]\ndev-dependencies = ["pytest"]\n');
    const p = detectStackProfile(dir);
    expect(p.packageManager).toBe("uv");
    expect(p.installCommand).toBe("uv sync");
    expect(p.testCommand).toBe("uv run pytest");
  });

  it("prefers uv over poetry when a pyproject carries both", async () => {
    await writeFile(join(dir, "pyproject.toml"), '[tool.poetry]\nname = "x"\n\n[tool.uv]\n');
    await writeFile(join(dir, "uv.lock"), 'version = 1\n');
    const p = detectStackProfile(dir);
    expect(p.packageManager).toBe("uv");
    expect(p.testCommand).toBe("uv run pytest");
  });

  // #521: a PEP-621 pyproject-only project (no uv, no poetry, no requirements.txt) used to
  // get `pip install -r requirements.txt` from the detector - a command that cannot
  // succeed, because that file does not exist. The setup-script ladder got this RIGHT
  // (`pip install -e .`), which is how the divergence surfaced when the two were merged.
  it("installs a PEP-621 pyproject-only project with `pip install -e .`, not a missing requirements.txt", async () => {
    await writeFile(join(dir, "pyproject.toml"), `[project]
name = "x"
version = "0.1.0"
`);
    const p = detectStackProfile(dir);
    expect(p.packageManager).toBe("pip");
    expect(p.installCommand).toBe("pip install -e .");
  });

  it("prefers an explicit requirements.txt over the pyproject when both exist", async () => {
    await writeFile(join(dir, "pyproject.toml"), `[project]
name = "x"
`);
    await writeFile(join(dir, "requirements.txt"), `flask
`);
    expect(detectStackProfile(dir).installCommand).toBe("pip install -r requirements.txt");
  });

  it("still detects poetry when there is no uv marker", async () => {
    await writeFile(join(dir, "pyproject.toml"), '[tool.poetry]\nname = "x"\n');
    const p = detectStackProfile(dir);
    expect(p.packageManager).toBe("poetry");
    expect(p.installCommand).toBe("poetry install");
    expect(p.testCommand).toBe("poetry run python -m pytest");
  });

  // #177: on Windows cmd cannot exec the extensionless composer bin shim
  // (`vendor/bin/phpunit` needs `vendor\bin\phpunit.bat`); the portable form runs it
  // through the interpreter (`php vendor/bin/phpunit`), which works on every platform.
  it("detects a PHP/composer project and emits `php vendor/bin/phpunit`, not the bare shim", async () => {
    await writeFile(
      join(dir, "composer.json"),
      JSON.stringify({ "require-dev": { "phpunit/phpunit": "^10.0" } }),
    );
    const p = detectStackProfile(dir);
    expect(p.stack).toBe("php");
    expect(p.packageManager).toBe("composer");
    expect(p.installCommand).toBe("composer install");
    expect(p.testCommand).toBe("php vendor/bin/phpunit");
    expect(p.quickTestCommand).toBe("php vendor/bin/phpunit");
    expect(p.testCommand).not.toMatch(/^vendor\/bin/);
  });

  it("detects PHP static analysis/lint tools and honors a custom composer bin-dir", async () => {
    await writeFile(
      join(dir, "composer.json"),
      JSON.stringify({
        "require-dev": {
          "phpunit/phpunit": "^10.0",
          "phpstan/phpstan": "^1.0",
          "friendsofphp/php-cs-fixer": "^3.0",
        },
        config: { "bin-dir": "bin" },
      }),
    );
    const p = detectStackProfile(dir);
    expect(p.typecheckCommand).toBe("php bin/phpstan analyse");
    expect(p.lintCommand).toBe("php bin/php-cs-fixer fix --dry-run --diff");
  });

  it("returns a sparse 'detected' profile (stack null) for an unknown/empty repo", async () => {
    const p = detectStackProfile(dir);
    expect(p.stack).toBeNull();
    expect(p.source).toBe("detected");
    expect(Array.isArray(p.detectedMarkers)).toBe(true);
  });
});
