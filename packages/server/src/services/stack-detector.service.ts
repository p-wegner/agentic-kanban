// Stack detection (rule-based, from on-disk marker files). Extracted verbatim from
// stack-profile.service.ts (#853 god-file split) so the Gradle/KMP/Ktor/Node detectors
// have their own home + tests; stack-profile.service re-exports detectStackProfile so its
// ~21 importers compile unchanged. readJson / nodeInstallCommand / readFileSafe / NodePkgJson
// are exported because the service's setup-script derivation also uses them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StackProfile } from "@agentic-kanban/shared";
import { detectProjectMarkers, isUvProject } from "./project-setup.service.js";
import {
  gradleWrapper,
  isKotlinGradle,
  isKotlinMultiplatformGradle,
  isSpringBootGradle,
  isKtorGradle,
  hasGradleApplicationPlugin,
  detectGradleDevPort,
} from "./gradle-detect.service.js";

function firstExistingDir(repoPath: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(join(repoPath, candidate))) return candidate;
  }
  return null;
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Monorepo-aware install command for a Node package manager.
 *
 * pnpm/yarn/npm/bun all install every workspace from a single root invocation
 * (pnpm is recursive by default; npm 7+/yarn/bun resolve the whole workspace graph),
 * so the command shape is the same — but we surface `-r` for pnpm monorepos to make the
 * "install ALL workspaces" intent explicit and robust against a non-root cwd.
 */
export function nodeInstallCommand(pm: string, isMonorepo: boolean): string {
  if (pm === "pnpm") return isMonorepo ? "pnpm install -r" : "pnpm install";
  if (pm === "npm") return "npm install";
  return `${pm} install`; // yarn / bun — workspace-aware from the root
}

/** Detect the package manager from lock files, falling back to npm for a bare package.json. */
function detectNodePackageManager(markers: Set<string>): string {
  if (markers.has("pnpm-lock.yaml")) return "pnpm";
  if (markers.has("yarn.lock")) return "yarn";
  if (markers.has("bun.lockb") || markers.has("bun.lock")) return "bun";
  return "npm";
}

export interface NodePkgJson {
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

/** Read pnpm-workspace.yaml `packages:` entries (a minimal line scan, no YAML dep). */
function readPnpmWorkspaces(repoPath: string): string[] {
  const file = join(repoPath, "pnpm-workspace.yaml");
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf8");
    const globs: string[] = [];
    let inPackages = false;
    for (const line of raw.split(/\r?\n/)) {
      if (/^packages:/.test(line)) { inPackages = true; continue; }
      if (inPackages) {
        const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/);
        if (m) globs.push(m[1].trim());
        else if (/^\S/.test(line)) break; // dedented to a new top-level key
      }
    }
    return globs;
  } catch {
    return [];
  }
}

function detectTestRunner(pkg: NodePkgJson | null): string | null {
  if (!pkg) return null;
  const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
  if ("vitest" in deps) return "vitest";
  if ("jest" in deps) return "jest";
  if ("mocha" in deps) return "mocha";
  if ("@playwright/test" in deps || "playwright" in deps) return "playwright";
  if ("ava" in deps) return "ava";
  // Infer from the test script as a last resort.
  const testScript = pkg.scripts?.test ?? "";
  for (const runner of ["vitest", "jest", "mocha", "playwright", "ava"]) {
    if (testScript.includes(runner)) return runner;
  }
  return null;
}

const DEV_PORT_RE = /(?:--port[ =]|:|PORT[ =]|localhost:|127\.0\.0\.1:)(\d{4,5})/;

function detectDevPort(pkg: NodePkgJson | null): number | null {
  const dev = pkg?.scripts?.dev ?? pkg?.scripts?.start ?? "";
  const m = dev.match(DEV_PORT_RE);
  if (m) {
    const port = Number.parseInt(m[1], 10);
    if (Number.isFinite(port) && port > 0 && port < 65536) return port;
  }
  return null;
}

