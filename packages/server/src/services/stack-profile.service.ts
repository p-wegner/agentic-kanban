import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StackProfile, SmokeCheck } from "@agentic-kanban/shared";
import { projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { detectProjectMarkers, deriveVerifyScript } from "./project-setup.service.js";
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

/**
 * Monorepo-aware install command for a Node package manager.
 *
 * pnpm/yarn/npm/bun all install every workspace from a single root invocation
 * (pnpm is recursive by default; npm 7+/yarn/bun resolve the whole workspace graph),
 * so the command shape is the same — but we surface `-r` for pnpm monorepos to make the
 * "install ALL workspaces" intent explicit and robust against a non-root cwd.
 */
function nodeInstallCommand(pm: string, isMonorepo: boolean): string {
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
    const wrapper = existsSync(join(repoPath, "gradlew")) ? "./gradlew" : "gradle";
    const isMultiModule = existsSync(join(repoPath, "settings.gradle")) || existsSync(join(repoPath, "settings.gradle.kts"));
    // `gradle dependencies` resolves only the ROOT project's deps; a multi-module build
    // needs every subproject's deps materialized before the first build. `assemble` builds
    // all subproject artifacts, which downloads/resolves every module's dependencies.
    const install = isMultiModule ? `${wrapper} assemble` : `${wrapper} dependencies`;
    return {
      stack: "java", packageManager: "gradle", isMonorepo: isMultiModule,
      workspaces: [], installCommand: install, buildCommand: `${wrapper} build`,
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
        await saveStackProfile(projectId, enriched, database, repoPath);
        return enriched;
      }
    } catch {
      // LLM enrichment is best-effort — fall through and persist the rule-based profile.
    }
  }

  await saveStackProfile(projectId, profile, database, repoPath);
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

/**
 * Persist a stack profile JSON to the project's preference key. When `repoPath` is given,
 * also (re)generate the project's `.claude/smart-hooks-rules.json` so an edit-time feedback
 * harness stays in sync with the latest profile (#787). Rule generation is non-fatal.
 */
export async function saveStackProfile(
  projectId: string,
  profile: StackProfile,
  database: Database,
  repoPath?: string,
): Promise<void> {
  await setPreference(stackProfilePrefKey(projectId), JSON.stringify(profile), database);
  if (repoPath) {
    writeSmartHooksRules(repoPath, profile);
    writeTestScaffold(repoPath, profile);
  }
}

// ---------------------------------------------------------------------------
// Edit-time feedback rules generated from the stack profile (#787)
// ---------------------------------------------------------------------------

/** One file-pattern -> quick-check entry in the generated smart-hooks-rules.json. */
export interface SmartHooksRule {
  /** Human label shown when the check fails. */
  name: string;
  /** Quick build/test/typecheck command to run (from the stack profile). */
  command: string;
  /** Glob-ish patterns (smart-hooks-runner.js dialect) that trigger this rule. */
  filePatterns: string[];
  /** Block the agent on failure. Quick incremental checks block; reminders don't. */
  blocking: boolean;
  /** Seconds before the check is killed. */
  timeout: number;
}

export interface SmartHooksRulesFile {
  version: "1.0.0";
  /** Marks the file as machine-generated so humans/tools know not to hand-edit it. */
  generated: true;
  /** The stack the rules were derived from, for debuggability. */
  stack: string | null;
  /** When the rules were generated. */
  generatedAt: string;
  /** Rules evaluated on PostToolUse (per-edit) and Stop (end-of-session). */
  rules: SmartHooksRule[];
}

/** Per-stack source-file glob patterns that should trigger an edit-time quick check. */
const STACK_SOURCE_PATTERNS: Record<string, string[]> = {
  node: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
  rust: ["**/*.rs"],
  go: ["**/*.go"],
  python: ["**/*.py"],
  java: ["**/*.java", "**/*.kt"],
  ruby: ["**/*.rb"],
  elixir: ["**/*.ex", "**/*.exs"],
};

/** Source patterns for a profile's stack, falling back to a broad set when the stack is unknown. */
function sourcePatternsForStack(stack: string | null): string[] {
  if (stack && STACK_SOURCE_PATTERNS[stack]) return STACK_SOURCE_PATTERNS[stack];
  // Unknown stack: union of all known source extensions so SOME feedback still fires.
  return [...new Set(Object.values(STACK_SOURCE_PATTERNS).flat())];
}

/**
 * Build the generated edit-time feedback rules from a stack profile. Pure — no I/O.
 *
 * Prefers the cheapest signal available: typecheck (fastest), else quick test, else the full
 * test command. Each non-null command becomes a rule that fires when a source file for the
 * stack is edited. Project-agnostic: every command comes from the profile, nothing hard-coded
 * to a particular repo. Returns an empty `rules` list when the profile has no usable command.
 */
