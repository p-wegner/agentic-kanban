import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS } from "../builtin-skills.js";

describe("spec phase constitution gate", () => {
  it("requires every spec phase skill to load and cite the project constitution", () => {
    for (const name of ["spec-requirements", "spec-design", "spec-tasks"]) {
      const skill = BUILTIN_SKILLS.find((item) => item.name === name);
      expect(skill, name).toBeDefined();
      expect(skill!.prompt).toContain("Read the repo-root `CLAUDE.md`");
      expect(skill!.prompt).toContain("Scope Constraints");
      expect(skill!.prompt).toContain("## Constitution Alignment");
      expect(skill!.prompt).toContain("caption: \"phase-artifact:");
    }
  });
});
