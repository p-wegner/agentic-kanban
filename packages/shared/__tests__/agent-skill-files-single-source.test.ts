import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listLocalSkillNamesSync,
  skillDirOf,
  skillsDirOf,
  writeAgentSkillFile,
} from "../src/lib/agent-skill-files.js";

/**
 * #553 — `agent-skill-files` declares itself the single source of truth for materialized
 * skills, but three writers/scanners bypassed it and fourteen sites re-derived the
 * `.claude/skills` join. Each bypass carried a real defect; these pin the two that had
 * user-visible consequences.
 */
const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "skill-ssot-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent-skill-files is the single derivation (#553)", () => {
  it("skillsDirOf/skillDirOf agree with where writeAgentSkillFile puts a skill", async () => {
    const root = temp();
    const { skillsDir, skillDir } = await writeAgentSkillFile(root, {
      name: "prober",
      description: "Probe things.",
      prompt: "Do the thing.",
    });
    expect(skillsDir).toBe(skillsDirOf(root));
    expect(skillDir).toBe(skillDirOf(root, "prober"));
  });

  it("writes frontmatter, so a materialized skill is discoverable as a slash-command", async () => {
    const root = temp();
    await writeAgentSkillFile(root, { name: "prober", description: "Probe things.", prompt: "Body." });
    const content = readFileSync(join(skillDirOf(root, "prober"), "SKILL.md"), "utf-8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("name: prober");
    expect(content).toContain("description: Probe things.");
  });

  it("refuses a skill name that would escape the skills directory", async () => {
    const root = temp();
    await expect(writeAgentSkillFile(root, { name: "../evil", description: "", prompt: "x" })).rejects.toThrow();
  });

  it("the sync lister sees a JUNCTIONED (plugin) skill, not only real directories", () => {
    const root = temp();
    const pluginCheckout = temp();
    const source = join(pluginCheckout, "skills", "linked");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: linked\ndescription: d\n---\n\nbody");

    mkdirSync(skillsDirOf(root), { recursive: true });
    mkdirSync(skillDirOf(root, "real"), { recursive: true });
    writeFileSync(join(skillDirOf(root, "real"), "SKILL.md"), "body");
    try {
      symlinkSync(source, skillDirOf(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // no symlink privilege here — the real-directory case above still ran
    }

    // readdir reports the junction as a SYMLINK, never a directory: an `isDirectory()`-only
    // scan made every plugin skill invisible to the launch path while it sat on disk.
    expect(listLocalSkillNamesSync(root).sort()).toEqual(["linked", "real"]);
  });

  it("returns an empty list for a root with no skills directory", () => {
    expect(listLocalSkillNamesSync(temp())).toEqual([]);
  });
});
