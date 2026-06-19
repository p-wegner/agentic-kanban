import { describe, it, expect } from "vitest";
import { buildQuickLaunchBody } from "./workspace-launch.js";

const base = {
  issueId: "issue-1",
  requiresReview: true,
  planMode: false,
  branch: "feature/x",
  selectedProfile: "Default",
  prefs: {} as Record<string, string>,
  includeModel: false,
  model: "",
};

describe("buildQuickLaunchBody", () => {
  it("builds the core body with the standard flags", () => {
    expect(buildQuickLaunchBody(base)).toEqual({
      issueId: "issue-1",
      isDirect: false,
      requiresReview: true,
      planMode: false,
      branch: "feature/x",
    });
  });

  it("uses an explicit profile selection over the prefs default", () => {
    const body = buildQuickLaunchBody({
      ...base,
      selectedProfile: "claude:anth",
      prefs: { provider: "codex", codex_profile: "default" },
    });
    expect(body.profile).toEqual({ provider: "claude", name: "anth" });
  });

  it("resolves the global default when 'Default' is selected", () => {
    const body = buildQuickLaunchBody({ ...base, prefs: { provider: "codex", codex_profile: "spark" } });
    expect(body.profile).toEqual({ provider: "codex", name: "spark" });
  });

  it("omits profile when 'Default' resolves to plain Claude (no profile)", () => {
    expect(buildQuickLaunchBody(base).profile).toBeUndefined();
  });

  it("includes model only when includeModel is set and model is non-empty", () => {
    expect(buildQuickLaunchBody({ ...base, includeModel: true, model: "opus" }).model).toBe("opus");
    expect(buildQuickLaunchBody({ ...base, includeModel: false, model: "opus" }).model).toBeUndefined();
    expect(buildQuickLaunchBody({ ...base, includeModel: true, model: "" }).model).toBeUndefined();
  });

  it("adds skillId for a skill quick-launch", () => {
    const body = buildQuickLaunchBody({ ...base, skillId: "code-review", planMode: false });
    expect(body.skillId).toBe("code-review");
  });

  it("passes planMode through", () => {
    expect(buildQuickLaunchBody({ ...base, planMode: true }).planMode).toBe(true);
  });
});
