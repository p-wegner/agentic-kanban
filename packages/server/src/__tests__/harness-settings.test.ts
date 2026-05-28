import { describe, it, expect } from "vitest";
import {
  allHarnessSettingKeys,
  getHarnessBoolSetting,
  harnessSettingKey,
} from "../services/harness-settings.js";

describe("harness-settings", () => {
  it("scoped key takes precedence over legacy and default", () => {
    const prefs = new Map<string, string>([
      [harnessSettingKey("codex", "plan_auto_continue"), "false"],
      ["plan_auto_continue", "true"],
    ]);
    expect(getHarnessBoolSetting(prefs, "codex", "plan_auto_continue")).toBe(false);
  });

  it("legacy key is consulted when scoped key is absent", () => {
    const prefs = new Map<string, string>([["plan_auto_continue", "false"]]);
    expect(getHarnessBoolSetting(prefs, "codex", "plan_auto_continue")).toBe(false);
    expect(getHarnessBoolSetting(prefs, "copilot", "plan_auto_continue")).toBe(false);
  });

  it("falls back to harness default when no preference is set", () => {
    const prefs = new Map<string, string>();
    expect(getHarnessBoolSetting(prefs, "codex", "plan_auto_continue")).toBe(true);
    expect(getHarnessBoolSetting(prefs, "copilot", "plan_auto_continue")).toBe(true);
  });

  it("accepts plain object preference maps", () => {
    const prefs = { [harnessSettingKey("copilot", "plan_auto_continue")]: "false" };
    expect(getHarnessBoolSetting(prefs, "copilot", "plan_auto_continue")).toBe(false);
  });

  it("ignores empty-string scoped values and falls through to legacy/default", () => {
    const prefs = new Map<string, string>([
      [harnessSettingKey("codex", "plan_auto_continue"), ""],
      ["plan_auto_continue", "false"],
    ]);
    expect(getHarnessBoolSetting(prefs, "codex", "plan_auto_continue")).toBe(false);
  });

  it("allHarnessSettingKeys enumerates every (harness, setting) pair", () => {
    const keys = allHarnessSettingKeys();
    expect(keys).toContain("harness.claude.plan_auto_continue");
    expect(keys).toContain("harness.codex.plan_auto_continue");
    expect(keys).toContain("harness.copilot.plan_auto_continue");
  });
});
