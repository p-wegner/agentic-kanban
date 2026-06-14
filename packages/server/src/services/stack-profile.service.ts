import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StackProfile } from "@agentic-kanban/shared";
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
  if (repoPath) writeSmartHooksRules(repoPath, profile);
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
