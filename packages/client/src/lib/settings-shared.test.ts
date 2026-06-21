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
  applyPreflightResult,
  DEFAULT_SETTINGS,
  type Settings,
  type AgentProfileHealth,
} from "./settings-shared.js";

describe("applyPreflightResult", () => {
  const row = (over: Partial<AgentProfileHealth>): AgentProfileHealth => ({
    id: "p1",
    provider: "claude",
    profileName: "anth",
    command: "old-cmd",
    selected: false,
    status: "unknown",
    preflight: { ok: false, status: "unknown", errors: [], warnings: [], command: "", provider: "claude", profileName: "anth", flags: [] },
    latestFailure: null,
    ...over,
  } as AgentProfileHealth);
  const result: AgentProfileHealth["preflight"] = { ok: true, status: "ok", errors: [], warnings: [], command: "new-cmd", provider: "claude", profileName: "anth", flags: [] };

  it("updates only the matching row, taking the preflight status + command", () => {
    const rows = [row({ id: "p1" }), row({ id: "p2" })];
    const out = applyPreflightResult(rows, "p1", result);
    expect(out[0]).toMatchObject({ status: "ok", command: "new-cmd", preflight: result });
    expect(out[1]).toBe(rows[1]); // untouched
  });

  it("keeps a row with a recorded latestFailure at 'error' even when preflight passes", () => {
    const rows = [row({ id: "p1", latestFailure: { at: "t", summary: "boom" } })];
    expect(applyPreflightResult(rows, "p1", result)[0].status).toBe("error");
  });
});

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
