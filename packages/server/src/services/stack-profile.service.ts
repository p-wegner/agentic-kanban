import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StackProfile } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { detectProjectMarkers } from "./project-setup.service.js";
import { invokeClaudePrompt } from "./claude-cli.service.js";

/** Preference key holding the persisted JSON stack profile for a project. */
export function stackProfilePrefKey(projectId: string): string {
  return `project_stack_profile_${projectId}`;
}

function firstExistingDir(repoPath: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(join(repoPath, candidate))) return candidate;
  }
  return null;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Detect the package manager from lock files, falling back to npm for a bare package.json. */
function detectNodePackageManager(markers: Set<string>): string {
  if (markers.has("pnpm-lock.yaml")) return "pnpm";
  if (markers.has("yarn.lock")) return "yarn";
  if (markers.has("bun.lockb") || markers.has("bun.lock")) return "bun";
  return "npm";
}

interface NodePkgJson {
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
    installCommand: pm === "npm" ? "npm install" : `${pm} install`,
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
    const wrapper = existsSync(join(repoPath, "gradlew")) ? "./gradlew" : "gradle";
    return {
      stack: "java", packageManager: "gradle", isMonorepo: existsSync(join(repoPath, "settings.gradle")) || existsSync(join(repoPath, "settings.gradle.kts")),
      workspaces: [], installCommand: `${wrapper} dependencies`, buildCommand: `${wrapper} build`,
      testCommand: `${wrapper} test`, quickTestCommand: `${wrapper} test`, lintCommand: `${wrapper} check`,
      typecheckCommand: `${wrapper} compileJava`, devCommand: `${wrapper} bootRun`,
      isWeb: existsSync(join(repoPath, "src", "main", "resources", "application.properties")) || existsSync(join(repoPath, "src", "main", "resources", "application.yml")),
      devHealthUrl: null, devPort: null, testDir: firstExistingDir(repoPath, ["src/test/java", "src/test"]), testRunner: "gradle",
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
    const poetry = markers.has("pyproject.toml") && /\[tool\.poetry\]/.test(readFileSafe(join(repoPath, "pyproject.toml")));
    const pm = poetry ? "poetry" : markers.has("Pipfile") ? "pipenv" : "pip";
    const install = poetry ? "poetry install" : markers.has("Pipfile") ? "pipenv install --dev" : "pip install -r requirements.txt";
    const run = (cmd: string) => (poetry ? `poetry run ${cmd}` : markers.has("Pipfile") ? `pipenv run ${cmd}` : cmd);
    return {
      stack: "python", packageManager: pm, isMonorepo: false, workspaces: [],
      installCommand: install, buildCommand: null,
      testCommand: run("python -m pytest"), quickTestCommand: run("python -m pytest -x"),
      lintCommand: run("ruff check ."), typecheckCommand: run("mypy ."), devCommand: null, isWeb: false,
      devHealthUrl: null, devPort: null, testDir: firstExistingDir(repoPath, ["tests", "test"]), testRunner: "pytest",
    };
  }
  return null;
}

