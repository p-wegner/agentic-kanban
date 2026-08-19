// Verify (merge-gate) command derived from the stack profile (#788; #911 split).
//
// The verify gate is the keystone auto-merge gate (`exit-workflow.ts` withholds
// readyForMerge on a non-zero exit). Re-exported byte-identically through
// ../stack-profile.service.ts.
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";

import type { StackProfile } from "@agentic-kanban/shared";
import { deriveVerifyCommand, deriveVerifyCommandPlan } from "@agentic-kanban/shared/lib/verify-command";
import type { Database } from "../../db/index.js";
import { getPreference, setPreference } from "../../repositories/preferences.repository.js";
import { getProjectById } from "../../repositories/project.repository.js";
import { detectProjectMarkers, deriveVerifyScript } from "../project-setup.service.js";
import { getStackProfile } from "./persistence.js";

/** Preference key holding the active verify (merge-gate) command for a project. */
// #496: built from the registry, so an unregistered prefix is a COMPILE error.
const verifyScriptPrefDef = projectPref("verify_script");

export function verifyScriptPrefKey(projectId: string): string {
  return verifyScriptPrefDef.key(projectId);
}

/**
 * Derive the verify (merge-gate) command for a project from its stack profile (#788).
 *
 * The verify gate is the keystone auto-merge gate (`exit-workflow.ts` withholds
 * readyForMerge on a non-zero exit), so a freshly-registered project needs it live.
 * Source of truth = the persisted #786 stack profile, run through the canonical per-stack
 * verify plan (#124) so the gate executes the SAME quiet, exit-honest command the builder is
 * told to run in its ticket context — instead of a hand-rolled invocation that trips the
 * PowerShell native-stderr trap. Falls back to the rule-based marker derivation when no
 * profile is available yet. Returns "" when nothing can be derived — callers must treat
 * that as a safe no-op.
 */
export function deriveVerifyScriptFromProfile(profile: StackProfile | null, repoPath: string): string {
  const canonical = deriveVerifyCommand(profile);
  if (canonical) return canonical;
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

/**
 * The one answer to "what command will the merge gate run for this project" (#551).
 *
 * `verify-command.ts` has always DECLARED that one plan feeds both the merge gate and the
 * builder's ticket-context prompt — while the two actually read different sources: the gate
 * reads the `verify_script_<id>` override, the ticket context derived from the stack profile
 * alone. On any project with a hand-set or AI-generated override the builder was told to run
 * a different command than it would be merged against. This resolver is that single answer,
 * in the GATE's precedence: override first, derived second.
 *
 * `rules`/`onFailure` always come from the derived plan even when the command is an override —
 * the per-stack traps (PowerShell native-stderr, raw XML reports) are true of the stack, not
 * of the particular invocation.
 *
 * Returns null when nothing can be resolved; callers must treat that as "no gate".
 */
export interface EffectiveVerify {
  command: string;
  rules: string[];
  onFailure: string | null;
  /** Where the command came from — an operator/AI override, or derived from the stack. */
  source: "override" | "derived";
}

export async function resolveEffectiveVerify(
  projectId: string,
  database: Database,
  opts: {
    /** Reuse an already-loaded profile instead of re-reading it. */
    profile?: StackProfile | null;
    /** Reuse an already-loaded repo path; read from the project row when absent. */
    repoPath?: string | null;
    /**
     * Persist a DERIVED command to `verify_script_<projectId>` (#377 gate-time derivation).
     * Only the gate itself passes this — a read-only consumer must not mutate the project.
     */
    persistDerived?: boolean;
  } = {},
): Promise<EffectiveVerify | null> {
  const override = await getPreference(verifyScriptPrefKey(projectId), database).catch(() => null);
  const profile = opts.profile !== undefined ? opts.profile : await getStackProfile(projectId, database);
  const plan = deriveVerifyCommandPlan(profile);

  if (override && override.trim()) {
    return { command: override.trim(), rules: plan?.rules ?? [], onFailure: plan?.onFailure ?? null, source: "override" };
  }

  let repoPath = opts.repoPath ?? null;
  if (!repoPath) {
    const project = await getProjectById(projectId, database).catch(() => null);
    repoPath = project?.repoPath ?? null;
  }
  if (!repoPath) return null;

  const derived = deriveVerifyScriptFromProfile(profile, repoPath).trim();
  if (!derived) return null;
  if (opts.persistDerived) {
    await setPreference(verifyScriptPrefKey(projectId), derived, database).catch(() => undefined);
  }
  return { command: derived, rules: plan?.rules ?? [], onFailure: plan?.onFailure ?? null, source: "derived" };
}
