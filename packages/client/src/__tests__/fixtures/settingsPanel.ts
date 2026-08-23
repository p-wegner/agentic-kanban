import type { ProjectSettingsState, SettingsProjectRow } from "../../lib/settingsPanelState.js";

/**
 * Fixture builders for the settings surface (#782). See `fixtures/issue.ts` for why these
 * exist: `SettingsPanel` is the client's most-reworked file and had no test, and the reason
 * was setup cost — a project row and a project-settings state are 10 and 15 fields.
 */

/** A project row as `GET /api/projects` returns it, with every optional field present. */
export function projectRowFixture(overrides: Partial<SettingsProjectRow> = {}): SettingsProjectRow {
  return {
    id: "project-1",
    defaultBranch: "master",
    setupScript: "pnpm install -r",
    setupBlocking: true,
    color: "#4f46e5",
    setupEnabled: true,
    teardownScript: null,
    symlinkEnabled: false,
    symlinkDirs: null,
    defaultSkillId: null,
    servicesConfig: null,
    ...overrides,
  };
}

/** The panel's project-settings form state, as the Project tab edits it. */
export function projectSettingsFixture(overrides: Partial<ProjectSettingsState> = {}): ProjectSettingsState {
  return {
    defaultBranch: "master",
    setupScript: "pnpm install -r",
    setupBlocking: true,
    setupEnabled: true,
    teardownScript: "",
    verifyScript: "",
    color: null,
    symlinkEnabled: false,
    symlinkDirs: "",
    defaultSkillId: null,
    servicesEnabled: false,
    servicesComposeFile: "",
    servicesComposeRepo: "",
    servicesPorts: "",
    servicesConfigBase: null,
    ...overrides,
  };
}
