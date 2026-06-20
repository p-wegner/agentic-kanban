import { describe, expect, it } from "vitest";
import {
  uniqueProfiles,
  settingsProfileValue,
  profileOptionLabel,
  defaultHarnessLabel,
  providerDisplayName,
  getProviderCapabilities,
  statusClasses,
  formatHealthTime,
  DEFAULT_SETTINGS,
  type Settings,
} from "./settings-shared.js";

describe("uniqueProfiles", () => {
  it("dedupes, drops falsy, and prepends the fallback", () => {
    expect(uniqueProfiles(["a", "a", "", "b"])).toEqual(["a", "b"]);
    expect(uniqueProfiles(["a", "b"], "a")).toEqual(["a", "b"]);
    expect(uniqueProfiles(["b"], "a")).toEqual(["a", "b"]);
  });
});

describe("settingsProfileValue", () => {
  it("builds provider:profile, applying per-provider defaults", () => {
    expect(settingsProfileValue({ ...DEFAULT_SETTINGS, provider: "claude", claude_profile: "anth" })).toBe("claude:anth");
    expect(settingsProfileValue({ ...DEFAULT_SETTINGS, provider: "codex", codex_profile: "" })).toBe("codex:default");
    expect(settingsProfileValue({ ...DEFAULT_SETTINGS, provider: "copilot", copilot_profile: "" })).toBe("copilot:default");
    expect(settingsProfileValue({ provider: "pi" } as Settings)).toBe("pi:default");
  });
});

describe("profileOptionLabel / providerDisplayName / defaultHarnessLabel", () => {
  it("labels default profiles as Default and names providers", () => {
    expect(providerDisplayName("codex")).toBe("Codex");
    expect(providerDisplayName("claude")).toBe("Claude");
    expect(profileOptionLabel("codex", "default")).toBe("Codex: Default");
    expect(profileOptionLabel("claude", "anth")).toBe("Claude: anth");
    expect(defaultHarnessLabel({ ...DEFAULT_SETTINGS, provider: "pi" })).toBe("Pi");
  });
});

describe("getProviderCapabilities", () => {
  it("enables permission prompts for claude only when the flag is present", () => {
    expect(getProviderCapabilities("claude", "", []).permissionPrompts).toBe(false);
    expect(getProviderCapabilities("claude", "", ["--permission-prompt-tool x"]).permissionPrompts).toBe(true);
    expect(getProviderCapabilities("codex", "", []).permissionPrompts).toBe(false);
  });

  it("the mock claude profile keeps full capabilities except permission prompts", () => {
    const caps = getProviderCapabilities("claude", "mock", []);
    expect(caps).toEqual({ planMode: true, resume: true, mcpTools: true, visualVerify: true, permissionPrompts: false });
  });
});

describe("statusClasses / formatHealthTime", () => {
  it("maps status to color classes", () => {
    expect(statusClasses("error")).toContain("red");
    expect(statusClasses("warning")).toContain("amber");
    expect(statusClasses("ok")).toContain("green");
    expect(statusClasses("unknown")).toContain("gray");
  });

  it("returns the raw value for an unparseable date", () => {
    expect(formatHealthTime("not-a-date")).toBe("not-a-date");
  });
});