export function buildSmartHooksRules(profile: StackProfile): SmartHooksRulesFile {
  const patterns = sourcePatternsForStack(profile.stack);
  const rules: SmartHooksRule[] = [];

  // Typecheck is the cheapest correctness signal — run it per-edit when present.
  if (profile.typecheckCommand) {
    rules.push({
      name: "Typecheck",
      command: profile.typecheckCommand,
      filePatterns: patterns,
      blocking: true,
      timeout: 120,
    });
  }

  // Quick/affected tests give behavioral feedback. Fall back to the full test command only
  // when there is no quick variant (and no typecheck already covering the edit).
  const testCommand = profile.quickTestCommand ?? profile.testCommand;
  if (testCommand) {
    rules.push({
      name: profile.quickTestCommand ? "Quick tests" : "Tests",
      command: testCommand,
      filePatterns: patterns,
      blocking: true,
      timeout: 180,
    });
  }

  return {
    version: "1.0.0",
    generated: true,
    stack: profile.stack,
    generatedAt: new Date().toISOString(),
    rules,
  };
}

/** Repo-relative path of the generated edit-time feedback rules file. */
export function smartHooksRulesPath(repoPath: string): string {
  return join(repoPath, ".claude", "smart-hooks-rules.json");
}

/**
 * Generate and write `.claude/smart-hooks-rules.json` for a project from its stack profile.
 * The generic `smart-hooks-runner.js` reads this file to give a driven project's builder the
 * same incremental PostToolUse/Stop feedback board builders get. Non-fatal on any error —
 * profile persistence must never fail because rule generation did.
 */
export function writeSmartHooksRules(repoPath: string, profile: StackProfile): void {
  try {
    const rulesFile = buildSmartHooksRules(profile);
    const outPath = smartHooksRulesPath(repoPath);
    mkdirSync(join(repoPath, ".claude"), { recursive: true });
    writeFileSync(outPath, JSON.stringify(rulesFile, null, 2) + "\n", "utf8");
  } catch {
    /* non-fatal: rule generation must never block profile persistence */
  }
}

// ---------------------------------------------------------------------------
// Stack-aware test scaffold derived from the stack profile (#793)
// ---------------------------------------------------------------------------

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

