// Regression tests for ticket #61: the frontmatter parsers hardcoded `\n` with no
// `\r?`, so on a CRLF checkout (Windows + core.autocrlf=true) `^---\n` never matched.
//
//  1. readLocalSkillPrompt silently fell through to `content.trim()` and returned the
//     WHOLE FILE — frontmatter included — violating its contract. Its caller
//     (resolveSkillFile in workspace-provision.service.ts) fed that back into
//     writeAgentSkillFile, which prepends a fresh frontmatter block: every Windows
//     worktree was born with a two-block SKILL.md.
//  2. parseDiskSkillMarkdown took its !frontmatterMatch branch, yielding a blank
//     description and a prompt containing the raw frontmatter.
//
// Every fixture in the suite was LF, so CI could never see this. These tests feed
// CRLF through the real read/write paths — the guard for a Windows-first repo whose
// parsers are LF-only. Each CRLF case is paired with its LF twin so a fix that
// breaks LF is caught too.

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLocalSkillPrompt, scanLocalSkills, writeAgentSkillFile } from "../src/lib/agent-skill-files.js";

let repoPath: string;

const SKILL_BODY = ["# Board Navigator", "", "Use the MCP tools to drive the board.", "", "## Steps", "", "1. list_issues"].join("\n");

/** Write a SKILL.md with the given line ending, exactly as git would check it out. */
async function installSkill(name: string, eol: "\n" | "\r\n", front = `name: ${name}\ndescription: Drive the board`) {
  const dir = join(repoPath, ".claude", "skills", name);
  await mkdir(dir, { recursive: true });
  const content = ["---", front, "---", "", SKILL_BODY].join("\n");
  await writeFile(join(dir, "SKILL.md"), content.replace(/\n/g, eol), "utf-8");
}

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), "ak61-skills-"));
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true }).catch(() => {});
});

describe("readLocalSkillPrompt", () => {
  for (const [label, eol] of [["LF", "\n"], ["CRLF", "\r\n"]] as const) {
    it(`strips the frontmatter from a ${label} SKILL.md`, async () => {
      await installSkill("board-navigator", eol);

      const prompt = await readLocalSkillPrompt(repoPath, "board-navigator");

      expect(prompt).not.toBeNull();
      // The contract: everything after the frontmatter, and nothing from inside it.
      expect(prompt).not.toContain("description: Drive the board");
      expect(prompt!.startsWith("---")).toBe(false);
      expect(prompt).toContain("# Board Navigator");
      expect(prompt).toContain("1. list_issues");
    });
  }

  it("returns the whole body for a file with no frontmatter at all", async () => {
    const dir = join(repoPath, ".claude", "skills", "bare");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), SKILL_BODY, "utf-8");

    expect(await readLocalSkillPrompt(repoPath, "bare")).toBe(SKILL_BODY);
  });

  it("returns null when the skill is not installed locally", async () => {
    expect(await readLocalSkillPrompt(repoPath, "absent")).toBeNull();
  });
});

describe("scanLocalSkills", () => {
  for (const [label, eol] of [["LF", "\n"], ["CRLF", "\r\n"]] as const) {
    it(`parses name, description and model from a ${label} SKILL.md`, async () => {
      await installSkill("board-navigator", eol, "name: board-navigator\ndescription: Drive the board\nmodel: opus");

      const [skill] = await scanLocalSkills(repoPath);

      expect(skill.name).toBe("board-navigator");
      // Was "" on CRLF — the blank descriptions seen in the skills UI.
      expect(skill.description).toBe("Drive the board");
      expect(skill.model).toBe("opus");
      expect(skill.prompt).toContain("# Board Navigator");
      expect(skill.prompt).not.toContain("description:");
    });
  }
});

describe("writeAgentSkillFile", () => {
  // The end-to-end shape of the bug: local disk (CRLF) overrides the DB prompt, and
  // the result is materialized into the worktree. Exactly ONE frontmatter block.
  it("materializes a single frontmatter block from a CRLF local override", async () => {
    await installSkill("board-navigator", "\r\n");
    const worktreePath = await mkdtemp(join(tmpdir(), "ak61-worktree-"));
    try {
      const localPrompt = await readLocalSkillPrompt(repoPath, "board-navigator");
      await writeAgentSkillFile(worktreePath, {
        name: "board-navigator",
        description: "Drive the board",
        prompt: localPrompt!,
      });

      const written = await readFile(join(worktreePath, ".claude", "skills", "board-navigator", "SKILL.md"), "utf-8");
      expect(fenceCount(written)).toBe(2);
      expect(written).toContain("# Board Navigator");
    } finally {
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    }
  });

  // Defense in depth: even if some other caller hands us an already-frontmattered
  // prompt, it must not round-trip into a stacked second block.
  for (const [label, eol] of [["LF", "\n"], ["CRLF", "\r\n"]] as const) {
    it(`strips leading ${label} frontmatter already present in the prompt`, async () => {
      const worktreePath = await mkdtemp(join(tmpdir(), "ak61-worktree-"));
      try {
        const poisoned = ["---", "name: board-navigator", "description: stale", "---", "", SKILL_BODY]
          .join("\n")
          .replace(/\n/g, eol);
        await writeAgentSkillFile(worktreePath, {
          name: "board-navigator",
          description: "Drive the board",
          prompt: poisoned,
        });

        const written = await readFile(join(worktreePath, ".claude", "skills", "board-navigator", "SKILL.md"), "utf-8");
        expect(fenceCount(written)).toBe(2);
        expect(written).toContain("description: Drive the board");
        expect(written).not.toContain("description: stale");
        expect(written).toContain("# Board Navigator");
      } finally {
        await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  it("keeps a `---` divider inside the skill body", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "ak61-worktree-"));
    try {
      await writeAgentSkillFile(worktreePath, {
        name: "divider",
        description: "Has a divider",
        prompt: "Intro paragraph.\n\n---\n\nSection after a horizontal rule.",
      });

      const written = await readFile(join(worktreePath, ".claude", "skills", "divider", "SKILL.md"), "utf-8");
      expect(fenceCount(written)).toBe(3);
      expect(written).toContain("Section after a horizontal rule.");
    } finally {
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    }
  });
});

/** Count `---` fence lines — the signature check-skill-frontmatter.js uses. */
function fenceCount(content: string): number {
  return content.split(/\r?\n/).filter((l) => l.trim() === "---").length;
}
