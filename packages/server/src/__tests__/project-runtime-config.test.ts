import { describe, expect, it } from "vitest";
import { harnessSettingKey } from "../services/harness-settings.js";
import {
  autoMergeDisabledPrefKey,
  autodrivePrefKey,
  buildDriveRuntimePreferencePatch,
  resolveProjectRuntimeConfig,
  resolveProviderDivergence,
} from "../services/project-runtime-config.service.js";
import { startModePrefKey } from "../services/start-policy.service.js";

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";

function prefs(entries: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("resolveProjectRuntimeConfig", () => {
  it("resolves provider, model, start policy, and drive semantics in one typed snapshot", () => {
    const runtime = resolveProjectRuntimeConfig({
      projectId: PROJECT_ID,
      prefMap: prefs({
        provider: "claude",
        claude_profile: "anth",
        default_model_claude: "sonnet",
        [startModePrefKey(PROJECT_ID)]: "monitor",
        [autodrivePrefKey(PROJECT_ID)]: "true",
        [autoMergeDisabledPrefKey(PROJECT_ID)]: "false",
        auto_review: "true",
        auto_merge: "true",
        [harnessSettingKey("claude", "plan_auto_continue")]: "true",
        [harnessSettingKey("codex", "plan_auto_continue")]: "true",
        [harnessSettingKey("copilot", "plan_auto_continue")]: "true",
        [harnessSettingKey("pi", "plan_auto_continue")]: "true",
      }),
    });

    expect(runtime.provider.provider).toBe("claude");
    expect(runtime.provider.profileName).toBe("anth");
    expect(runtime.provider.model).toBe("sonnet");
    expect(runtime.provider.source).toBe("settings");
    expect(runtime.startPolicy.mode).toBe("monitor");
    expect(runtime.drive).toMatchObject({
      enabled: true,
      autoMergeDisabled: false,
      autoReview: true,
      autoMerge: true,
      planAutoContinue: true,
    });
  });

  it("uses strategy before workspace fallback, and workspace fallback before settings", () => {
    const strategy = resolveProjectRuntimeConfig({
      projectId: PROJECT_ID,
      prefMap: prefs({ provider: "claude", claude_profile: "settings" }),
      strategySelection: { provider: "codex", profileName: "ki14", model: "gpt-5.5" },
      workspaceSelection: { provider: "claude", profileName: "baked" },
    });
    expect(strategy.provider.source).toBe("strategy");
    expect(strategy.provider.provider).toBe("codex");
    expect(strategy.provider.profileName).toBe("ki14");
    expect(strategy.provider.model).toBe("gpt-5.5");

    const workspace = resolveProjectRuntimeConfig({
      projectId: PROJECT_ID,
      prefMap: prefs({ provider: "claude", claude_profile: "settings" }),
      workspaceSelection: { provider: "codex", profileName: "baked" },
    });
    expect(workspace.provider.source).toBe("workspace");
    expect(workspace.provider.provider).toBe("codex");
    expect(workspace.provider.profileName).toBe("baked");
  });
});

describe("buildDriveRuntimePreferencePatch", () => {
  it("writes the complete coherent Drive-on patch", () => {
    expect(buildDriveRuntimePreferencePatch(PROJECT_ID, true)).toEqual([
      { key: autodrivePrefKey(PROJECT_ID), value: "true" },
      { key: autoMergeDisabledPrefKey(PROJECT_ID), value: "false" },
      { key: startModePrefKey(PROJECT_ID), value: "monitor" },
      { key: "auto_review", value: "true" },
      { key: "auto_merge", value: "true" },
      { key: harnessSettingKey("claude", "plan_auto_continue"), value: "true" },
      { key: harnessSettingKey("codex", "plan_auto_continue"), value: "true" },
      { key: harnessSettingKey("copilot", "plan_auto_continue"), value: "true" },
      { key: harnessSettingKey("pi", "plan_auto_continue"), value: "true" },
    ]);
  });

  it("writes only project-scoped kill-switch prefs when disabling Drive", () => {
    expect(buildDriveRuntimePreferencePatch(PROJECT_ID, false)).toEqual([
      { key: autodrivePrefKey(PROJECT_ID), value: "false" },
      { key: autoMergeDisabledPrefKey(PROJECT_ID), value: "true" },
      { key: startModePrefKey(PROJECT_ID), value: "manual" },
    ]);
  });
});

describe("resolveProviderDivergence", () => {
  it("reports Bullseye/settings drift from the same runtime resolver module", () => {
    const bullseye = JSON.stringify({
      providerPolicies: [
        { id: "p1", provider: "claude", profileName: "anth", label: "Claude", mode: "fill", headroomPct: 0 },
      ],
    });
    const result = resolveProviderDivergence(
      prefs({
        [`board_strategy_${PROJECT_ID}`]: bullseye,
        provider: "codex",
        codex_profile: "default",
      }),
      PROJECT_ID,
    );

    expect(result).toMatchObject({
      hasBullseye: true,
      bullseyeProvider: "claude",
      bullseyeProfile: "anth",
      settingsProvider: "codex",
      settingsProfile: "default",
      diverged: true,
    });
  });
});
