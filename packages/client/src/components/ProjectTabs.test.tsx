import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildProjectTabs,
  ProjectTabs,
  sanitizeProjectTabState,
  togglePinnedProjectTab,
  updateProjectTabRecentState,
  type ProjectTabProject,
} from "./ProjectTabs.js";

const projects: ProjectTabProject[] = [
  { id: "project-1", name: "One" },
  { id: "project-2", name: "Two" },
  { id: "project-3", name: "Three" },
  { id: "project-4", name: "Four" },
  { id: "project-5", name: "Five" },
  { id: "project-6", name: "Six" },
];

describe("ProjectTabs", () => {
  it("promotes a switched project into recent tabs", () => {
    const state = updateProjectTabRecentState(
      { pinnedIds: [], recentIds: ["project-1"] },
      "project-2",
      projects,
    );

    expect(state.recentIds.slice(0, 2)).toEqual(["project-2", "project-1"]);
  });

  it("keeps pinned projects before recent projects", () => {
    const state = togglePinnedProjectTab(
      { pinnedIds: [], recentIds: ["project-1", "project-2"] },
      "project-2",
      projects,
    );

    expect(buildProjectTabs(state, projects, "project-1").map((tab) => tab.id)).toEqual([
      "project-2",
      "project-1",
    ]);
  });

  it("removes deleted projects from persisted tab state", () => {
    expect(sanitizeProjectTabState(
      { pinnedIds: ["missing", "project-1"], recentIds: ["project-2", "missing"] },
      projects,
    )).toEqual({
      pinnedIds: ["project-1"],
      recentIds: ["project-2"],
    });
  });

  it("renders compact tabs with overflow instead of expanding the header", () => {
    const originalLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: () => JSON.stringify({
          pinnedIds: ["project-1", "project-2", "project-3", "project-4", "project-5", "project-6"],
          recentIds: [],
        }),
        setItem: () => undefined,
      },
      configurable: true,
    });

    try {
      const html = renderToStaticMarkup(
        <ProjectTabs projects={projects} activeProjectId="project-1" onProjectChange={() => undefined} />,
      );

      expect(html).toContain("Pinned project tabs");
      expect(html).toContain("More pinned project tabs");
      expect(html).toContain("+1");
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: originalLocalStorage,
        configurable: true,
      });
    }
  });
});
