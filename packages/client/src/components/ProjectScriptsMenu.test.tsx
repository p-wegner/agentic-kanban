import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectScriptsMenu, scriptStatusLabel } from "./ProjectScriptsMenu.js";

describe("ProjectScriptsMenu", () => {
  it("renders the compact Scripts menu trigger", () => {
    const html = renderToStaticMarkup(<ProjectScriptsMenu projectId="project-1" />);
    expect(html).toContain("Scripts");
    expect(html).toContain("aria-haspopup=\"menu\"");
  });

  it("formats session-only last run status", () => {
    expect(scriptStatusLabel({
      id: "script-1",
      projectId: "project-1",
      name: "Build",
      description: "Compile the project",
      command: "pnpm build",
      cwdMode: "project",
      workingDir: null,
      sortOrder: 0,
      createdAt: "now",
      updatedAt: "now",
      lastRun: { status: "failed", startedAt: "now", endedAt: "later", exitCode: 1 },
    })).toBe("Failed 1");
  });
});
