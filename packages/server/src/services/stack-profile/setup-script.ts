// Setup (install) script derived from the stack profile (#810; #911 split).
//
// Monorepo-aware install command run once in a fresh worktree before the first build.
// Re-exported byte-identically through ../stack-profile.service.ts.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StackProfile } from "@agentic-kanban/shared";
import type { Database } from "../../db/index.js";
import { getProjectSetupScript, setProjectSetupScript } from "../../repositories/stack-profile.repository.js";
import { detectProjectMarkers } from "../project-setup.service.js";
import { gradleWrapper } from "../gradle-detect.service.js";
import { readJson, nodeInstallCommand, readFileSafe, type NodePkgJson } from "../stack-detector.service.js";
import { getStackProfile } from "./persistence.js";

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
    const wrapper = gradleWrapper(repoPath);
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
  const existingSetupScript = await getProjectSetupScript(projectId, database);
  if (existingSetupScript && existingSetupScript.trim()) return existingSetupScript; // already configured

  const resolvedProfile = profile ?? (await getStackProfile(projectId, database));
  const setup = deriveSetupScriptFromProfile(resolvedProfile, repoPath).trim();
  if (!setup) return null; // nothing to install — leave unset (pure no-op)

  await setProjectSetupScript(projectId, setup, database);
  return setup;
}
