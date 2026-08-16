// Setup (install) script derived from the stack profile (#810; #911 split).
//
// Monorepo-aware install command run once in a fresh worktree before the first build.
// Re-exported byte-identically through ../stack-profile.service.ts.

import type { StackProfile } from "@agentic-kanban/shared";
import type { Database } from "../../db/index.js";
import { getProjectSetupScript, setProjectSetupScript } from "../../repositories/stack-profile.repository.js";
import { detectStackProfile } from "../stack-detector.service.js";
import { getStackProfile } from "./persistence.js";

/**
 * Marker-rule fallback install command when no stack profile is available yet (#521).
 *
 * This was a 35-line ladder re-deriving, per marker, what `detectStackProfile` already
 * decides — the same pnpm/yarn/bun/npm cascade, the same gradle assemble-vs-dependencies
 * split (with the same explanatory comment), the same uv-before-poetry ordering. The
 * detector is pure and synchronous, so the fallback is just a call to it.
 *
 * The two had actually DIVERGED on one case: a PEP-621 pyproject-only project got
 * `pip install -e .` here and `pip install -r requirements.txt` from the detector, which
 * fails when there is no requirements.txt. Fixed in the detector rather than preserved
 * here, so both paths get the working command.
 */
function deriveInstallFromMarkers(repoPath: string): string {
  return detectStackProfile(repoPath).installCommand ?? "";
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
  const existingSetupScript = await getProjectSetupScript(projectId, database);
  if (existingSetupScript && existingSetupScript.trim()) return existingSetupScript; // already configured

  const resolvedProfile = profile ?? (await getStackProfile(projectId, database));
  const setup = deriveSetupScriptFromProfile(resolvedProfile, repoPath).trim();
  if (!setup) return null; // nothing to install — leave unset (pure no-op)

  await setProjectSetupScript(projectId, setup, database);
  return setup;
}
