import { describe, it, expect } from "vitest";
import { resolveDefaultProfile, parseProfileSelection, buildCreateWorkspaceBody, type CreateWorkspaceBodyInput } from "./createWorkspaceBody.js";

describe("resolveDefaultProfile", () => {
  it("resolves codex/copilot/pi with their profile prefs (default fallback)", () => {
    expect(resolveDefaultProfile({ provider: "codex", codex_profile: "azure" })).toEqual({ provider: "codex", name: "azure" });
    expect(resolveDefaultProfile({ provider: "codex" })).toEqual({ provider: "codex", name: "default" });
    expect(resolveDefaultProfile({ provider: "copilot" })).toEqual({ provider: "copilot", name: "default" });
    expect(resolveDefaultProfile({ provider: "pi" })).toEqual({ provider: "pi", name: "default" });
  });
  it("resolves claude when a claude_profile is set, else undefined", () => {
    expect(resolveDefaultProfile({ claude_profile: "anth" })).toEqual({ provider: "claude", name: "anth" });
    expect(resolveDefaultProfile({})).toBeUndefined();
  });
});

describe("parseProfileSelection", () => {
  it("parses a valid provider:name token", () => {
    expect(parseProfileSelection("claude:anth")).toEqual({ provider: "claude", name: "anth" });
    expect(parseProfileSelection("codex:azure:extra")).toEqual({ provider: "codex", name: "azure:extra" });
  });
  it("returns null for missing colon, unknown provider, or empty name", () => {
    expect(parseProfileSelection("claude")).toBeNull();
    expect(parseProfileSelection("bogus:x")).toBeNull();
    expect(parseProfileSelection("claude:")).toBeNull();
  });
});

function base(over: Partial<CreateWorkspaceBodyInput> = {}): CreateWorkspaceBodyInput {
  return {
    issueId: "i1", isDirect: false, requiresReview: true, planMode: false, tddMode: false,
    includeVisualProof: false, skipSetup: false, skipContextPacker: false,
    selectedSkillId: "", selectedProfile: "", selectedModel: "", modelApplies: false,
    branchName: "feature/x", baseBranch: "", prefs: {}, ...over,
  };
}

describe("buildCreateWorkspaceBody", () => {
  it("includes the base flags and trimmed branch for a worktree workspace", () => {
    const body = buildCreateWorkspaceBody(base({ branchName: "  feature/y  " }));
    expect(body).toMatchObject({ issueId: "i1", isDirect: false, requiresReview: true, branch: "feature/y" });
    expect(body.baseBranch).toBeUndefined();
  });

  it("adds baseBranch only when non-empty, and omits branch for direct workspaces", () => {
    expect(buildCreateWorkspaceBody(base({ baseBranch: " main " })).baseBranch).toBe("main");
    const direct = buildCreateWorkspaceBody(base({ isDirect: true }));
    expect(direct.branch).toBeUndefined();
  });

  it("uses the parsed profile token when selected", () => {
    expect(buildCreateWorkspaceBody(base({ selectedProfile: "claude:anth" })).profile).toEqual({ provider: "claude", name: "anth" });
  });

  it("falls back to the resolved default profile when 'Default' is selected", () => {
    expect(buildCreateWorkspaceBody(base({ selectedProfile: "", prefs: { provider: "codex" } })).profile).toEqual({ provider: "codex", name: "default" });
  });

  it("omits profile entirely when a selected token is malformed (no default fallback)", () => {
    expect(buildCreateWorkspaceBody(base({ selectedProfile: "garbage", prefs: { provider: "codex" } })).profile).toBeUndefined();
  });

  it("includes model only when modelApplies and a model is set", () => {
    expect(buildCreateWorkspaceBody(base({ modelApplies: true, selectedModel: "opus" })).model).toBe("opus");
    expect(buildCreateWorkspaceBody(base({ modelApplies: false, selectedModel: "opus" })).model).toBeUndefined();
  });

  it("includes skillId only when set", () => {
    expect(buildCreateWorkspaceBody(base({ selectedSkillId: "sk1" })).skillId).toBe("sk1");
    expect(buildCreateWorkspaceBody(base()).skillId).toBeUndefined();
  });
});