/** Map a (possibly null) testRunner + stack to the canonical runner key we generate for. */
function resolveRunnerKey(profile: StackProfile): string | null {
  const runner = (profile.testRunner ?? "").toLowerCase();
  if (runner.includes("pytest")) return "pytest";
  if (runner.includes("vitest")) return "vitest";
  if (runner.includes("jest")) return "jest";
  if (runner.includes("mocha")) return "mocha";
  if (runner.includes("playwright")) return "playwright";
  if (runner.includes("cargo")) return "cargo";
  if (runner.includes("go")) return "go";
  if (runner === "gradle" || runner === "maven") return "junit";

  // No (or unrecognized) runner — fall back to the stack family's conventional runner.
  switch (profile.stack) {
    case "node": return "vitest";
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
 * treat that as a safe no-op. Pure — no I/O.
 *
 * @param isTypeScript hint that a Node project is TypeScript (so the scaffold gets a `.ts`
 *   extension); writeTestScaffold derives it from a tsconfig.json on disk. Ignored for non-Node.
 */
export function deriveTestScaffold(profile: StackProfile | null, isTypeScript?: boolean): TestScaffold | null {
  if (!profile) return null;
  const runner = resolveRunnerKey(profile);
  if (!runner) return null;
  return scaffoldForRunner(runner, profile, isTypeScript);
}

/**
 * Write the derived test scaffold into the project's worktree (#793).
 *
 * Clobber-safe and idempotent: never overwrites an existing file at the target path (so a real
 * test the project already has is preserved, and a second run is a no-op). Creates the test
 * directory if absent. Non-fatal on any error — scaffolding must never block profile persistence
 * (same contract as writeSmartHooksRules). Returns the repo-relative path written, or null when
 * nothing was written (no derivable scaffold, file already present, or an error).
 */
export function writeTestScaffold(repoPath: string, profile: StackProfile): string | null {
  try {
    const isTypeScript = existsSync(join(repoPath, "tsconfig.json"));
    const scaffold = deriveTestScaffold(profile, isTypeScript);
    if (!scaffold) return null;
    const outPath = join(repoPath, scaffold.path);
    if (existsSync(outPath)) return null; // never clobber an existing test
    mkdirSync(join(outPath, ".."), { recursive: true });
    writeFileSync(outPath, scaffold.content, "utf8");
    return scaffold.path;
  } catch {
    return null; // non-fatal: must never block profile persistence
  }
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

/** Preference key holding the active verify (merge-gate) command for a project. */
export function verifyScriptPrefKey(projectId: string): string {
  return `verify_script_${projectId}`;
}

/**
 * Derive the verify (merge-gate) command for a project from its stack profile (#788).
 *
 * The verify gate is the keystone auto-merge gate (`exit-workflow.ts` withholds
 * readyForMerge on a non-zero exit), so a freshly-registered project needs it live.
 * Source of truth = the persisted #786 stack profile (`testCommand` &&/|| `buildCommand`);
 * falls back to the rule-based marker derivation when no profile is available yet.
 * Returns "" when nothing can be derived — callers must treat that as a safe no-op.
 */
export function deriveVerifyScriptFromProfile(profile: StackProfile | null, repoPath: string): string {
  if (profile) {
    const parts: string[] = [];
    if (profile.testCommand) parts.push(profile.testCommand);
    if (profile.buildCommand) parts.push(profile.buildCommand);
    if (parts.length > 0) return parts.join(" && ");
  }
  // No profile (or a profile with neither test nor build) — fall back to marker rules.
  return deriveVerifyScript(repoPath, detectProjectMarkers(repoPath));
}

/**
 * Persist the derived verify gate to `verify_script_<projectId>` at registration (#788).
 *
 * Idempotent and non-destructive: a no-op when the key is already set (never clobbers a
 * user override) and when detection yields nothing (no empty value written). Best-effort —
 * callers run it fire-and-forget so it never slows or fails registration.
 *
 * Reuses an already-computed stack profile when passed; otherwise reads the persisted one.
 */
export async function populateVerifyScript(
  projectId: string,
  repoPath: string,
  database: Database,
  profile?: StackProfile | null,
): Promise<string | null> {
  const existing = await getPreference(verifyScriptPrefKey(projectId), database);
  if (existing && existing.trim()) return existing; // already configured — don't overwrite

  const resolvedProfile = profile ?? (await getStackProfile(projectId, database));
  const verify = deriveVerifyScriptFromProfile(resolvedProfile, repoPath).trim();
  if (!verify) return null; // nothing to gate on — leave unset (pure no-op)

  await setPreference(verifyScriptPrefKey(projectId), verify, database);
  return verify;
}

// ---------------------------------------------------------------------------
// Run/smoke verification harness derived from the stack profile (#791)
// ---------------------------------------------------------------------------

/** Resolve the health URL to poll, from an explicit URL or a known dev port. */
function resolveHealthUrl(profile: StackProfile): string | null {
  if (profile.devHealthUrl && profile.devHealthUrl.trim()) return profile.devHealthUrl.trim();
  if (profile.devPort && profile.devPort > 0) return `http://127.0.0.1:${profile.devPort}`;
  return null;
}

/**
 * Build the generalized "does it boot and respond/render" smoke check from a stack profile (#791).
 *
 * This is the project-agnostic successor to the hand-rolled `frontend-smoke.ps1`: the WHAT
 * (dev command, health URL, render assertions) all comes from the profile, nothing is hard-coded
 * to a particular repo. Runs as part of review for web/service projects.
 *
 * Returns `null` — a clean no-op — when the project is not a web/service project, or lacks a dev
 * command or a resolvable health URL. So a CLI/library project skips the smoke step entirely;
 * only something that can actually be booted and hit over HTTP gets checked.
 *
 * Assertions are intentionally generic: an HTTP-200 plus, for an HTML UI, that the rendered body
 * is non-trivially present (we assert on a couple of universal HTML tokens rather than any
 * app-specific text, since the harness can't know a toy project's copy). A service with no HTML
 * passes on the 200 alone.
 */
export function buildSmokeCheck(profile: StackProfile | null): SmokeCheck | null {
  if (!profile || !profile.isWeb) return null;
  if (!profile.devCommand || !profile.devCommand.trim()) return null;
  const healthUrl = resolveHealthUrl(profile);
  if (!healthUrl) return null;

  // Render assertion: for a browser UI the served document contains an <html>/<body> shell.
  // Asserting on these universal tokens (not app-specific copy) keeps the check generic across
  // any web toy-project. A non-browser HTTP service still passes on the 200 with no body needle.
  return {
    devCommand: profile.devCommand.trim(),
    healthUrl,
    expectBodyContains: isLikelyBrowserStack(profile) ? ["<html", "<body"] : [],
  };
}

/** Heuristic: does the dev command serve a browser-rendered UI (vs a headless HTTP API)? */
function isLikelyBrowserStack(profile: StackProfile): boolean {
  const cmd = (profile.devCommand ?? "").toLowerCase();
  // Vite/Next/Angular/CRA dev servers serve an HTML document; bare API servers (express/hono on
  // a JSON route) typically don't. Asserting <html> only when we're confident it's served avoids
  // false negatives on a pure-JSON service.
  return /\bvite\b|\bnext\b|\bng serve\b|react-scripts|\bnuxt\b|\bastro\b|\bremix\b|\bsvelte/.test(cmd);
}

// ---------------------------------------------------------------------------
// Setup (install) script derived from the stack profile (#810)
// ---------------------------------------------------------------------------

/** Marker-rule fallback install command when no stack profile is available yet. */
function deriveInstallFromMarkers(repoPath: string): string {
  const markers = new Set(detectProjectMarkers(repoPath));
  if (markers.has("package.json")) {
    const pm = markers.has("pnpm-lock.yaml")
      ? "pnpm"
      : markers.has("yarn.lock")
        ? "yarn"
        : markers.has("bun.lockb") || markers.has("bun.lock")
          ? "bun"
          : "npm";
    // pnpm-workspace.yaml or a package.json `workspaces` field ⇒ monorepo ⇒ recursive install.
    // (pnpm-workspace.yaml is not in PROJECT_MARKER_FILES, so check disk directly.)
    const pkg = readJson<NodePkgJson>(join(repoPath, "package.json"));
    const isMonorepo = existsSync(join(repoPath, "pnpm-workspace.yaml")) || Boolean(pkg?.workspaces);
    return nodeInstallCommand(pm, isMonorepo);
  }
  if (markers.has("Cargo.toml")) return "cargo fetch";
  if (markers.has("go.mod")) return "go mod download";
  if (markers.has("build.gradle") || markers.has("build.gradle.kts")) {
    const wrapper = existsSync(join(repoPath, "gradlew")) ? "./gradlew" : "gradle";
    const isMultiModule = existsSync(join(repoPath, "settings.gradle")) || existsSync(join(repoPath, "settings.gradle.kts"));
    return isMultiModule ? `${wrapper} assemble` : `${wrapper} dependencies`;
  }
  if (markers.has("pom.xml")) return "mvn install -DskipTests";
  if (markers.has("pyproject.toml")) {
    return /\[tool\.poetry\]/.test(readFileSafe(join(repoPath, "pyproject.toml"))) ? "poetry install" : "pip install -e .";
  }
  if (markers.has("Pipfile")) return "pipenv install --dev";
  if (markers.has("requirements.txt")) return "pip install -r requirements.txt";
  return "";
}

/**
 * Derive the setup (install) command for a project from its stack profile (#810).
 *
 * The setup script runs once in a fresh worktree BEFORE the first build so deps are
 * ready. It must be monorepo-aware: for a monorepo the install must materialize ALL
 * workspaces/modules' deps, not just the root package — `installCommand` already
 * encodes that (e.g. pnpm `-r`, gradle multi-module `assemble`). Source of truth =
 * the persisted #786 stack profile's `installCommand`; falls back to marker rules when
 * no profile is available yet. Returns "" when nothing can be derived (safe no-op).
 */
export function deriveSetupScriptFromProfile(profile: StackProfile | null, repoPath: string): string {
  if (profile?.installCommand && profile.installCommand.trim()) {
    return profile.installCommand.trim();
  }
  return deriveInstallFromMarkers(repoPath).trim();
}

/**
 * Persist the derived setup (install) command to the project's `setup_script` column (#810).
 *
 * Idempotent and non-destructive: a no-op when the column is already set (never clobbers a
 * user/AI-generated script) and when detection yields nothing (no empty value written).
 * Best-effort — callers run it fire-and-forget so it never slows or fails registration.
 *
 * Reuses an already-computed stack profile when passed; otherwise reads the persisted one.
 */
export async function populateSetupScript(
  projectId: string,
  repoPath: string,
  database: Database,
  profile?: StackProfile | null,
): Promise<string | null> {
  const [project] = await database
    .select({ setupScript: projects.setupScript })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (project?.setupScript && project.setupScript.trim()) return project.setupScript; // already configured

  const resolvedProfile = profile ?? (await getStackProfile(projectId, database));
  const setup = deriveSetupScriptFromProfile(resolvedProfile, repoPath).trim();
  if (!setup) return null; // nothing to install — leave unset (pure no-op)

  await database
    .update(projects)
    .set({ setupScript: setup, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, projectId));
  return setup;
}
