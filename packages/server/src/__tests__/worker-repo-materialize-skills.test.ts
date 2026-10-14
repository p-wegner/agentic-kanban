import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeRepoSkills } from "../worker/worker-repo-skills.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", windowsHide: true });
}

describe("materializeRepoSkills (#1467)", () => {
  it("keeps the repo's tracked skill, writes the untracked one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanban-mat-skills-"));
    try {
      git(dir, "init", "-q");
      git(dir, "config", "user.email", "t@example.com");
      git(dir, "config", "user.name", "t");
      await mkdir(join(dir, ".claude", "skills", "code-review"), { recursive: true });
      const projectCopy = "---\nname: code-review\n---\nPROJECT COPY\n";
      await writeFile(join(dir, ".claude", "skills", "code-review", "SKILL.md"), projectCopy);
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "init");

      const logs: string[] = [];
      const result = await materializeRepoSkills(
        dir,
        [
          { name: "code-review", description: "d", content: "BOARD TEXT" },
          { name: "brand-new", description: "d", content: "NEW" },
        ],
        (l) => logs.push(l),
      );

      expect(result.skippedTracked).toEqual(["code-review"]);
      expect(result.written).toEqual(["brand-new"]);
      expect(await readFile(join(dir, ".claude", "skills", "code-review", "SKILL.md"), "utf-8")).toBe(projectCopy);
      expect(await readFile(join(dir, ".claude", "skills", "brand-new", "SKILL.md"), "utf-8")).toContain("NEW");
      expect(git(dir, "status", "--porcelain", "--", ".claude/skills/code-review")).toBe("");
      expect(logs.join("\n")).toContain("code-review");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
