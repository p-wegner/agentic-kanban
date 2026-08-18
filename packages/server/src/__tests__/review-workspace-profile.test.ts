import { describe, it, expect } from "vitest";
import {
  applyWorkspaceProfileToPrefs,
  resolveWorkspaceLaunchSettings,
} from "../services/agent-settings.service.js";

/**
 * Regression for the "resume falls back to global" bug: a review/continuation must run on
 * the SAME provider+profile the workspace was built with (e.g. its Codex OAuth license),
 * not whatever the global `codex_profile`/`provider` happen to be now (which can differ,
 * or have auto-rotated).
 *
 * #541 moved these out of review.service and collapsed the five hand-rolled
 * `parseProviderPref` + `getEffectiveProfile` ladders into `resolveWorkspaceLaunchSettings`.
 * The assertions now go through that one entry point, so they cover what the launch sites
 * actually call rather than two helpers only this test still used.
 */
describe("resolveWorkspaceLaunchSettings — workspace profile pinning", () => {
  // Global default: claude/anth — what the old code would have reviewed under.
  const globalPrefs = () =>
    new Map<string, string>([
      ["provider", "claude"],
      ["claude_profile", "anth"],
      ["codex_profile", "default"],
    ]);

  it("overrides provider + codex_profile from a codex workspace so the review uses its license", () => {
    const s = resolveWorkspaceLaunchSettings(globalPrefs(), { provider: "codex", claudeProfile: "ki15" });
    expect(s.provider).toBe("codex");
    expect(s.profile).toEqual({ provider: "codex", name: "ki15" });
  });

  it("does not mutate the input map (returns a copy)", () => {
    const original = globalPrefs();
    applyWorkspaceProfileToPrefs(original, { provider: "codex", claudeProfile: "ki15" });
    expect(original.get("provider")).toBe("claude");
    expect(original.get("codex_profile")).toBe("default");
  });

  it("honors a claude workspace's profile", () => {
    const s = resolveWorkspaceLaunchSettings(globalPrefs(), { provider: "claude", claudeProfile: "work" });
    expect(s.provider).toBe("claude");
    expect(s.profile).toEqual({ provider: "claude", name: "work" });
  });

  it("honors a copilot workspace's profile", () => {
    const s = resolveWorkspaceLaunchSettings(globalPrefs(), { provider: "copilot", claudeProfile: "gpt5" });
    expect(s.provider).toBe("copilot");
    expect(s.profile).toEqual({ provider: "copilot", name: "gpt5" });
  });

  it("sets the provider but keeps the global profile when the workspace recorded none", () => {
    const s = resolveWorkspaceLaunchSettings(globalPrefs(), { provider: "codex", claudeProfile: null });
    expect(s.provider).toBe("codex");
    // No per-workspace name → falls back to the global codex_profile.
    expect(s.profile).toEqual({ provider: "codex", name: "default" });
  });

  it("leaves prefs untouched for an unknown/legacy provider value", () => {
    const prefs = applyWorkspaceProfileToPrefs(globalPrefs(), { provider: null, claudeProfile: "x" });
    expect(prefs.get("provider")).toBe("claude");
    expect(prefs.get("claude_profile")).toBe("anth");
  });

  it("applies the mock command's profile/delay flags, which two ladders used to drop", () => {
    // #541 behaviour change, stated so it is not mistaken for a regression: the hand-rolled
    // copies used the bare MOCK_AGENT_COMMAND, so `mock_agent_profile`/`mock_agent_delay_ms`
    // reached builders but never learning/verify sessions.
    const prefs = globalPrefs();
    prefs.set("claude_profile", "mock");
    prefs.set("mock_agent_profile", "todo-progress");
    const s = resolveWorkspaceLaunchSettings(prefs, { provider: "claude", claudeProfile: "mock" });
    expect(s.agentCommand).toContain("--profile todo-progress");
    expect(s.profile).toBeUndefined();
  });

  it("applies claude-only skip-permissions, which the learning ladders used to drop", () => {
    const prefs = globalPrefs();
    prefs.set("skip_permissions", "true");
    const claude = resolveWorkspaceLaunchSettings(prefs, { provider: "claude", claudeProfile: "work" });
    expect(claude.agentArgs).toContain("--dangerously-skip-permissions");
    const codex = resolveWorkspaceLaunchSettings(prefs, { provider: "codex", claudeProfile: "ki15" });
    expect(codex.agentArgs ?? "").not.toContain("--dangerously-skip-permissions");
  });
});
