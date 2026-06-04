import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isSkillsDirAbsentOrEmpty, writeAgentSkillFile } from "../../../shared/src/lib/agent-skill-files.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kanban-export-skills-"));
}

describe("isSkillsDirAbsentOrEmpty", () => {
  it("returns true when .claude/skills does not exist", async () => {
    const dir = await tmp();
    try {
      expect(await isSkillsDirAbsentOrEmpty(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns true when .claude/skills exists but has no SKILL.md files", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, ".claude", "skills"), { recursive: true });
      expect(await isSkillsDirAbsentOrEmpty(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns false when .claude/skills contains at least one SKILL.md (no-clobber guard)", async () => {
    const dir = await tmp();
    try {
      await writeAgentSkillFile(dir, {
        name: "my-custom-skill",
        description: "custom skill committed to the repo",
        prompt: "Do something custom.",
      });
      expect(await isSkillsDirAbsentOrEmpty(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-directory entries inside .claude/skills", async () => {
    const dir = await tmp();
    try {
      await mkdir(join(dir, ".claude", "skills"), { recursive: true });
      await writeFile(join(dir, ".claude", "skills", "README.md"), "# skills\n");
      expect(await isSkillsDirAbsentOrEmpty(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
