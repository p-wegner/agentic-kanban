import { describe, it, expect } from "vitest";
import { resolveProfileSelection, buildCreateIssuePayload, type CreateIssuePayloadInput } from "./createIssuePayload.js";

describe("resolveProfileSelection", () => {
  it("parses a selected token", () => {
    expect(resolveProfileSelection("claude:anth", {})).toEqual({ provider: "claude", name: "anth" });
  });
  it("returns undefined for a malformed token (no default fallback when one was selected)", () => {
    expect(resolveProfileSelection("garbage", { provider: "codex" })).toBeUndefined();
  });
  it("resolves the global default when 'Default' is selected", () => {
    expect(resolveProfileSelection("", { provider: "codex" })).toEqual({ provider: "codex", name: "default" });
    expect(resolveProfileSelection("", {})).toBeUndefined();
  });
});

function base(over: Partial<CreateIssuePayloadInput> = {}): CreateIssuePayloadInput {
  return {
    title: "  My issue  ", description: "  body  ", issueType: "task", estimate: "",
    statusId: "st1", projectId: "p1", start: false, planMode: false, skipAutoReview: false,
    isDirect: false, selectedProfile: "", selectedModel: "", skillId: "", modelApplies: false,
    settings: {}, ...over,
  };
}

describe("buildCreateIssuePayload", () => {
  it("trims title, maps empty description/estimate to undefined", () => {
    const p = buildCreateIssuePayload(base());
    expect(p.title).toBe("My issue");
    expect(p.description).toBe("body");
    expect(p.estimate).toBeUndefined();
    expect(buildCreateIssuePayload(base({ description: "   " })).description).toBeUndefined();
  });

  it("omits all launch fields when start is false", () => {
    const p = buildCreateIssuePayload(base({ start: false, planMode: true, isDirect: true, skillId: "sk", selectedProfile: "claude:anth", selectedModel: "opus", modelApplies: true }));
    expect(p.startWorkspace).toBeUndefined();
    expect(p.planMode).toBeUndefined();
    expect(p.isDirect).toBeUndefined();
    expect(p.skillId).toBeUndefined();
    expect(p.profile).toBeUndefined();
    expect(p.model).toBeUndefined();
  });

  it("includes launch fields when start is true", () => {
    const p = buildCreateIssuePayload(base({ start: true, planMode: true, skipAutoReview: true, isDirect: true, skillId: "sk", selectedProfile: "claude:anth", selectedModel: "opus", modelApplies: true }));
    expect(p.startWorkspace).toBe(true);
    expect(p.planMode).toBe(true);
    expect(p.skipAutoReview).toBe(true);
    expect(p.isDirect).toBe(true);
    expect(p.skillId).toBe("sk");
    expect(p.profile).toEqual({ provider: "claude", name: "anth" });
    expect(p.model).toBe("opus");
  });

  it("omits model when modelApplies is false even if a model is set and starting", () => {
    expect(buildCreateIssuePayload(base({ start: true, modelApplies: false, selectedModel: "opus" })).model).toBeUndefined();
  });

  it("carries through issueType/estimate/status/project", () => {
    const p = buildCreateIssuePayload(base({ issueType: "bug", estimate: "M", statusId: "st9", projectId: "p9" }));
    expect(p).toMatchObject({ issueType: "bug", estimate: "M", statusId: "st9", projectId: "p9" });
  });
});
