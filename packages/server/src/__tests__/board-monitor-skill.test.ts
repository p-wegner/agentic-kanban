import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const boardMonitorSkills = [
  ".claude/skills/board-monitor/SKILL.md",
  ".codex/skills/board-monitor/SKILL.md",
].map((path) => ({
  path,
  contents: readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8"),
}));

// The frontend smoke-check JS/diagnostics were extracted from the SKILL bodies into a
// shared script (token-bloat cut). The render-correctness regression guards now live there.
const frontendSmoke = {
  path: "scripts/board-monitor/frontend-smoke.ps1",
  contents: readFileSync(new URL("../../../../scripts/board-monitor/frontend-smoke.ps1", import.meta.url), "utf8"),
};

describe("board-monitor frontend smoke check", () => {
  it("checks rendered app content without requiring a main element", () => {
    // The bare `main`-only read regressed blank-page detection; the smoke script must
    // fall back through #root and document.body.
    expect(frontendSmoke.contents, frontendSmoke.path).not.toContain("document.querySelector('main')?.innerText || ''");
    expect(frontendSmoke.contents, frontendSmoke.path).toContain("document.querySelector('#root')?.innerText");
    expect(frontendSmoke.contents, frontendSmoke.path).toContain("document.body?.innerText");
  });

  it("prints useful diagnostics for real blank or crashed renders", () => {
    expect(frontendSmoke.contents, frontendSmoke.path).toContain("--- console ---");
    expect(frontendSmoke.contents, frontendSmoke.path).toContain("--- rendered text ---");
    expect(frontendSmoke.contents, frontendSmoke.path).toContain("--- app root html ---");
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
      // The board endpoint returns a top-level column array — wrap it with @(...) and filter
      // by name; do NOT index a non-existent `.columns` property.
      expect(skill.contents, skill.path).toContain("@($board) | Where-Object");
      expect(skill.contents, skill.path).toContain("$_.name -in @(\"Backlog\",\"In Progress\",\"In Review\")");
      expect(skill.contents, skill.path).not.toContain("$board.columns");
    }
  });
});
