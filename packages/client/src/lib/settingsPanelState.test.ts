import { describe, expect, it } from "vitest";
import {
  buildProjectPatchBody,
  buildProjectSettingsState,
  buildSettingsToSave,
  hydrateProjectSettings,
  isDefaultBranchInvalid,
  projectSettingsSaveError,
  verifyScriptKey,
} from "./settingsPanelState.js";
import { projectRowFixture, projectSettingsFixture } from "../__tests__/fixtures/settingsPanel.js";

/**
 * The first tests `SettingsPanel` has ever had (#782). It is the most-reworked file in the
 * client — 113 commits, 34 of them fixes, in the last 90 days by
 * `git log --since --no-merges --full-history` — and the four rules below are what those fixes
 * kept landing in. Each case names the mutation it was confirmed to catch.
 */

describe("buildProjectSettingsState", () => {
  it("defaults setupBlocking and setupEnabled ON when the server omits them", () => {
    // Mutation: `project.setupBlocking === true` — a row from a server that does not send the
    // field would silently turn a project's blocking setup script non-blocking on next save.
    const state = buildProjectSettingsState(
      projectRowFixture({ setupBlocking: undefined as unknown as boolean, setupEnabled: undefined }),
      "",
    );
    expect(state.setupBlocking).toBe(true);
    expect(state.setupEnabled).toBe(true);
  });

  it("honours an explicit false for setupBlocking and setupEnabled", () => {
    const state = buildProjectSettingsState(projectRowFixture({ setupBlocking: false, setupEnabled: false }), "");
    expect(state.setupBlocking).toBe(false);
    expect(state.setupEnabled).toBe(false);
  });

  it("defaults symlinkEnabled OFF — the opposite direction from the setup flags", () => {
    // Mutation: `project.symlinkEnabled !== false` — an omitted field would turn Dependency
    // Symlinks ON for every project, which is the fragile Windows-junction path (#810).
    expect(buildProjectSettingsState(projectRowFixture({ symlinkEnabled: undefined }), "").symlinkEnabled).toBe(false);
    expect(buildProjectSettingsState(projectRowFixture({ symlinkEnabled: true }), "").symlinkEnabled).toBe(true);
  });

  it("turns nullable text columns into empty strings for the controlled inputs", () => {
    // Mutation: drop a `|| ""` — React logs an uncontrolled-input warning and the field
    // becomes uneditable-then-editable on first keystroke.
    const state = buildProjectSettingsState(
      projectRowFixture({ defaultBranch: null, setupScript: null, teardownScript: null, symlinkDirs: null }),
      "",
    );
    expect(state.defaultBranch).toBe("");
    expect(state.setupScript).toBe("");
    expect(state.teardownScript).toBe("");
    expect(state.symlinkDirs).toBe("");
  });

  it("keeps color and defaultSkillId nullable rather than empty-stringing them", () => {
    const state = buildProjectSettingsState(projectRowFixture({ color: null, defaultSkillId: null }), "");
    expect(state.color).toBeNull();
    expect(state.defaultSkillId).toBeNull();
  });

  it("takes the verify script from the preference, not from the project row", () => {
    // Mutation: `verifyScript: ""` — the Project tab would show an empty verify script and
    // a save would then WIPE the project's real one.
    expect(buildProjectSettingsState(projectRowFixture(), "pnpm test:mine").verifyScript).toBe("pnpm test:mine");
  });

  it("flattens the services config into form fields and keeps the full config as the base", () => {
    const svc = { enabled: true, composeFile: "docker-compose.yml", ports: ["web", "api"], readyTimeoutMs: 60_000 };
    const state = buildProjectSettingsState(projectRowFixture({ servicesConfig: svc }), "");
    expect(state.servicesEnabled).toBe(true);
    expect(state.servicesComposeFile).toBe("docker-compose.yml");
    expect(state.servicesPorts).toBe("web, api");
    // Mutation: `servicesConfigBase: null` — API-only fields like readyTimeoutMs would be
    // dropped on every settings save, since buildServicesConfig merges over this.
    expect(state.servicesConfigBase).toBe(svc);
  });

  it("survives a project with no services config at all", () => {
    const state = buildProjectSettingsState(projectRowFixture({ servicesConfig: null }), "");
    expect(state.servicesEnabled).toBe(false);
    expect(state.servicesPorts).toBe("");
    expect(state.servicesConfigBase).toBeNull();
  });
});

