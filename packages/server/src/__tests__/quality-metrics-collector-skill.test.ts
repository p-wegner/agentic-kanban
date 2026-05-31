import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS } from "../builtin-skills.js";

describe("quality-metrics-collector skill", () => {
  it("renders the API target, stable metric keys, and partial-failure guidance", () => {
    const skill = BUILTIN_SKILLS.find((item) => item.name === "quality-metrics-collector");

    expect(skill).toBeDefined();
    expect(skill!.description).toMatch(/quality metrics/i);
    expect(skill!.prompt).toContain("/api/projects/:projectId/quality-metrics");
    expect(skill!.prompt).toContain("http://127.0.0.1:<port>/api");
    expect(skill!.prompt).toContain("loc.total");
    expect(skill!.prompt).toContain("coverage.lines");
    expect(skill!.prompt).toContain("lint.errors");
    expect(skill!.prompt).toContain("typecheck.errors");
    expect(skill!.prompt).toMatch(/partial failures/i);
    expect(skill!.prompt).toContain("Invoke-RestMethod");
  });

  it("keeps the local installable skill safe for worktree-launched collectors", () => {
    const skillPath = new URL("../../../../.claude/skills/quality-metrics-collector/SKILL.md", import.meta.url);
    const prompt = readFileSync(skillPath, "utf8");

    expect(prompt).toContain("Project ID from the issue description");
    expect(prompt).toContain("KANBAN_BOARD_SERVER_PORT");
    expect(prompt).toContain(
      '$serverPort = if ($env:KANBAN_BOARD_SERVER_PORT) { $env:KANBAN_BOARD_SERVER_PORT } elseif ($env:KANBAN_SERVER_PORT)',
    );
    expect(prompt).toContain("/api/projects/$projectId/quality-metrics");
  });
});