function readFileSafe(path: string): string {
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

/** Fields whose absence makes the LLM fallback worth invoking. */
function isProfileSparse(profile: StackProfile): boolean {
  return !profile.stack || (!profile.testCommand && !profile.buildCommand);
}

interface LlmProfileShape {
  stack?: string | null;
  packageManager?: string | null;
  buildCommand?: string | null;
  testCommand?: string | null;
  quickTestCommand?: string | null;
  lintCommand?: string | null;
  typecheckCommand?: string | null;
  devCommand?: string | null;
  isWeb?: boolean;
  devHealthUrl?: string | null;
  devPort?: number | null;
  testDir?: string | null;
  testRunner?: string | null;
}

/**
 * Compute, persist, and return a project's stack profile. Detects via rules; when the
 * detected profile is too sparse to be useful (unknown stack, or no test/build command),
 * asks the LLM to fill in the gaps. Always writes the result to
 * `project_stack_profile_<projectId>` so downstream harness pieces read ONE descriptor.
 */
export async function populateStackProfile(
  projectId: string,
  repoPath: string,
  database: Database,
  options?: { skipLlm?: boolean },
): Promise<StackProfile> {
  const profile = detectStackProfile(repoPath);

  if (!options?.skipLlm && isProfileSparse(profile)) {
    try {
      const enriched = await enrichWithLlm(profile, repoPath, database);
      if (enriched) {
        await saveStackProfile(projectId, enriched, database);
        return enriched;
      }
    } catch {
      // LLM enrichment is best-effort — fall through and persist the rule-based profile.
    }
  }

  await saveStackProfile(projectId, profile, database);
  return profile;
}

async function enrichWithLlm(
  profile: StackProfile,
  repoPath: string,
  database: Database,
): Promise<StackProfile | null> {
  let rootListing: string[] = [];
  try {
    rootListing = readdirSync(repoPath).slice(0, 60);
  } catch {
    // ignore
  }

  const prompt = `You are analyzing a software project to produce a STACK PROFILE used by an automated build/test harness.
Respond with ONLY a single JSON object (no markdown, no code fences, no prose) with these keys (use null for unknown):
{"stack","packageManager","buildCommand","testCommand","quickTestCommand","lintCommand","typecheckCommand","devCommand","isWeb","devHealthUrl","devPort","testDir","testRunner"}

Rules:
- Commands must be runnable from the repo root. Prefer the package manager indicated by lock files.
- "quickTestCommand" should be a fast/affected-only variant when one exists, else the same as testCommand.
- "isWeb" is true if the project serves an HTTP/web UI. "devPort" is the dev server port (number) if known.
- Keep commands platform-neutral.

Detected marker files: ${profile.detectedMarkers.length ? profile.detectedMarkers.join(", ") : "none"}
Repo root entries: ${rootListing.length ? rootListing.join(", ") : "unavailable"}
Rule-based guesses so far: ${JSON.stringify({ stack: profile.stack, testCommand: profile.testCommand, buildCommand: profile.buildCommand })}`;

  const raw = (await invokeClaudePrompt(prompt, { timeout: 30000, database })).trim();
  const parsed = parseLlmJson(raw);
  if (!parsed) return null;

  // Merge: rule-based wins where it has a value; LLM fills the gaps.
  const merged: StackProfile = {
    ...profile,
    stack: profile.stack ?? parsed.stack ?? null,
    packageManager: profile.packageManager ?? parsed.packageManager ?? null,
    buildCommand: profile.buildCommand ?? parsed.buildCommand ?? null,
    testCommand: profile.testCommand ?? parsed.testCommand ?? null,
    quickTestCommand: profile.quickTestCommand ?? parsed.quickTestCommand ?? null,
    lintCommand: profile.lintCommand ?? parsed.lintCommand ?? null,
    typecheckCommand: profile.typecheckCommand ?? parsed.typecheckCommand ?? null,
    devCommand: profile.devCommand ?? parsed.devCommand ?? null,
    isWeb: profile.isWeb || Boolean(parsed.isWeb),
    devHealthUrl: profile.devHealthUrl ?? parsed.devHealthUrl ?? null,
    devPort: profile.devPort ?? (typeof parsed.devPort === "number" ? parsed.devPort : null),
    testDir: profile.testDir ?? parsed.testDir ?? null,
    testRunner: profile.testRunner ?? parsed.testRunner ?? null,
    source: "llm",
    updatedAt: new Date().toISOString(),
  };
  return merged;
}

function parseLlmJson(raw: string): LlmProfileShape | null {
  // Strip accidental code fences, then grab the first JSON object.
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as LlmProfileShape;
  } catch {
    return null;
  }
}

/** Persist a stack profile JSON to the project's preference key. */
export async function saveStackProfile(
  projectId: string,
  profile: StackProfile,
  database: Database,
): Promise<void> {
  await setPreference(stackProfilePrefKey(projectId), JSON.stringify(profile), database);
}

/** Read a project's persisted stack profile, or null if none has been computed. */
export async function getStackProfile(
  projectId: string,
  database: Database,
): Promise<StackProfile | null> {
  const raw = await getPreference(stackProfilePrefKey(projectId), database);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StackProfile;
  } catch {
    return null;
  }
}