describe("buildProjectPatchBody", () => {
  it("normalises emptied text fields to null so the column is cleared", () => {
    // Mutation: drop a `|| null` — the server stores "" and then treats the project as
    // HAVING a setup/teardown script, running an empty command on every workspace creation.
    const body = buildProjectPatchBody(projectSettingsFixture({
      setupScript: "", teardownScript: "", symlinkDirs: "   ", defaultBranch: "  ", color: "", defaultSkillId: "",
    }));
    expect(body.setupScript).toBeNull();
    expect(body.teardownScript).toBeNull();
    expect(body.symlinkDirs).toBeNull();
    expect(body.defaultBranch).toBeNull();
    expect(body.color).toBeNull();
    expect(body.defaultSkillId).toBeNull();
  });

  it("trims the default branch and the symlink dirs it sends", () => {
    // Mutation: drop `.trim()` on defaultBranch — " main" is stored, and every later
    // `isDefaultBranchInvalid` check on the untrimmed value disagrees with the repo.
    const body = buildProjectPatchBody(projectSettingsFixture({ defaultBranch: "  main  ", symlinkDirs: "  node_modules  " }));
    expect(body.defaultBranch).toBe("main");
    expect(body.symlinkDirs).toBe("node_modules");
  });

  it("sends the booleans as booleans, false included", () => {
    // Mutation: `setupBlocking: p.setupBlocking || undefined` — unticking the box would
    // never reach the server.
    const body = buildProjectPatchBody(projectSettingsFixture({ setupBlocking: false, setupEnabled: false, symlinkEnabled: false }));
    expect(body.setupBlocking).toBe(false);
    expect(body.setupEnabled).toBe(false);
    expect(body.symlinkEnabled).toBe(false);
  });

  it("builds the services config from the form fields", () => {
    const body = buildProjectPatchBody(projectSettingsFixture({
      servicesEnabled: true, servicesComposeFile: "compose.yml", servicesPorts: "web, api",
    }));
    expect(body.servicesConfig).toEqual({ enabled: true, composeFile: "compose.yml", ports: ["web", "api"] });
  });

  it("does NOT send the verify script — that is a preference, not a project column", () => {
    // Mutation: add `verifyScript: p.verifyScript` — the PATCH would carry an unknown field
    // and the preference write would no longer be the single place it is stored.
    expect(buildProjectPatchBody(projectSettingsFixture({ verifyScript: "pnpm test" })))
      .not.toHaveProperty("verifyScript");
  });
});

describe("isDefaultBranchInvalid", () => {
  it("is false while the branch list is still unknown", () => {
    // Mutation: `if (!value) return false;` alone (dropping the `!branches` arm) — Save would
    // be disabled for every project during first paint, because branches load deferred.
    expect(isDefaultBranchInvalid("main", null)).toBe(false);
  });

  it("is false for an empty or whitespace-only branch — that clears the column", () => {
    expect(isDefaultBranchInvalid("", { local: ["main"], remote: [] })).toBe(false);
    expect(isDefaultBranchInvalid("   ", { local: ["main"], remote: [] })).toBe(false);
  });

  it("is false for a branch that exists locally, ignoring surrounding whitespace", () => {
    // Mutation: drop the `.trim()` — a pasted branch name with a trailing space would
    // permanently disable Save with no visible reason.
    expect(isDefaultBranchInvalid("main", { local: ["main", "dev"], remote: [] })).toBe(false);
    expect(isDefaultBranchInvalid("  main  ", { local: ["main"], remote: [] })).toBe(false);
  });

  it("is true for a branch that exists only on the remote", () => {
    // Mutation: check `branches.remote` too — a remote-only branch is not checkoutable as
    // the worktree base, which is why the rule looks at `local` alone.
    expect(isDefaultBranchInvalid("feature/x", { local: ["main"], remote: ["feature/x"] })).toBe(true);
  });

  it("is true for a branch that exists nowhere", () => {
    expect(isDefaultBranchInvalid("typo", { local: ["main"], remote: [] })).toBe(true);
  });
});

describe("verifyScriptKey", () => {
  it("is the literal `verify_script_<projectId>` the server reads", () => {
    // Pinned as a LITERAL, not via the function under test. The server's own
    // `verifyScriptPrefKey` lives in packages/server and the client cannot import it, so this
    // string is a hand-copied wire contract — and `verify_script_<id>` is named in
    // profile-allowlist.ts and project-runtime-config.service.ts as the family that already
    // drifted once by exactly this route. Mutation: rename the key — this is the only
    // assertion that catches it; every other test that used the helper stayed green.
    expect(verifyScriptKey("proj-1")).toBe("verify_script_proj-1");
  });
});

