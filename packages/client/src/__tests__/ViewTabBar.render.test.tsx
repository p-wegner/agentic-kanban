import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ViewTabBar } from "../components/ViewTabBar.js";
import { ANALYTICS_TABS } from "../lib/viewTabs.js";

/**
 * `ViewTabBar` had no test at all before #742 — the group-header rule it carried was a
 * stateful fold inside its JSX, so the only way to assert it was to render. The rule now
 * lives in `lib/viewTabGroups.ts` with its own pure tests; this pins the WIRING, which is
 * the half an extraction can silently break. No jsdom: the component is pure, so
 * `renderToStaticMarkup` is the right harness (the client's convention, upheld in #782).
 */
describe("ViewTabBar (static render)", () => {
  it("renders every tab's label, in order, with the group headers between them", () => {
    const html = renderToStaticMarkup(
      <ViewTabBar tabs={ANALYTICS_TABS} active="throughput" onSelect={() => {}} />,
    );
    const order = ANALYTICS_TABS.flatMap((t, i) =>
      t.group && t.group !== ANALYTICS_TABS[i - 1]?.group ? [t.group, t.label] : [t.label],
    );
    // A subsequence search alone would pass a bar that headers EVERY grouped tab, so
    // assert the header count too — verified: mutating the wiring to
    // `tabs.map((t) => ({ tab: t, groupHeader: t.group }))` fails on the counts below,
    // and removing the header render fails the sequence.
    expect(html.match(/>Flow</g)).toHaveLength(1);
    expect(html.match(/>Agents</g)).toHaveLength(1);
    let cursor = 0;
    for (const token of order) {
      const at = html.indexOf(`>${token}<`, cursor);
      expect(at, `expected ">${token}<" after index ${cursor} in:\n${html}`).toBeGreaterThan(-1);
      cursor = at + 1;
    }
    expect(order).toEqual([
      "Flow", "Throughput", "Lead Time", "Burndown",
      "Agents", "Provider Mix", "Cost", "Leaderboard", "Scores",
    ]);
  });

  it("marks exactly the active tab as selected", () => {
    const html = renderToStaticMarkup(
      <ViewTabBar tabs={ANALYTICS_TABS} active="burndown" onSelect={() => {}} />,
    );
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-selected="true"[^>]*>Burndown</);
  });
});
