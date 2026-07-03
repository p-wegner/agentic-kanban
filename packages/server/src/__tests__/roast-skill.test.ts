import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The Butler surfaces repo `.claude/skills/*` entries as `/`-commands (via the
// /commands endpoint + scanLocalSkills) and the SDK auto-loads them as invokable
// skills. `/roast` (#978) is such a skill. These assertions guard the command's
// contract: it stays discoverable, grounded in real board state, and good-natured.
const roastSkills = [
  ".claude/skills/roast/SKILL.md",
  ".codex/skills/roast/SKILL.md",
].map((path) => ({
  path,
  contents: readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8"),
}));

describe("roast skill (#978)", () => {
  it("declares the `roast` command name in frontmatter with a description", () => {
    for (const skill of roastSkills) {
      expect(skill.contents, skill.path).toMatch(/^name:\s*roast\s*$/m);
      expect(skill.contents, skill.path).toMatch(/^description:\s*\S.*$/m);
    }
  });

  it("grounds the roast in the board's real state via board MCP tools", () => {
    for (const skill of roastSkills) {
      expect(skill.contents, skill.path).toContain("get_board_status");
      expect(skill.contents, skill.path).toContain("list_issues");
    }
  });

  it("keeps the roast good-natured and encouraging, not mean", () => {
    for (const skill of roastSkills) {
      expect(skill.contents.toLowerCase(), skill.path).toContain("good-natured");
      expect(skill.contents.toLowerCase(), skill.path).toMatch(/encourag/);
    }
  });
});
