import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RecentBoardHealthEventsSection, type BoardHealthEvent } from "./MonitorPopover.js";

const formatAge = () => "2m ago";

describe("RecentBoardHealthEventsSection", () => {
  it("renders recent board health events", () => {
    const events: BoardHealthEvent[] = [{
      id: "event-1",
      timestamp: "2026-05-31T10:00:00.000Z",
      level: "info",
      type: "action",
      summary: "Invoked tool: merge_workspace",
      details: "tool: merge_workspace",
    }];

    const html = renderToStaticMarkup(
      <RecentBoardHealthEventsSection events={events} loading={false} error={null} formatAge={formatAge} />,
    );

    expect(html).toContain("Recent events");
    expect(html).toContain("action");
    expect(html).toContain("Invoked tool: merge_workspace");
    expect(html).toContain("tool: merge_workspace");
    expect(html).toContain("2m ago");
  });

  it("renders loading, empty, and error states", () => {
    expect(renderToStaticMarkup(
      <RecentBoardHealthEventsSection events={[]} loading={true} error={null} formatAge={formatAge} />,
    )).toContain("Loading events...");

    expect(renderToStaticMarkup(
      <RecentBoardHealthEventsSection events={[]} loading={false} error={null} formatAge={formatAge} />,
    )).toContain("No board health events yet");

    expect(renderToStaticMarkup(
      <RecentBoardHealthEventsSection events={[]} loading={false} error="Could not load" formatAge={formatAge} />,
    )).toContain("Could not load");
  });
});
