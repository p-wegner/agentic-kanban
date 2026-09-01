import type { ServiceStackConfig } from "@agentic-kanban/shared";
import { isValidTestImpactBudget, testImpactBudgetPrefKey } from "@agentic-kanban/shared/lib/test-impact-budget";
import { buildServicesConfig, type ServicesConfigFormFields } from "./services-config.js";

export { isValidTestImpactBudget, testImpactBudgetPrefKey } from "@agentic-kanban/shared/lib/test-impact-budget";

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
 * The panel's project-settings form state — the SINGLE declaration (#791).
 *
 * It lives here, not in `components/SettingsPanel.shared.tsx`: `lib/` may not import upward into
 * `components/`, even type-only (#694), and a DTO belongs in `lib/` anyway (#610). So the only
 * direction that can carry one declaration is this one, and `SettingsPanel.shared.tsx` re-exports
 * it — leaving the child tabs' imports untouched. #782 left a structurally identical twin behind
 * (this type as `ProjectSettingsState`, plus `ProjectSettingsState` in the shared module),
 * which tsc could catch only for a RENAMED or DROPPED field; a field ADDED to one side was
 * invisible to the other. There is now nothing to add a field to twice.
 */
export type ProjectSettingsState = {
  defaultBranch: string;
  setupScript: string;
  setupBlocking: boolean;
  setupEnabled: boolean;
  teardownScript: string;
  verifyScript: string;
  /** #966 — `test_impact_budget_<projectId>`. Empty = off (today's behaviour exactly). */
  testImpactBudget: string;
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
export function buildProjectSettingsState(
  project: SettingsProjectRow,
  verifyScript: string,
  /** #966 — the `test_impact_budget_<id>` pref. Optional so existing callers/tests are unchanged. */
  testImpactBudget = "",
): ProjectSettingsState {
  const svc = project.servicesConfig ?? null;
  return {
    defaultBranch: project.defaultBranch || "",
    setupScript: project.setupScript || "",
    setupBlocking: project.setupBlocking !== false,
    setupEnabled: project.setupEnabled !== false,
    teardownScript: project.teardownScript || "",
    verifyScript,
    testImpactBudget,
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
 * `verifyScript` and `testImpactBudget` are deliberately absent: both are PREFERENCES, saved
 * with the settings blob (see `buildSettingsToSave`), not project columns.
 */
export function buildProjectPatchBody(p: ProjectSettingsState) {
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

/**
 * The preference key holding a project's verify script.
 *
 * Hand-built, and the reason it is worth NOT copying: this string exists a second time on the
 * server (`verify_script_<id>`) with nothing tying the two together — the drift the ticket for
 * #966 names explicitly. The budget key below is therefore imported from the shared key family
 * rather than spelled again here.
 */
export function verifyScriptKey(projectId: string): string {
  return `verify_script_${projectId}`;
}

/**
 * The form state before any project has loaded — every field at the value an absent row implies.
 *
 * Derived from `buildProjectSettingsState` rather than written out again: the panel's own initial
 * `useState` literal was a THIRD hand-maintained copy of the field list (after this type and the
 * projection), and a field added to one and not the others is invisible to tsc when the literal
 * is complete but wrong. `setupBlocking`/`setupEnabled` default ON and `symlinkEnabled` OFF here
 * for the same reason they do in the projection — that asymmetry is the contract.
 */
export function emptyProjectSettingsState(): ProjectSettingsState {
  return buildProjectSettingsState({ id: "", defaultBranch: null, setupScript: null, setupBlocking: true, color: null }, "");
}

/**
 * Hydrate the form state from a project row plus the fetched settings blob — i.e. `buildProjectSettingsState`
 * with the per-project PREFERENCE reads folded in, so the component names neither key.
 */
export function hydrateProjectSettings(project: SettingsProjectRow, prefs: Record<string, string>, projectId: string): ProjectSettingsState {
  return buildProjectSettingsState(project, prefs[verifyScriptKey(projectId)] || "", prefs[testImpactBudgetPrefKey(projectId)] || "");
}

/**
 * The reason a settings save must be REFUSED, or null when it may proceed.
 *
 * #966 refuses rather than coerces an unparseable budget: applying no budget would leave the
 * operator believing the gate is capped when it is not, and silently defaulting one would narrow
 * the gate on a typo — worse still.
 */
export function projectSettingsSaveError(
  p: Pick<ProjectSettingsState, "defaultBranch" | "testImpactBudget">,
  branches: { local: string[]; remote: string[] } | null,
): string | null {
  if (isDefaultBranchInvalid(p.defaultBranch, branches)) return "Default branch does not exist in this repo";
  if (!isValidTestImpactBudget(p.testImpactBudget)) return 'Test-impact budget must look like "60s" or "90000ms" — a bare number is ms, and minutes are spelled in seconds (or leave it empty)';
  return null;
}

/**
 * The settings blob to PUT: the panel's settings plus the active project's per-project
 * PREFERENCES that are edited on the Project tab (the verify script, and the test-impact budget
 * since #966). Returns a copy — the caller's state object is never mutated.
 *
 * The budget is written even when empty, deliberately: an empty value is how the setting is
 * CLEARED, and omitting the key would leave a previously-set budget in place while the field the
 * operator just emptied says otherwise.
 */
export function buildSettingsToSave<S extends Record<string, unknown>>(
  settings: S,
  projectSettings: Pick<ProjectSettingsState, "verifyScript" | "testImpactBudget">,
  activeProjectId: string | null | undefined,
): S {
  const out = { ...settings };
  if (activeProjectId) {
    (out as Record<string, unknown>)[verifyScriptKey(activeProjectId)] = projectSettings.verifyScript;
    (out as Record<string, unknown>)[testImpactBudgetPrefKey(activeProjectId)] = projectSettings.testImpactBudget.trim();
  }
  return out;
}
