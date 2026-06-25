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
import { writeSmartHooksRules } from "./smart-hooks-rules.js";
import { writeTestScaffold } from "./test-scaffold.js";

/** Preference key holding the persisted JSON stack profile for a project. */
export function stackProfilePrefKey(projectId: string): string {
  return `project_stack_profile_${projectId}`;
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
