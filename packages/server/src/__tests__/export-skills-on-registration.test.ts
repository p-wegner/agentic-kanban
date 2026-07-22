import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isSkillsDirAbsentOrEmpty, writeAgentSkillFile } from "../../../shared/src/lib/agent-skill-files.js";
import { isBuilderRelevantSkill } from "../../../shared/src/lib/builder-skill-policy.js";
import { BUILTIN_SKILLS } from "../builtin-skills.js";

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

describe("builtin export is narrowed to builder-relevant skills (#129)", () => {
  const exported = BUILTIN_SKILLS.filter((s) => isBuilderRelevantSkill(s.name)).map((s) => s.name);

  it("exports strictly fewer skills than the full builtin set", () => {
    // Every exported skill rides into every worktree and pays an always-on
    // name+description context tax per turn. If this stops being a strict
    // subset, the #129 reclaim has been undone.
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.length).toBeLessThan(BUILTIN_SKILLS.length);
  });

  it("still exports board-navigator so worktrees are never skill-less", () => {
    // project-registration seeds board-navigator as the project default skill;
    // dropping it from the export would leave that default unresolvable on disk.
    expect(exported).toContain("board-navigator");
  });

  it("drops the board-side skills that never run as a worktree agent", () => {
    for (const name of ["ticket-enhancer", "dependency-analyzer", "monitor-nudge", "orchestrator"]) {
      expect(exported).not.toContain(name);
    }
  });
});
