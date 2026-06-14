import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildIssueActivityMarkdown,
  IssueActivitySection,
  issueActivityMarkdownFilename,
  type ActivityEvent,
} from "./IssueActivitySection.js";

const events: ActivityEvent[] = [
  {
    id: "event-2",
    type: "status_changed",
    summary: "Moved to Review",
    actor: "system",
    timestamp: "2024-05-02T10:00:00.000Z",
  },
  {
    id: "event-1",
    type: "issue_created",
    summary: "Issue created",
    actor: "user",
    timestamp: "2024-05-01T09:00:00.000Z",
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("issue activity markdown export", () => {
  it("builds a chronological Markdown activity history using locale timestamps", () => {
    vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function formatForTest(this: Date) {
      return `local:${this.toISOString()}`;
    });

    const markdown = buildIssueActivityMarkdown("Export #activity", "Review", events);

    expect(markdown).toContain("# Export #activity");
    expect(markdown).toContain("Current status: Review");
    expect(markdown.indexOf("Issue created")).toBeLessThan(markdown.indexOf("Moved to Review"));
    expect(markdown).toContain("**local:2024-05-01T09:00:00.000Z** - Issue created by user");
    expect(markdown).toContain("**local:2024-05-02T10:00:00.000Z** - Moved to Review by system");
  });

  it("uses a stable Markdown filename", () => {
    expect(issueActivityMarkdownFilename("Export activity as Markdown!", 523))
      .toBe("issue-523-export-activity-as-markdown-activity.md");
  });

  it("renders an export action when issue context is provided", () => {
    const html = renderToStaticMarkup(
      <IssueActivitySection
        events={events}
        loading={false}
        issueTitle="Export activity"
        issueNumber={523}
        currentStatusName="Review"
      />,
    );

    expect(html).toContain("Export activity as Markdown");
    expect(html).toContain("Activity");
  });
});
