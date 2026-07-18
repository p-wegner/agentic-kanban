import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentFlightRecorderView } from "./AgentFlightRecorder.js";
import {
  collectFlightRecorderFacets,
  filterFlightRecorderEvents,
  mergeFlightRecorderEvents,
  normalizeAgentQuestion,
  normalizeCrossRepoEntry,
  normalizeStallSignal,
  type FlightRecorderEvent,
} from "../lib/flightRecorderEvents.js";

const T0 = Date.parse("2026-07-18T10:00:00.000Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();

/** A merged timeline drawn from three distinct runtime sources. */
function sampleEvents(): FlightRecorderEvent[] {
  return mergeFlightRecorderEvents([
    [
      normalizeCrossRepoEntry({
        id: "ws1:auth-svc:conflict_appeared",
        timestamp: at(3),
        repo: "auth-svc",
        kind: "conflict_appeared",
        summary: "#42 auth-svc conflicts with base",
        workspaceId: "ws1",
        issueId: "issue-42",
        issueNumber: 42,
      }),
    ],
    [
      normalizeStallSignal({
        workspaceId: "ws2",
        issueId: "issue-7",
        issueNumber: 7,
        issueTitle: "Fix login",
        sessionId: "sess-7",
        at: at(2),
        signal: { state: "stalled", idleSec: 300 },
      })!,
    ],
    [
      normalizeAgentQuestion(
        {
          toolUseId: "tool-9",
          workspaceId: "ws3",
          sessionId: "sess-9",
          issueId: "issue-9",
          issueNumber: 9,
          question: "Which index?",
          askedAt: at(1),
        },
        at(1),
      ),
    ],
  ]);
}

const noopFilter = { onFilterChange: () => {}, onJump: () => {} };

describe("AgentFlightRecorderView", () => {
  it("renders the merged timeline newest-first with severity + kind coding", () => {
    const events = sampleEvents();
    const html = renderToStaticMarkup(
      <AgentFlightRecorderView
        events={events}
        totalCount={events.length}
        facets={collectFlightRecorderFacets(events)}
        filter={{}}
        {...noopFilter}
      />,
    );
    // One row per event, newest (conflict at min 3) first.
    const kinds = [...html.matchAll(/data-kind="([a-z_]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(["conflict", "stall", "agent_question"]);
    const severities = [...html.matchAll(/data-severity="([a-z]+)"/g)].map((m) => m[1]);
    expect(severities).toEqual(["error", "warn", "warn"]);
    // Summaries from each source are present.
    expect(html).toContain("auth-svc conflicts with base");
    expect(html).toContain("agent stalled");
    expect(html).toContain("agent question");
  });

  it("renders a jump-to-transcript link labeled with the workspace", () => {
    const events = sampleEvents();
    const html = renderToStaticMarkup(
      <AgentFlightRecorderView
        events={events}
        totalCount={events.length}
        facets={collectFlightRecorderFacets(events)}
        filter={{}}
        {...noopFilter}
      />,
    );
    expect(html).toContain('data-testid="flight-recorder-jump"');
    expect(html).toContain("jump to transcript");
    expect(html).toContain("#7 ·");
  });

  it("exposes workspace, repo, and severity filter controls populated from the facets", () => {
    const events = sampleEvents();
    const html = renderToStaticMarkup(
      <AgentFlightRecorderView
        events={events}
        totalCount={events.length}
        facets={collectFlightRecorderFacets(events)}
        filter={{}}
        {...noopFilter}
      />,
    );
    expect(html).toContain('data-testid="filter-workspace"');
    expect(html).toContain('data-testid="filter-repo"');
    expect(html).toContain('data-testid="filter-severity-error"');
    // Repo facet from the cross-repo conflict shows as an option.
    expect(html).toContain("auth-svc");
  });

  it("shows the filtered subset with an 'N of M' count when a filter is applied", () => {
    const events = sampleEvents();
    const filter = { severity: "error" as const };
    const filtered = filterFlightRecorderEvents(events, filter);
    const html = renderToStaticMarkup(
      <AgentFlightRecorderView
        events={filtered}
        totalCount={events.length}
        facets={collectFlightRecorderFacets(events)}
        filter={filter}
        {...noopFilter}
      />,
    );
    const rows = [...html.matchAll(/data-testid="flight-recorder-row"/g)];
    expect(rows).toHaveLength(1);
    expect(html).toContain("1 of 3 events");
  });

  it("renders a distinct empty state before any events vs. when filters exclude all", () => {
    const noneYet = renderToStaticMarkup(
      <AgentFlightRecorderView events={[]} totalCount={0} facets={{ workspaces: [], repos: [], severities: [] }} filter={{}} {...noopFilter} />,
    );
    expect(noneYet).toContain("No runtime events yet.");

    const events = sampleEvents();
    const filteredOut = renderToStaticMarkup(
      <AgentFlightRecorderView
        events={[]}
        totalCount={events.length}
        facets={collectFlightRecorderFacets(events)}
        filter={{ severity: "info" }}
        {...noopFilter}
      />,
    );
    expect(filteredOut).toContain("No events match the current filters.");
  });
});
