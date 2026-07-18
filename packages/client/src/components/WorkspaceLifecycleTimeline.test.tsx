import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceLifecycleTimelineView } from "./WorkspaceLifecycleTimeline.js";
import { deriveWorkspaceLifecycle } from "../lib/workspaceLifecyclePhases.js";

const T0 = Date.parse("2026-07-18T10:00:00.000Z");
const MIN = 60_000;
const at = (m: number) => new Date(T0 + m * MIN).toISOString();

describe("WorkspaceLifecycleTimelineView", () => {
  it("renders an ordered segment per phase with duration legend for a merged workspace", () => {
    const lifecycle = deriveWorkspaceLifecycle(
      {
        createdAt: at(0),
        setup: { startedAt: at(1), endedAt: at(3) },
        sessions: [
          { startedAt: at(3), endedAt: at(20), triggerType: "agent" },
          { startedAt: at(22), endedAt: at(25), triggerType: "review" },
        ],
        mergedAt: at(30),
      },
      T0 + 40 * MIN,
    );
    const html = renderToStaticMarkup(<WorkspaceLifecycleTimelineView lifecycle={lifecycle} />);

    // One segment per phase, in order.
    const segments = html.match(/data-phase="([a-z]+)"/g) ?? [];
    expect(segments).toEqual([
      'data-phase="created"',
      'data-phase="setup"',
      'data-phase="building"',
      'data-phase="review"',
    ]);
    // Terminal state + legend labels present.
    expect(html).toContain('data-terminal="merged"');
    expect(html).toContain("merged");
    expect(html).toContain("Building");
    expect(html).toContain("Review");
  });

  it("flags the ongoing phase for a running workspace", () => {
    const lifecycle = deriveWorkspaceLifecycle(
      {
        createdAt: at(0),
        setup: { startedAt: at(1), endedAt: null },
        sessions: [],
      },
      T0 + 5 * MIN,
    );
    const html = renderToStaticMarkup(<WorkspaceLifecycleTimelineView lifecycle={lifecycle} />);
    expect(html).toContain('data-terminal="ongoing"');
    expect(html).toContain('data-ongoing="true"');
    expect(html).toContain("in flight");
  });

  it("overlays per-repo merge markers for a multi-repo workspace", () => {
    const lifecycle = deriveWorkspaceLifecycle(
      {
        createdAt: at(0),
        sessions: [{ startedAt: at(1), endedAt: at(10), triggerType: "agent" }],
        mergedAt: at(12),
        repoMarkers: [
          { name: "leading", merged: true, stranded: false },
          { name: "auth-svc", merged: false, stranded: true },
        ],
      },
      T0 + 20 * MIN,
    );
    const html = renderToStaticMarkup(<WorkspaceLifecycleTimelineView lifecycle={lifecycle} />);
    expect(html).toContain('data-testid="lifecycle-repo-markers"');
    expect(html).toContain("auth-svc");
    expect(html).toContain('data-repo-state="merged"');
    expect(html).toContain('data-repo-state="stranded"');
  });

  it("renders an empty-state hint when there is no measurable span", () => {
    const lifecycle = deriveWorkspaceLifecycle({ createdAt: at(0), sessions: [] }, T0);
    const html = renderToStaticMarkup(<WorkspaceLifecycleTimelineView lifecycle={lifecycle} />);
    expect(html).toContain('data-testid="lifecycle-timeline-empty"');
  });
});