describe("hydrateProjectSettings", () => {
  it("reads BOTH per-project preference keys off the settings blob (#966)", () => {
    // The component no longer names either key, so this is where the two reads are pinned.
    // Mutation: read the budget under `verifyScriptKey` — the field would mirror the verify
    // script and a save would then write the script into the budget.
    const state = hydrateProjectSettings(
      projectRowFixture(),
      { "verify_script_proj-1": "pnpm test:mine", "test_impact_budget_proj-1": "60s" },
      "proj-1",
    );
    expect(state.verifyScript).toBe("pnpm test:mine");
    expect(state.testImpactBudget).toBe("60s");
  });

  it("defaults both to empty when the blob carries neither", () => {
    const state = hydrateProjectSettings(projectRowFixture(), {}, "proj-1");
    expect(state.verifyScript).toBe("");
    expect(state.testImpactBudget).toBe("");
  });
});

describe("projectSettingsSaveError", () => {
  const branches = { local: ["main"], remote: [] };

  it("is null when both the branch and the budget are acceptable", () => {
    expect(projectSettingsSaveError({ defaultBranch: "main", testImpactBudget: "60s" }, branches)).toBeNull();
    expect(projectSettingsSaveError({ defaultBranch: "", testImpactBudget: "" }, branches)).toBeNull();
  });

  it("refuses an unparseable budget rather than coercing it (#966)", () => {
    // Mutation: return null here — the save would apply NO budget while the operator believes
    // the gate is capped, which is the exact failure the refusal exists to prevent.
    expect(projectSettingsSaveError({ defaultBranch: "main", testImpactBudget: "soon" }, branches))
      .toMatch(/Test-impact budget/);
  });

  it("still reports an unknown default branch, and reports it FIRST", () => {
    expect(projectSettingsSaveError({ defaultBranch: "typo", testImpactBudget: "60s" }, branches))
      .toMatch(/Default branch/);
    expect(projectSettingsSaveError({ defaultBranch: "typo", testImpactBudget: "soon" }, branches))
      .toMatch(/Default branch/);
  });
});

describe("buildSettingsToSave", () => {
  const projectPrefs = (overrides: Partial<{ verifyScript: string; testImpactBudget: string }> = {}) => ({
    verifyScript: "pnpm test",
    testImpactBudget: "",
    ...overrides,
  });

  it("adds the active project's verify script under its per-project key", () => {
    const out = buildSettingsToSave<Record<string, unknown>>({ theme: "dark" }, projectPrefs({ verifyScript: "pnpm test:mine" }), "proj-1");
    expect(out["verify_script_proj-1"]).toBe("pnpm test:mine");
    expect(out.theme).toBe("dark");
  });

  it("stores an emptied verify script rather than skipping it", () => {
    // Mutation: `if (activeProjectId && projectSettings.verifyScript)` — clearing the verify
    // script in the UI would silently leave the old one in place.
    expect(buildSettingsToSave<Record<string, unknown>>({}, projectPrefs({ verifyScript: "" }), "proj-1")["verify_script_proj-1"]).toBe("");
  });

  it("adds the test-impact budget under the SHARED key family (#966)", () => {
    // The key comes from `testImpactBudgetPrefKey`, not a second hand-written string — which is
    // exactly the drift `verify_script_<id>` above documents.
    const out = buildSettingsToSave<Record<string, unknown>>({}, projectPrefs({ testImpactBudget: " 60s " }), "proj-1");
    expect(out["test_impact_budget_proj-1"]).toBe("60s");
  });

  it("writes an EMPTY budget rather than omitting it — that is how the setting is cleared", () => {
    // Omitting the key would leave a previously-set budget in place while the field the operator
    // just emptied says otherwise, i.e. a gate still narrowed by a budget nobody can see.
    const out = buildSettingsToSave<Record<string, unknown>>({}, projectPrefs({ testImpactBudget: "" }), "proj-1");
    expect(out["test_impact_budget_proj-1"]).toBe("");
  });

  it("writes no per-project key when there is no active project", () => {
    expect(buildSettingsToSave({ theme: "dark" }, projectPrefs(), null)).toEqual({ theme: "dark" });
    expect(buildSettingsToSave({ theme: "dark" }, projectPrefs(), undefined)).toEqual({ theme: "dark" });
  });

  it("does not mutate the settings object it was given", () => {
    // Mutation: assign into `settings` instead of a copy — React state would be mutated in
    // place, so the re-render after a failed save would show the unsaved value as saved.
    const settings: Record<string, string> = { theme: "dark" };
    buildSettingsToSave(settings, projectPrefs(), "proj-1");
    expect(settings).toEqual({ theme: "dark" });
  });
});
