import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IssueArtifact } from "@agentic-kanban/shared";
import {
  copyIssueArtifactContent,
  IssueArtifactsSection,
  issueArtifactPreview,
  openIssueArtifact,
} from "./IssueDetailPanel.js";

function artifact(overrides: Partial<IssueArtifact> = {}): IssueArtifact {
  return {
    id: "artifact-1",
    issueId: "issue-1",
    workspaceId: "workspace-1",
    type: "text",
    mimeType: "text/markdown",
    caption: "github-handoff-draft",
    content: "# Handoff\n\nGenerated review summary for the next engineer.",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

describe("IssueArtifactsSection", () => {
  it("lists generated artifacts with kind, author, timestamp, preview, and actions", () => {
    const html = renderToStaticMarkup(
      <IssueArtifactsSection
        artifacts={[
          artifact(),
          artifact({
            id: "artifact-2",
            workspaceId: null,
            caption: "phase-artifact:tasks",
            content: "# Tasks\n\n- Implement artifact browser",
            createdAt: new Date(Date.now() - 120_000).toISOString(),
          }),
        ]}
        loading={false}
        expandedArtifactId={null}
        onOpen={() => {}}
        onCopy={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(html).toContain("Artifacts");
    expect(html).toContain("GitHub draft");
    expect(html).toContain("Phase tasks.md");
    expect(html).toContain("agent");
    expect(html).toContain("system");
    expect(html).toContain(issueArtifactPreview(artifact()));
    expect(html).toContain("Open");
    expect(html).toContain("Copy");
    expect(html).toContain("Delete");
  });

  it("copies and opens one artifact through browser APIs", async () => {
    const linkArtifact = artifact({
      type: "link",
      mimeType: null,
      caption: "Release notes draft",
      content: "https://example.test/release-notes",
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const open = vi.fn();

    await expect(copyIssueArtifactContent(linkArtifact, { writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://example.test/release-notes");

    expect(openIssueArtifact(linkArtifact, open)).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.test/release-notes", "_blank", "noopener,noreferrer");
  });

  it("keeps empty and loading states compact", () => {
    const loadingHtml = renderToStaticMarkup(
      <IssueArtifactsSection artifacts={[]} loading={true} expandedArtifactId={null} onOpen={() => {}} onCopy={() => {}} onDelete={() => {}} />,
    );
    const emptyHtml = renderToStaticMarkup(
      <IssueArtifactsSection artifacts={[]} loading={false} expandedArtifactId={null} onOpen={() => {}} onCopy={() => {}} onDelete={() => {}} />,
    );

    expect(loadingHtml).toContain("Loading artifacts...");
    expect(emptyHtml).toContain("No generated artifacts yet.");
    expect(emptyHtml).not.toContain("<li");
  });
});
