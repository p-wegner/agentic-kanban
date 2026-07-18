import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssueWithStatus, MainWorkspaceInfo, WorkspaceSummary } from "@agentic-kanban/shared";
import { IssueCard } from "./IssueCard.js";

function issue(overrides: Partial<IssueWithStatus> = {}): IssueWithStatus {
  return {
    id: "issue-1",
    issueNumber: 7,
    title: "An issue",
    description: null,
    priority: "medium",
    issueType: "task",
    sortOrder: 0,
    statusId: "status-1",
    projectId: "project-1",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    statusChangedAt: null,
    statusName: "Todo",
    ...overrides,
  };
}

function render(i: IssueWithStatus, props: { isPendingIssue?: boolean; isPendingWorkspace?: boolean } = {}): string {
  return renderToStaticMarkup(
    <IssueCard
      issue={i}
      onClick={() => {}}
      onDragStart={() => {}}
      isPendingIssue={props.isPendingIssue}
      isPendingWorkspace={props.isPendingWorkspace}
    />,
  );
}

describe("IssueCard external tracker link", () => {
  it("renders a link with the external key when externalUrl is present", () => {
    const html = render(
      issue({ externalKey: "PROJ-123", externalUrl: "https://tracker.example.com/browse/PROJ-123" }),
    );
    expect(html).toContain('href="https://tracker.example.com/browse/PROJ-123"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("PROJ-123");
  });

  it("falls back to a generic label when only the URL is set", () => {
    const html = render(issue({ externalUrl: "https://tracker.example.com/x" }));
    expect(html).toContain('href="https://tracker.example.com/x"');
    expect(html).toContain("link");
  });

  it("renders no tracker link when externalUrl is absent", () => {
    const html = render(issue());
    expect(html).not.toContain("Open in external tracker");
  });
});

function workspaceMain(status: MainWorkspaceInfo["status"]): WorkspaceSummary {
  return {
    total: 1,
    active: status === "active" ? 1 : 0,
    idle: 0,
    closed: 0,
    branches: ["feature/ak-7"],
    main: { id: "ws-1", branch: "feature/ak-7", workingDir: "/tmp/wt", status },
  };
}

describe("IssueCard active-agent indicator", () => {
  it("shows 'Agent working' when the main workspace is active", () => {
    const html = render(issue({ statusName: "In Progress", workspaceSummary: workspaceMain("active") }));
    expect(html).toContain("Agent working");
  });

  it("shows 'AI reviewing' when the main workspace is reviewing", () => {
    const html = render(issue({ statusName: "In Review", workspaceSummary: workspaceMain("reviewing") }));
    expect(html).toContain("AI reviewing");
  });

  it("shows 'AI fixing' when the main workspace is resolving conflicts", () => {
    const html = render(issue({ statusName: "In Review", workspaceSummary: workspaceMain("fixing") }));
    expect(html).toContain("AI fixing");
  });

  it("shows no active-agent badge when the workspace is idle", () => {
    const html = render(issue({ statusName: "In Progress", workspaceSummary: workspaceMain("idle") }));
    expect(html).not.toContain("Agent working");
    expect(html).not.toContain("AI reviewing");
  });

  it("shows no active-agent badge when there is no workspace", () => {
    const html = render(issue());
    expect(html).not.toContain("Agent working");
  });
});

describe("IssueCard setup/pending feedback", () => {
  it("shows a 'Setting up workspace…' label while the workspace is being created", () => {
    const html = render(issue({ statusName: "In Progress" }), { isPendingWorkspace: true });
    expect(html).toContain("Setting up workspace");
  });

  it("does not show the setup label when the workspace is not pending", () => {
    const html = render(issue());
    expect(html).not.toContain("Setting up workspace");
  });

  it("prefers the 'Creating issue' label over the setup label while the issue itself is pending", () => {
    const html = render(issue(), { isPendingIssue: true, isPendingWorkspace: true });
    expect(html).toContain("Creating issue");
    expect(html).not.toContain("Setting up workspace");
  });
});
