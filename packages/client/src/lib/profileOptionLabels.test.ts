import { describe, it, expect } from "vitest";
import {
  uniqueProfiles,
  defaultProfileLabel,
  profileOptionLabel,
  providerFromSelection,
} from "./profileOptionLabels.js";

describe("uniqueProfiles", () => {
  it("dedupes and drops falsy entries", () => {
    expect(uniqueProfiles(["a", "a", "", "b"])).toEqual(["a", "b"]);
  });
  it("prepends the fallback first when given", () => {
    expect(uniqueProfiles(["b", "a"], "default")).toEqual(["default", "b", "a"]);
    expect(uniqueProfiles(["default", "b"], "default")).toEqual(["default", "b"]);
  });
});

describe("defaultProfileLabel", () => {
  it("reflects the settings provider + its profile pref", () => {
    expect(defaultProfileLabel({ provider: "codex", codex_profile: "work" })).toBe("codex:work");
    expect(defaultProfileLabel({ provider: "copilot" })).toBe("copilot:default");
    expect(defaultProfileLabel({ provider: "pi", pi_profile: "p2" })).toBe("pi:p2");
    expect(defaultProfileLabel({ provider: "claude", claude_profile: "anth" })).toBe("claude:anth");
    expect(defaultProfileLabel({})).toBe("claude:none");
  });
});

describe("profileOptionLabel", () => {
  it("renders the literal 'default' as 'Default' for codex/copilot/pi", () => {
    expect(profileOptionLabel("codex", "default")).toBe("Codex: Default");
    expect(profileOptionLabel("copilot", "default")).toBe("Copilot: Default");
    expect(profileOptionLabel("pi", "default")).toBe("Pi: Default");
  });
  it("uses the raw name for named profiles", () => {
    expect(profileOptionLabel("codex", "work")).toBe("Codex: work");
    expect(profileOptionLabel("claude", "anth")).toBe("Claude: anth");
  });
});

describe("providerFromSelection", () => {
  it("empty token falls back to the settings provider", () => {
    expect(providerFromSelection("", "claude")).toEqual({ isClaudeSelected: true, isCodexSelected: false });
    expect(providerFromSelection("", "codex")).toEqual({ isClaudeSelected: false, isCodexSelected: true });
    expect(providerFromSelection("", "copilot")).toEqual({ isClaudeSelected: false, isCodexSelected: false });
    expect(providerFromSelection("", undefined)).toEqual({ isClaudeSelected: true, isCodexSelected: false });
  });
  it("a token decides by its prefix", () => {
    expect(providerFromSelection("claude:anth", "codex")).toEqual({ isClaudeSelected: true, isCodexSelected: false });
    expect(providerFromSelection("codex:work", "claude")).toEqual({ isClaudeSelected: false, isCodexSelected: true });
    expect(providerFromSelection("copilot:x", "claude")).toEqual({ isClaudeSelected: false, isCodexSelected: false });
  });
});
