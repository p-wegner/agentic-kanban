import { describe, expect, it } from "vitest";
import { buildLearningStepPrompt, resolveCanonicalLearningStepSkillPath } from "../services/merge-helpers.service.js";

describe("learning-step prompt", () => {
  it("includes the canonical skill fallback path", () => {
    const prompt = buildLearningStepPrompt(true);

    expect(prompt).toContain("/learning-step");
    expect(prompt).toContain("before this workspace is merged");
    expect(prompt).toContain(resolveCanonicalLearningStepSkillPath());
    expect(prompt).toContain("If this project does not expose a local learning-step slash command or skill");
  });
});
