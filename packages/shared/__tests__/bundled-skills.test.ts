import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findBundledSkillsDir,
  listBundledSkills,
  installBundledSkill,
  inspectInstalledSkill,
  discoverUserSkillRoots,
  selectSkillsToInstall,
  type BundledSkill,
} from "../src/lib/bundled-skills.js";

let root: string;
let bundle: string;
let skill: BundledSkill;

async function makeBundle(commit: string) {
  const dir = join(bundle, "demo-skill");
  await mkdir(join(dir, "references"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: demo-skill\ndescription: A demo\ncommit: ${commit}\n---\n\nbody\n`, "utf-8");
  await writeFile(join(dir, "references", "extra.md"), "extra\n", "utf-8");
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ak-bundled-skills-"));
  bundle = join(root, "skills");
  await makeBundle("aaaa111");
  [skill] = await listBundledSkills(bundle);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listBundledSkills", () => {
  it("reads name, description and commit stamp from the frontmatter", () => {
    expect(skill.name).toBe("demo-skill");
    expect(skill.description).toBe("A demo");
    expect(skill.commit).toBe("aaaa111");
  });

  it("ignores a directory with no SKILL.md rather than reporting a broken skill", async () => {
    await mkdir(join(bundle, "not-a-skill"), { recursive: true });
    expect((await listBundledSkills(bundle)).map(s => s.name)).toEqual(["demo-skill"]);
  });

  it("returns nothing instead of throwing when there is no bundle at all", async () => {
    expect(await listBundledSkills(join(root, "absent"))).toEqual([]);
  });
});

describe("installBundledSkill", () => {
  it("links by default, so the install tracks the package", async () => {
    const skillsDir = join(root, "target", ".claude", "skills");
    const result = await installBundledSkill(skill, skillsDir);

    expect(result.mode).toBe("linked");
    expect((await lstat(result.path)).isSymbolicLink()).toBe(true);
    // The whole bundle is reachable through the link — a skill whose references/ is missing
    // documents files that do not exist.
    expect(await readFile(join(result.path, "references", "extra.md"), "utf-8")).toBe("extra\n");
  });

  it("copies the full directory when linking is declined", async () => {
    const skillsDir = join(root, "target", ".claude", "skills");
    const result = await installBundledSkill(skill, skillsDir, { link: false });

    expect(result.mode).toBe("copied");
    expect((await lstat(result.path)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(result.path, "references", "extra.md"), "utf-8")).toBe("extra\n");
  });

  it("replaces a stale copy rather than leaving the old files in place", async () => {
    const skillsDir = join(root, "target", ".claude", "skills");
    await installBundledSkill(skill, skillsDir, { link: false });
    await writeFile(join(skillsDir, "demo-skill", "leftover.md"), "old", "utf-8");

    await installBundledSkill(skill, skillsDir, { link: false });
    await expect(readFile(join(skillsDir, "demo-skill", "leftover.md"), "utf-8")).rejects.toThrow();
  });

  it("is idempotent for an existing link to the same bundle", async () => {
    const skillsDir = join(root, "target", ".claude", "skills");
    const first = await installBundledSkill(skill, skillsDir);
    const second = await installBundledSkill(skill, skillsDir);
    expect(second).toEqual({ name: first.name, path: first.path, mode: "linked" });
  });
});

describe("inspectInstalledSkill", () => {
  const skillsDir = () => join(root, "target", ".claude", "skills");

  it("reports absent when nothing is installed", async () => {
    expect(await inspectInstalledSkill(skill, skillsDir())).toEqual({ state: "absent" });
  });

  it("reports a link as linked without comparing content", async () => {
    await installBundledSkill(skill, skillsDir());
    expect((await inspectInstalledSkill(skill, skillsDir())).state).toBe("linked");
  });

  it("reports a matching copy as current", async () => {
    await installBundledSkill(skill, skillsDir(), { link: false });
    const state = await inspectInstalledSkill(skill, skillsDir());
    expect(state).toMatchObject({ state: "current", commit: "aaaa111" });
  });

  it("reports a copy that fell behind the bundle as stale", async () => {
    await installBundledSkill(skill, skillsDir(), { link: false });
    // Regenerating the bundle is what an upgrade looks like from the copy's point of view.
    await makeBundle("bbbb222");
    const [updated] = await listBundledSkills(bundle);

    const state = await inspectInstalledSkill(updated, skillsDir());
    expect(state).toMatchObject({ state: "stale", commit: "aaaa111", bundledCommit: "bbbb222" });
  });
});

describe("discoverUserSkillRoots", () => {
  it("finds every claude profile plus codex, and invents none", async () => {
    const home = join(root, "home");
    for (const dir of [".claude", ".claude-work", ".codex", ".config", "Documents"]) {
      await mkdir(join(home, dir), { recursive: true });
    }
    expect(await discoverUserSkillRoots(home)).toEqual([
      join(home, ".claude", "skills"),
      join(home, ".claude-work", "skills"),
      join(home, ".codex", "skills"),
    ]);
  });

  it("returns nothing for a home with no agent installed", async () => {
    const home = join(root, "empty-home");
    await mkdir(home, { recursive: true });
    expect(await discoverUserSkillRoots(home)).toEqual([]);
  });
});

describe("findBundledSkillsDir", () => {
  it("locates this repo's own bundle from the running module", () => {
    const dir = findBundledSkillsDir();
    expect(dir).toBeTruthy();
    expect(dir!.replace(/\\/g, "/")).toMatch(/packages\/server\/skills$/);
  });
});

describe("selectSkillsToInstall", () => {
  const bundled = [{ name: "agentic-kanban" }];
  const promptOnly = [{ name: "agentic-kanban" }, { name: "code-review" }, { name: "orchestrator" }];
  const names = (r: { bundled: { name: string }[]; promptOnly: { name: string }[] }) => ({
    bundled: r.bundled.map(s => s.name),
    promptOnly: r.promptOnly.map(s => s.name),
  });

  it("drops a prompt-only skill that a bundled directory supersedes", () => {
    expect(names(selectSkillsToInstall({ bundled, promptOnly }))).toEqual({
      bundled: ["agentic-kanban"],
      promptOnly: ["code-review", "orchestrator"],
    });
  });

  it("installs bundled skills ONLY for a --user install", () => {
    expect(names(selectSkillsToInstall({ bundled, promptOnly, user: true }))).toEqual({
      bundled: ["agentic-kanban"],
      promptOnly: [],
    });
  });

  it("still installs a prompt-only skill under --user when it is named explicitly", () => {
    expect(names(selectSkillsToInstall({ bundled, promptOnly, user: true, names: ["code-review"] }))).toEqual({
      bundled: [],
      promptOnly: ["code-review"],
    });
  });

  it("gives a project target both kinds", () => {
    const result = selectSkillsToInstall({ bundled, promptOnly });
    expect(result.bundled.length + result.promptOnly.length).toBe(3);
  });

  it("ignores blank entries from a trailing comma in -n", () => {
    expect(names(selectSkillsToInstall({ bundled, promptOnly, names: ["agentic-kanban", " ", ""] }))).toEqual({
      bundled: ["agentic-kanban"],
      promptOnly: [],
    });
  });

  it("returns nothing selected for a name that matches neither kind", () => {
    const result = selectSkillsToInstall({ bundled, promptOnly, names: ["nope"] });
    expect(result).toEqual({ bundled: [], promptOnly: [] });
  });
});