/** Build a Node/JS stack profile from package.json + lock files. */
function detectNodeProfile(repoPath: string, markers: Set<string>): Partial<StackProfile> {
  const pm = detectNodePackageManager(markers);
  // Run a named package.json script: `npm run <s>` vs `pnpm <s>` / `yarn <s>` / `bun run <s>`.
  const run = (script: string) =>
    pm === "npm" ? `npm run ${script}` : pm === "bun" ? `bun run ${script}` : `${pm} ${script}`;
  const pkg = readJson<NodePkgJson>(join(repoPath, "package.json"));
  const scripts = pkg?.scripts ?? {};

  // Workspaces → monorepo.
  let workspaces: string[] = readPnpmWorkspaces(repoPath);
  if (workspaces.length === 0 && pkg?.workspaces) {
    workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces.packages ?? []);
  }
  const isMonorepo = workspaces.length > 0;

  const has = (s: string) => s in scripts;
  // `test` is a built-in npm lifecycle script, so `npm test` (no `run`); pnpm/yarn omit `run` too.
  const testCommand = has("test") ? `${pm} test` : null;
  // Prefer a project-specific fast-test script for quick feedback.
  const quickScript = ["test:mine", "test:fast", "test:unit", "test:changed"].find(has);
  const buildCommand = has("build") ? run("build") : has("build:ts") ? run("build:ts") : null;
  const lintCommand = has("lint") ? run("lint") : null;
  const typecheckScript = ["typecheck", "type-check", "tsc"].find(has);
  const typecheckCommand = typecheckScript
    ? run(typecheckScript)
    : existsSync(join(repoPath, "tsconfig.json"))
      ? `${pm === "npm" ? "npx" : `${pm} exec`} tsc --noEmit`
      : null;
  const devScript = ["dev", "start", "serve"].find(has);
  const devCommand = devScript ? run(devScript) : null;

  const deps = { ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) };
  const webMarkers = ["react", "vue", "svelte", "next", "vite", "@angular/core", "express", "hono", "fastify", "koa", "@nestjs/core"];
  const isWeb = Boolean(devCommand) && webMarkers.some((m) => m in deps);
  const devPort = detectDevPort(pkg);

  return {
    stack: "node",
    packageManager: pm,
    isMonorepo,
    workspaces,
    installCommand: nodeInstallCommand(pm, isMonorepo),
    buildCommand,
    testCommand,
    quickTestCommand: quickScript ? run(quickScript) : testCommand,
    lintCommand,
    typecheckCommand,
    devCommand,
    isWeb,
    devHealthUrl: isWeb && devPort ? `http://localhost:${devPort}` : null,
    devPort,
    testDir: firstExistingDir(repoPath, ["src/__tests__", "__tests__", "tests", "test", "spec"]),
    testRunner: detectTestRunner(pkg),
  };
}

/**
 * Rule-based stack detection for the non-Node ecosystems the acceptance criteria call out
 * ({cargo, go, python, java/gradle}). Each returns as much as the marker files reveal.
 */
