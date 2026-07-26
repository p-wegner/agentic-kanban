import { describe, it, expect } from "vitest";
import { encodeTranscriptCwd } from "../src/lib/transcript-cwd-encoding.js";

describe("encodeTranscriptCwd", () => {
  it("replaces :, \\ and / with -", () => {
    expect(encodeTranscriptCwd("C:\\projects\\app")).toBe("C--projects-app");
    expect(encodeTranscriptCwd("/workspaces/app")).toBe("-workspaces-app");
  });

  it("replaces dots, matching a real dotted worktree path observed on disk (#159)", () => {
    // Real transcript dir seen under ~/.claude/projects for this exact repo path:
    // C:\projects\andrena\.worktrees\ak-158-landing -> C--projects-andrena--worktrees-ak-158-landing
    expect(encodeTranscriptCwd("C:\\projects\\andrena\\.worktrees\\ak-158-landing")).toBe(
      "C--projects-andrena--worktrees-ak-158-landing"
    );
  });

  it("replaces underscores too, matching a real observed branch-named worktree dir", () => {
    // Real transcript dir suffix observed: feature_ak-100-... -> feature-ak-100-...
    expect(encodeTranscriptCwd("feature_ak-100-diagnostics")).toBe("feature-ak-100-diagnostics");
  });

  it("leaves alphanumerics and existing dashes untouched", () => {
    expect(encodeTranscriptCwd("abc-123-XYZ")).toBe("abc-123-XYZ");
  });
});
