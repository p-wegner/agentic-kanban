// Stack-profile persistence + LLM enrichment (#911 split of stack-profile.service.ts).
//
// Owns the profile lifecycle: detect → (optionally) enrich via the LLM → persist to
// `project_stack_profile_<projectId>`, plus the read side. Re-exported byte-identically
// through ../stack-profile.service.ts so consumers' imports don't change.

import { readdirSync } from "node:fs";
import type { StackProfile } from "@agentic-kanban/shared";
import type { Database } from "../../db/index.js";
import { getPreference, setPreference } from "../../repositories/preferences.repository.js";
import { invokeClaudePrompt } from "../claude-cli.service.js";
import { detectStackProfile } from "../stack-detector.service.js";
import { recordScaffoldArtifactWrite } from "../project-scaffold.js";
import { writeSmartHooksRules } from "./smart-hooks-rules.js";
import { writeTestScaffold } from "./test-scaffold.js";

/** Preference key holding the persisted JSON stack profile for a project. */
export function stackProfilePrefKey(projectId: string): string {
  return `project_stack_profile_${projectId}`;
}

/** Fields whose absence makes the LLM fallback worth invoking. Exported so a caller that
 *  needs to REPORT whether an LLM gap-fill would run (project-registration.ts) reads the
 *  same predicate populateStackProfile enforces, instead of keeping a hand-synced copy. */
export function isProfileSparse(profile: StackProfile): boolean {
  return !profile.stack || (!profile.testCommand && !profile.buildCommand);
}

/**
 * Whether persisting a profile may also MATERIALIZE the profile-derived scaffolds into the
 * user's repo (`.claude/smart-hooks-rules.json` + the starter test scaffold).
 *
 * Default OFF (#41). Profile detection/persistence is otherwise PURE with respect to the
 * user's working tree: a read (`GET /api/projects/:id/stack-profile`), enabling Drive, or a
 * repair backfill must never write files into a repo nobody asked to scaffold — those writes
 * landed untracked in the main checkout and got swept into the project's history by an
 * agent's `git add -A`.
 *
 * Only registration opts in, and it does so BEFORE its scaffold commit
 * (`scaffoldAndPopulateProject`), so everything the board writes is also committed.
 */
export interface StackProfileScaffoldOptions {
  scaffold?: boolean;
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
 *
 * Pure w.r.t. the user's repo unless `scaffold: true` — see StackProfileScaffoldOptions (#41).
 */
export async function populateStackProfile(
  projectId: string,
  repoPath: string,
  database: Database,
  options?: { skipLlm?: boolean } & StackProfileScaffoldOptions,
): Promise<StackProfile> {
  const profile = detectStackProfile(repoPath);
  const scaffoldOptions = { scaffold: options?.scaffold };

  if (!options?.skipLlm && isProfileSparse(profile)) {
    try {
      const enriched = await enrichWithLlm(profile, repoPath, database);
      if (enriched) {
        await saveStackProfile(projectId, enriched, database, repoPath, scaffoldOptions);
        return enriched;
      }
    } catch {
      // LLM enrichment is best-effort — fall through and persist the rule-based profile.
    }
  }

  await saveStackProfile(projectId, profile, database, repoPath, scaffoldOptions);
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
 * Persist a stack profile JSON to the project's preference key.
 *
 * With `{ scaffold: true }` (and a `repoPath`) it ALSO materializes the profile-derived
 * scaffolds into the repo: `.claude/smart-hooks-rules.json`, so an edit-time feedback harness
 * stays in sync with the profile (#787), and the starter test scaffold (#793). Both writes are
 * non-fatal and clobber-safe.
 *
 * Default OFF (#41): a bare save — a profile read, Drive enablement, a repair backfill — must
 * leave the user's working tree untouched. The test scaffold's path is reported to
 * `recordScaffoldArtifactWrite` so registration's scaffold commit sweeps it in;
 * `.claude/smart-hooks-rules.json` is already in DURABLE_CLAUDE_SCAFFOLD_PATHS.
 */
export async function saveStackProfile(
  projectId: string,
  profile: StackProfile,
  database: Database,
  repoPath?: string,
  options?: StackProfileScaffoldOptions,
): Promise<void> {
  await setPreference(stackProfilePrefKey(projectId), JSON.stringify(profile), database);
  if (repoPath && options?.scaffold) {
    writeSmartHooksRules(repoPath, profile);
    const testScaffoldPath = writeTestScaffold(repoPath, profile);
    if (testScaffoldPath) recordScaffoldArtifactWrite(repoPath, testScaffoldPath);
  }
}

/** The empty profile used as the merge base when a project has no persisted
 *  profile yet but the user is overriding fields from the UI. */
function emptyManualStackProfile(): StackProfile {
  return {
    stack: null, packageManager: null, isMonorepo: false, workspaces: [],
    installCommand: null, buildCommand: null, testCommand: null, quickTestCommand: null,
    lintCommand: null, typecheckCommand: null, devCommand: null, isWeb: false,
    devHealthUrl: null, devPort: null, testDir: null, testRunner: null,
    source: "manual", detectedMarkers: [], updatedAt: new Date().toISOString(),
  };
}

/** Apply a partial UI override onto the existing (or empty) profile and persist it
 *  as `source: "manual"` so a later auto-detect won't silently clobber it. Returns
 *  the merged profile. Owns the default StackProfile shape so route handlers don't
 *  have to enumerate every field. */
export async function saveManualStackProfile(
  projectId: string,
  partial: Partial<StackProfile>,
  database: Database,
  repoPath?: string,
  options?: StackProfileScaffoldOptions,
): Promise<StackProfile> {
  const existing = (await getStackProfile(projectId, database)) ?? emptyManualStackProfile();
  const merged: StackProfile = {
    ...existing,
    ...partial,
    source: "manual",
    updatedAt: new Date().toISOString(),
  };
  await saveStackProfile(projectId, merged, database, repoPath, options);
  return merged;
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
