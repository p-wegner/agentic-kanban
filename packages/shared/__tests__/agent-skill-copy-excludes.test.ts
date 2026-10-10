import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copySkillToWorktree, shouldCopySkillEntry } from "../src/lib/agent-skill-files";

describe("copySkillToWorktree dependency exclusion (#1356)", () => {
  it("skips .venv / node_modules / __pycache__ but copies real assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "ak-1356-skill-copy-"));
    try {
      const repo = join(root, "repo");
      const wt = join(root, "wt");
      const skill = join(repo, ".claude", "skills", "demo");
      await mkdir(join(skill, ".venv", "Lib", "site-packages"), { recursive: true });
      await mkdir(join(skill, "tools", "__pycache__"), { recursive: true });
      await mkdir(join(skill, "node_modules", "x"), { recursive: true });
      await writeFile(join(skill, "SKILL.md"), "---\nname: demo\n---\nbody");
      await writeFile(join(skill, ".venv", "Lib", "site-packages", "big.py"), "x");
      await writeFile(join(skill, "tools", "run.mjs"), "x");
      await writeFile(join(skill, "tools", "__pycache__", "run.pyc"), "x");

      expect(await copySkillToWorktree(repo, "demo", wt)).toBe(true);

      const dest = join(wt, ".claude", "skills", "demo");
      expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
      expect(existsSync(join(dest, "tools", "run.mjs"))).toBe(true);
      expect(existsSync(join(dest, ".venv"))).toBe(false);
      expect(existsSync(join(dest, "node_modules"))).toBe(false);
      expect(existsSync(join(dest, "tools", "__pycache__"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filter matches by entry name", () => {
    expect(shouldCopySkillEntry("a/b/.venv")).toBe(false);
    expect(shouldCopySkillEntry("a\\b\\node_modules")).toBe(false);
    expect(shouldCopySkillEntry("a/b/tools")).toBe(true);
  });
});
