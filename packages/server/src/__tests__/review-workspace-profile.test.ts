import { describe, it, expect } from "vitest";
import {
  applyWorkspaceProfileToPrefs,
  getEffectiveProfile,
  parseProviderPref,
} from "../services/review.service.js";

/**
 * Regression for the "resume falls back to global" bug: a review/continuation must
 * run on the SAME provider+profile the workspace was built with (e.g. its Codex
 * OAuth license), not whatever the global `codex_profile`/`provider` happen to be
 * now (which can differ, or have auto-rotated).
 */
describe("applyWorkspaceProfileToPrefs", () => {
  // Global default: claude/anth — what the old code would have reviewed under.
  const globalPrefs = () =>
    new Map<string, string>([
      ["provider", "claude"],
      ["claude_profile", "anth"],
      ["codex_profile", "default"],
    ]);

  it("overrides provider + codex_profile from a codex workspace so the review uses its license", () => {
    const prefs = applyWorkspaceProfileToPrefs(globalPrefs(), { provider: "codex", claudeProfile: "ki15" });
    const provider = parseProviderPref(prefs);
    expect(provider).toBe("codex");
    expect(getEffectiveProfile(prefs, provider, undefined)).toBe("ki15");
  });

  it("does not mutate the input map (returns a copy)", () => {
    const original = globalPrefs();
    applyWorkspaceProfileToPrefs(original, { provider: "codex", claudeProfile: "ki15" });
    expect(original.get("provider")).toBe("claude");
    expect(original.get("codex_profile")).toBe("default");
  });

  it("honors a claude workspace's profile", () => {
    const prefs = applyWorkspaceProfileToPrefs(globalPrefs(), { provider: "claude", claudeProfile: "work" });
    const provider = parseProviderPref(prefs);
    expect(provider).toBe("claude");
    expect(getEffectiveProfile(prefs, provider, prefs.get("claude_profile"))).toBe("work");
  });

  it("honors a copilot workspace's profile", () => {
    const prefs = applyWorkspaceProfileToPrefs(globalPrefs(), { provider: "copilot", claudeProfile: "gpt5" });
    const provider = parseProviderPref(prefs);
    expect(provider).toBe("copilot");
    expect(getEffectiveProfile(prefs, provider, undefined)).toBe("gpt5");
  });

  it("sets the provider but keeps the global profile when the workspace recorded none", () => {
    const prefs = applyWorkspaceProfileToPrefs(globalPrefs(), { provider: "codex", claudeProfile: null });
    expect(parseProviderPref(prefs)).toBe("codex");
    // No per-workspace name → falls back to the global codex_profile.
    expect(getEffectiveProfile(prefs, "codex", undefined)).toBe("default");
  });

  it("leaves prefs untouched for an unknown/legacy provider value", () => {
    const prefs = applyWorkspaceProfileToPrefs(globalPrefs(), { provider: null, claudeProfile: "x" });
    expect(parseProviderPref(prefs)).toBe("claude");
    expect(prefs.get("claude_profile")).toBe("anth");
  });
});
