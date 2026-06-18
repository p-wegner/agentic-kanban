import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveAgentsBadge, filterProjects, getProjectInitials, ProjectSelector, type ProjectSelectorProject } from "./ProjectSelector.js";

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

describe("ActiveAgentsBadge", () => {
  it("renders nothing when there are no active agents", () => {
    expect(renderToStaticMarkup(<ActiveAgentsBadge count={0} />)).toBe("");
    expect(renderToStaticMarkup(<ActiveAgentsBadge count={-1} />)).toBe("");
  });

  it("renders a pluralized label with the count", () => {
    expect(renderToStaticMarkup(<ActiveAgentsBadge count={1} />)).toContain("1 active agent");
    expect(renderToStaticMarkup(<ActiveAgentsBadge count={3} />)).toContain("3 active agents");
  });

  it("renders just the number in compact mode", () => {
    const html = renderToStaticMarkup(<ActiveAgentsBadge count={2} compact />);
    expect(html).toContain(">2<");
    expect(html).not.toContain("active agents");
    expect(html).toContain('title="2 active agents"');
  });
});

describe("ProjectSelector active agents", () => {
  it("surfaces the active agent count for the selected project", () => {
    const withCounts: ProjectSelectorProject[] = [
      { ...projects[0], activeWorkspaceCount: 2 },
      { ...projects[1], activeWorkspaceCount: 0 },
    ];
    const html = renderToStaticMarkup(
      <ProjectSelector projects={withCounts} activeProjectId="project-1" onProjectChange={() => undefined} />,
    );
    expect(html).toContain('title="2 active agents"');
  });
});