function detectOtherProfile(repoPath: string, markers: Set<string>): Partial<StackProfile> | null {
  if (markers.has("Cargo.toml")) {
    return {
      stack: "rust", packageManager: "cargo", isMonorepo: existsSync(join(repoPath, "Cargo.lock")) && /\[workspace\]/.test(readFileSync(join(repoPath, "Cargo.toml"), "utf8").slice(0, 4000)),
      workspaces: [], installCommand: "cargo fetch", buildCommand: "cargo build",
      testCommand: "cargo test", quickTestCommand: "cargo test", lintCommand: "cargo clippy",
      typecheckCommand: "cargo check", devCommand: "cargo run", isWeb: false,
      devHealthUrl: null, devPort: null, testDir: firstExistingDir(repoPath, ["tests"]), testRunner: "cargo",
    };
  }
  if (markers.has("go.mod")) {
    return {
      stack: "go", packageManager: "go", isMonorepo: false, workspaces: [],
      installCommand: "go mod download", buildCommand: "go build ./...",
      testCommand: "go test ./...", quickTestCommand: "go test ./...", lintCommand: "go vet ./...",
      typecheckCommand: "go build ./...", devCommand: "go run .", isWeb: false,
      devHealthUrl: null, devPort: null, testDir: null, testRunner: "go test",
    };
  }
  if (markers.has("build.gradle") || markers.has("build.gradle.kts")) {
    const wrapper = gradleWrapper(repoPath);
    const isMultiModule = existsSync(join(repoPath, "settings.gradle")) || existsSync(join(repoPath, "settings.gradle.kts"));
    // `gradle dependencies` resolves only the ROOT project's deps; a multi-module build
    // needs every subproject's deps materialized before the first build. `assemble` builds
    // all subproject artifacts, which downloads/resolves every module's dependencies.
    const install = isMultiModule ? `${wrapper} assemble` : `${wrapper} dependencies`;
    const kotlin = isKotlinGradle(repoPath);
    const multiplatform = isKotlinMultiplatformGradle(repoPath);
    const spring = isSpringBootGradle(repoPath);
    const ktor = isKtorGradle(repoPath);
    const hasApp = hasGradleApplicationPlugin(repoPath);
    // A web/service project = serves HTTP. Spring Boot OR Ktor both do; this gates the #791 smoke
    // check (boot the dev server + assert it responds) and the board's after-merge UI verification.
    const web = spring || ktor;
    const devPort = web ? detectGradleDevPort(repoPath) : null;
    // Kotlin Multiplatform has no aggregate `test` task — use `allTests` (jvmTest + jsNodeTest + …).
    const testTask = multiplatform ? "allTests" : "test";
    // Typecheck (cheapest per-edit correctness signal):
    //  - Java (java plugin) → `compileJava`.
    //  - Kotlin Multiplatform → null (no single compile-only task: `compileKotlinJvm`/`…Js`/`…Metadata`).
    //  - plain kotlin-jvm → `compileKotlin` EXISTS (single JVM target), so use it for edit-time feedback.
    const typecheck = !kotlin
      ? `${wrapper} compileJava`
      : multiplatform
        ? null
        : `${wrapper} compileKotlin`;
    // Dev/run command: Spring → `bootRun`; the gradle `application` plugin (Ktor, CLI apps) → `run`.
    const dev = spring ? `${wrapper} bootRun` : hasApp ? `${wrapper} run` : null;
    return {
      stack: "java", packageManager: "gradle", isMonorepo: isMultiModule,
      workspaces: [], installCommand: install, buildCommand: `${wrapper} build`,
      testCommand: `${wrapper} ${testTask}`, quickTestCommand: `${wrapper} ${testTask}`, lintCommand: `${wrapper} check`,
      typecheckCommand: typecheck,
      devCommand: dev,
      isWeb: web,
      devHealthUrl: null, devPort,
      testDir: firstExistingDir(repoPath, ["src/commonTest/kotlin", "src/test/kotlin", "src/test/java", "src/test"]),
      testRunner: "gradle",
    };
  }
  if (markers.has("pom.xml")) {
    return {
      stack: "java", packageManager: "maven", isMonorepo: /<modules>/.test(readFileSync(join(repoPath, "pom.xml"), "utf8").slice(0, 8000)),
      workspaces: [], installCommand: "mvn install -DskipTests", buildCommand: "mvn package",
      testCommand: "mvn test", quickTestCommand: "mvn test", lintCommand: "mvn verify",
      typecheckCommand: "mvn compile", devCommand: "mvn spring-boot:run", isWeb: false,
      devHealthUrl: null, devPort: null, testDir: firstExistingDir(repoPath, ["src/test/java", "src/test"]), testRunner: "maven",
    };
  }
  if (markers.has("pyproject.toml") || markers.has("Pipfile") || markers.has("requirements.txt")) {
    // uv first: a uv project installs into a project-local .venv, so the global interpreter
    // has no pytest and a bare `python -m pytest` merge gate always fails (#120). Its
    // pyproject.toml may also carry a [tool.poetry] block, so uv must win the tie.
    const uv = isUvProject(repoPath, markers);
    const poetry = !uv && markers.has("pyproject.toml") && /\[tool\.poetry\]/.test(readFileSafe(join(repoPath, "pyproject.toml")));
    const pm = uv ? "uv" : poetry ? "poetry" : markers.has("Pipfile") ? "pipenv" : "pip";
    const install = uv
      ? "uv sync"
      : poetry ? "poetry install" : markers.has("Pipfile") ? "pipenv install --dev" : "pip install -r requirements.txt";
    // uv's runner invokes the tool directly (`uv run pytest`), not via `python -m`.
    const run = (cmd: string) => (poetry ? `poetry run ${cmd}` : markers.has("Pipfile") ? `pipenv run ${cmd}` : cmd);
    const runTool = (tool: string) => (uv ? `uv run ${tool}` : run(tool));
    return {
      stack: "python", packageManager: pm, isMonorepo: false, workspaces: [],
      installCommand: install, buildCommand: null,
      testCommand: uv ? "uv run pytest" : run("python -m pytest"),
      quickTestCommand: uv ? "uv run pytest -x" : run("python -m pytest -x"),
      lintCommand: runTool("ruff check ."), typecheckCommand: runTool("mypy ."), devCommand: null, isWeb: false,
      devHealthUrl: null, devPort: null, testDir: firstExistingDir(repoPath, ["tests", "test"]), testRunner: "pytest",
    };
  }
  return null;
}

export function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const EMPTY_PROFILE: Omit<StackProfile, "source" | "detectedMarkers" | "updatedAt"> = {
  stack: null, packageManager: null, isMonorepo: false, workspaces: [],
  installCommand: null, buildCommand: null, testCommand: null, quickTestCommand: null,
  lintCommand: null, typecheckCommand: null, devCommand: null, isWeb: false,
  devHealthUrl: null, devPort: null, testDir: null, testRunner: null,
};

/**
 * Rule-based detection of a project's stack profile from marker files on disk. Pure and
 * synchronous — no DB, no LLM. Returns a fully-populated descriptor (nullable fields where
 * a fact can't be derived). `source` is "detected" even when sparse; the LLM fallback
 * (see populateStackProfile) fills gaps and flips source to "llm".
 */
export function detectStackProfile(repoPath: string): StackProfile {
  const markers = detectProjectMarkers(repoPath);
  const markerSet = new Set(markers);

  let partial: Partial<StackProfile> | null = null;
  if (markerSet.has("package.json")) {
    partial = detectNodeProfile(repoPath, markerSet);
  } else {
    partial = detectOtherProfile(repoPath, markerSet);
  }

  return {
    ...EMPTY_PROFILE,
    ...(partial ?? {}),
    source: "detected",
    detectedMarkers: markers,
    updatedAt: new Date().toISOString(),
  };
}
