import type { ServiceStackConfig } from "@agentic-kanban/shared";
import { buildServicesConfig, type ServicesConfigFormFields } from "./services-config.js";

/**
 * The pure core of `components/SettingsPanel.tsx` (#782).
 *
 * `SettingsPanel.tsx` is the most-reworked file in the client — 113 commits and 34 of them
 * fixes in the last 90 days (`git log --since --no-merges --full-history`) — and had no test
 * at all, because everything in it sat inside a 668-line component. Almost none of what those
 * fixes touched needed React: the project-row → form-state projection, the PATCH body it saves,
 * and the default-branch validity rule that disables Save are all pure functions of their input.
 * They live here (`lib/` is where a pure client module belongs, #589) so a fix to one of them
 * lands with a test instead of a manual click-through.
 */

/**
 * The panel's project-settings form state.
 *
 * Declared here rather than imported from `components/SettingsPanel.shared.tsx`: `lib/` may not
 * import upward into `components/`, even type-only (#694), and a DTO belongs in `lib/` anyway
 * (#610). `SettingsPanel.shared.tsx` still declares the identical `ProjectSettingsState` for the
 * child tabs; the two are checked against each other by the typechecker at every call site here,
 * so a renamed or dropped field fails the build rather than drifting. Collapsing them to one
 * declaration means editing that file, which #782 deliberately keeps out of scope.
 */
export type ProjectSettingsFormState = {
  defaultBranch: string;
  setupScript: string;
  setupBlocking: boolean;
  setupEnabled: boolean;
  teardownScript: string;
  verifyScript: string;
  color: string | null;
  symlinkEnabled: boolean;
  symlinkDirs: string;
  defaultSkillId: string | null;
} & ServicesConfigFormFields;

/** Raw project row shape returned by `GET /api/projects`, narrowed to what the panel reads. */
export type SettingsProjectRow = {
  id: string;
  defaultBranch: string | null;
  setupScript: string | null;
  setupBlocking: boolean;
  color: string | null;
  setupEnabled?: boolean;
  teardownScript?: string | null;
  symlinkEnabled?: boolean;
  symlinkDirs?: string | null;
  defaultSkillId?: string | null;
  servicesConfig?: ServiceStackConfig | null;
};

/**
 * Map a raw project row + its verify-script pref into the panel's form state.
 *
 * The `!== false` / `=== true` asymmetry is the contract, not a typo: `setupBlocking`,
 * `setupEnabled` default ON when the server omits them, `symlinkEnabled` defaults OFF —
 * so a row from an older server does not silently flip a project's behaviour. Nullable
 * text columns become `""` because they are bound to controlled inputs.
 */
export function buildProjectSettingsState(project: SettingsProjectRow, verifyScript: string): ProjectSettingsFormState {
  const svc = project.servicesConfig ?? null;
  return {
    defaultBranch: project.defaultBranch || "",
    setupScript: project.setupScript || "",
    setupBlocking: project.setupBlocking !== false,
    setupEnabled: project.setupEnabled !== false,
    teardownScript: project.teardownScript || "",
    verifyScript,
    color: project.color || null,
    symlinkEnabled: project.symlinkEnabled === true,
    symlinkDirs: project.symlinkDirs || "",
    defaultSkillId: project.defaultSkillId || null,
    servicesEnabled: svc?.enabled === true,
    servicesComposeFile: svc?.composeFile || "",
    servicesComposeRepo: svc?.composeRepo || "",
    servicesPorts: (svc?.ports ?? []).join(", "),
    // Full fetched config: buildServicesConfig merges the form fields over this so
    // API-only fields (env, readyTimeoutMs) survive a settings save.
    servicesConfigBase: svc,
  };
}

/**
 * The `PATCH /api/projects/:id` body for a settings save. Every text field normalises
 * `""` to null so clearing an input clears the column rather than storing an empty string
 * the server would then treat as "configured".
 *
 * `verifyScript` is deliberately absent: it is a PREFERENCE, saved with the settings blob
 * (see `buildSettingsToSave`), not a project column.
 */
export function buildProjectPatchBody(p: ProjectSettingsFormState) {
  return {
    setupScript: p.setupScript || null,
    setupBlocking: p.setupBlocking,
    setupEnabled: p.setupEnabled,
    teardownScript: p.teardownScript || null,
    color: p.color || null,
    defaultBranch: p.defaultBranch.trim() || null,
    symlinkEnabled: p.symlinkEnabled,
    symlinkDirs: p.symlinkDirs.trim() || null,
    defaultSkillId: p.defaultSkillId || null,
    servicesConfig: buildServicesConfig(p),
  };
}

/**
 * True when the typed default branch does not exist locally in the repo — the rule that
 * disables Save and refuses the save handler.
 *
 * An unknown branch list (`null`, the fetch failed or has not landed) must read VALID: the
 * panel loads its branches deferred, so treating "not yet known" as invalid would disable
 * Save for everyone during first paint. Empty input is likewise valid — it clears the column.
 */
export function isDefaultBranchInvalid(defaultBranch: string, branches: { local: string[]; remote: string[] } | null): boolean {
  const value = defaultBranch.trim();
  if (!value || !branches) return false;
  return !branches.local.includes(value);
}

/** The preference key holding a project's verify script. */
export function verifyScriptKey(projectId: string): string {
  return `verify_script_${projectId}`;
}

/**
 * The settings blob to PUT: the panel's settings plus the active project's verify script,
 * which is edited on the Project tab but stored as a per-project preference. Returns a copy —
 * the caller's state object is never mutated.
 */
export function buildSettingsToSave<S extends Record<string, unknown>>(
  settings: S,
  projectSettings: Pick<ProjectSettingsFormState, "verifyScript">,
  activeProjectId: string | null | undefined,
): S {
  const out = { ...settings };
  if (activeProjectId) {
    (out as Record<string, unknown>)[verifyScriptKey(activeProjectId)] = projectSettings.verifyScript;
  }
  return out;
}
