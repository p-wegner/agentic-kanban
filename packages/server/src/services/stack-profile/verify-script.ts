// Verify (merge-gate) command derived from the stack profile (#788; #911 split).
//
// The verify gate is the keystone auto-merge gate (`exit-workflow.ts` withholds
// readyForMerge on a non-zero exit). Re-exported byte-identically through
// ../stack-profile.service.ts.

import type { StackProfile } from "@agentic-kanban/shared";
import type { Database } from "../../db/index.js";
import { getPreference, setPreference } from "../../repositories/preferences.repository.js";
import { detectProjectMarkers, deriveVerifyScript } from "../project-setup.service.js";
import { getStackProfile } from "./persistence.js";

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
