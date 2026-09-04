import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessShareBody } from "./HarnessShareSection.js";

describe("HarnessShareBody (#1032)", () => {
  it("renders the weekly share next to the configured budget", () => {
    const html = renderToStaticMarkup(
      <HarnessShareBody
        harnessShare={{ doneCount: 12, harnessCount: 3, sharePct: 25, windowDays: 7 }}
        configuredPct={34}
      />,
    );
    expect(html).toContain("harness share this week:");
    expect(html).toContain("25 %");
    expect(html).toContain("(3/12)");
    expect(html).toContain("budget 34 %");
    expect(html).not.toContain("text-amber");
  });

  it("flags a share above the configured budget", () => {
    const html = renderToStaticMarkup(
      <HarnessShareBody
        harnessShare={{ doneCount: 10, harnessCount: 6, sharePct: 60, windowDays: 7 }}
        configuredPct={34}
      />,
    );
    expect(html).toContain("60 %");
    expect(html).toContain("text-amber");
  });

  it("distinguishes 'nothing landed' (null share) from 0 %", () => {
    const html = renderToStaticMarkup(
      <HarnessShareBody
        harnessShare={{ doneCount: 0, harnessCount: 0, sharePct: null, windowDays: 7 }}
        configuredPct={34}
      />,
    );
    expect(html).toContain("no tickets landed");
    expect(html).not.toContain("0 %");
  });

  it("renders nothing when the read-off is unavailable, and a dash when the budget is unresolved", () => {
    expect(renderToStaticMarkup(<HarnessShareBody harnessShare={null} configuredPct={34} />)).toBe("");
    const html = renderToStaticMarkup(
      <HarnessShareBody
        harnessShare={{ doneCount: 4, harnessCount: 1, sharePct: 25, windowDays: 14 }}
        configuredPct={null}
      />,
    );
    expect(html).toContain("last 14 days");
    expect(html).toContain("budget —");
  });
});
