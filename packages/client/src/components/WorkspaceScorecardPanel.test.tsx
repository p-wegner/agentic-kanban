import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceScorecardPanel } from "./WorkspaceScorecardPanel.js";
import type { ScorecardResult } from "./WorkspaceCard.js";

const scorecard: ScorecardResult = {
  total: 72,
  computedAt: new Date("2026-06-25T00:00:00.000Z").toISOString(),
  dimensions: [
    { name: "Tests", score: 8, maxScore: 10, signal: "8 of 10 suites green" },
  ],
};

// Walk a rendered React element tree and collect every props object so a test
// can locate a specific element (e.g. the toggle button) without a DOM.
function collectProps(node: unknown, acc: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const child of node) collectProps(child, acc);
    return acc;
  }
  const el = node as { props?: { children?: unknown } & Record<string, unknown> };
  if (el.props) {
    acc.push(el.props);
    collectProps(el.props.children, acc);
  }
  return acc;
}

describe("WorkspaceScorecardPanel", () => {
  it("renders the score and dimensions when expanded", () => {
    const html = renderToStaticMarkup(
      <WorkspaceScorecardPanel
        wsId="ws-1"
        scorecard={scorecard}
        expandedScorecards={{ "ws-1": true }}
        setExpandedScorecards={() => {}}
      />,
    );

    expect(html).toContain("72/100");
    expect(html).toContain("Scorecard");
    expect(html).toContain("Tests");
    expect(html).toContain("8 of 10 suites green");
  });

  it("hides the dimensions when collapsed", () => {
    const html = renderToStaticMarkup(
      <WorkspaceScorecardPanel
        wsId="ws-1"
        scorecard={scorecard}
        expandedScorecards={{}}
        setExpandedScorecards={() => {}}
      />,
    );

    expect(html).toContain("72/100");
    expect(html).not.toContain("8 of 10 suites green");
  });

  it("stops the toggle click from propagating to the parent card while still toggling (#921)", () => {
    const setExpandedScorecards = vi.fn();
    const element = WorkspaceScorecardPanel({
      wsId: "ws-1",
      scorecard,
      expandedScorecards: {},
      setExpandedScorecards,
    });

    // The header toggle button is the only element with an onClick handler.
    const withOnClick = collectProps(element).filter((p) => typeof p.onClick === "function");
    expect(withOnClick).toHaveLength(1);
    const onClick = withOnClick[0].onClick as (e: React.MouseEvent) => void;

    const stopPropagation = vi.fn();
    onClick({ stopPropagation } as unknown as React.MouseEvent);

    // Click must not bubble to WorkspaceCard's onClick (which closes the detail view)…
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    // …and must still flip this workspace's expanded state.
    expect(setExpandedScorecards).toHaveBeenCalledTimes(1);
    const updater = setExpandedScorecards.mock.calls[0][0] as (
      prev: Record<string, boolean>,
    ) => Record<string, boolean>;
    expect(updater({})).toEqual({ "ws-1": true });
  });
});
