import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { filterProjects, getProjectInitials, ProjectSelector, type ProjectSelectorProject } from "./ProjectSelector.js";

const projects: ProjectSelectorProject[] = [
  {
    id: "project-1",
    name: "Agentic Kanban",
    repoName: "agentic-kanban",
    repoPath: "C:/andrena/agentic-kanban",
    defaultBranch: "master",
  },
  {
    id: "project-2",
    name: "Docs Site",
    repoName: "docs",
    repoPath: "C:/andrena/docs",
    defaultBranch: "main",
  },
];

describe("ProjectSelector", () => {
  it("derives compact initials from project names", () => {
    expect(getProjectInitials("Agentic Kanban")).toBe("AK");
    expect(getProjectInitials("docs")).toBe("DO");
    expect(getProjectInitials("  ")).toBe("?");
  });

  it("filters projects by name and repository metadata", () => {
    expect(filterProjects(projects, "kanban").map((project) => project.id)).toEqual(["project-1"]);
    expect(filterProjects(projects, "main").map((project) => project.id)).toEqual(["project-2"]);
    expect(filterProjects(projects, "").map((project) => project.id)).toEqual(["project-1", "project-2"]);
  });

  it("renders the active project button instead of a native select", () => {
    const html = renderToStaticMarkup(
      <ProjectSelector projects={projects} activeProjectId="project-1" onProjectChange={() => undefined} />,
    );

    expect(html).toContain("Agentic Kanban");
    expect(html).toContain("2 projects");
    expect(html).not.toContain("<select");
  });
});
