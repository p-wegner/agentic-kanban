import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const boardMonitorSkills = [
  ".claude/skills/board-monitor/SKILL.md",
  ".codex/skills/board-monitor/SKILL.md",
].map((path) => ({
  path,
  contents: readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8"),
}));

describe("board-monitor frontend smoke check", () => {
  it("checks rendered app content without requiring a main element", () => {
    for (const skill of boardMonitorSkills) {
      expect(skill.contents, skill.path).not.toContain("document.querySelector('main')?.innerText || ''");
      expect(skill.contents, skill.path).toContain("document.querySelector('#root')?.innerText");
      expect(skill.contents, skill.path).toContain("document.body?.innerText");
    }
  });

  it("prints useful diagnostics for real blank or crashed renders", () => {
    for (const skill of boardMonitorSkills) {
      expect(skill.contents, skill.path).toContain("--- console ---");
      expect(skill.contents, skill.path).toContain("--- rendered text ---");
      expect(skill.contents, skill.path).toContain("--- app root html ---");
    }
  });

  it("reads active project using the active-project response shape", () => {
    for (const skill of boardMonitorSkills) {
      expect(skill.contents, skill.path).toContain("/api/preferences/active-project");
      expect(skill.contents, skill.path).toContain(").projectId");
      expect(skill.contents, skill.path).not.toContain("preferences/active-project\" -TimeoutSec 10).value");
    }
  });

  it("normalizes the board endpoint's top-level column array before counting monitor columns", () => {
    for (const skill of boardMonitorSkills) {
      expect(skill.contents, skill.path).toContain("$columns = @($board)");
      expect(skill.contents, skill.path).toContain("$columns | Where-Object { $_.name -in @(\"Backlog\", \"In Progress\", \"In Review\") }");
      expect(skill.contents, skill.path).not.toContain("$board.columns");
    }
  });
});
