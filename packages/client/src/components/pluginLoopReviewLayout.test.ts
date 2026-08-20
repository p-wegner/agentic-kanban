import { describe, expect, it } from "vitest";
import { gateFindHints, gateInitialFind, loopPaneLayoutClasses } from "./PluginActionPanes.js";
import type { PluginCheck } from "./PluginLoopExtras.js";

/**
 * The live `mealplan` step-7 gate, as measured on 2026-08-13 — the shape every one of these
 * behaviours was filed against.
 */
const LIVE_CHECKS: PluginCheck[] = [
  {
    name: "QA classification (step 7)",
    verdict: "fail",
    detail: "STORY-2-1 Sz.3 is recorded `auto` while Finding F3 says 'not verifiable'",
  },
  { name: "Acceptance execution", verdict: "warn", detail: "8 of 50 acceptance criteria are UNEXECUTED" },
  { name: "Artifacts present", verdict: "pass", detail: "status.md and test_plan.md exist" },
];

describe("gateFindHints (#457 → #452)", () => {
  it("offers the identifiers the blocking checks quote, in order", () => {
    const hints = gateFindHints(LIVE_CHECKS);
    expect(hints).toContain("STORY-2-1");
    expect(hints).toContain("F3");
  });

  it("ignores passing checks — they name nothing the reviewer has to find", () => {
    // `status.md` / `test_plan.md` come only from the passing check.
    const hints = gateFindHints(LIVE_CHECKS);
    expect(hints.some((h) => h.includes(".md"))).toBe(false);
  });

  it("dedupes across checks and caps the row", () => {
    const repeated: PluginCheck[] = [
      { name: "a", verdict: "fail", detail: "STORY-2-1 is wrong" },
      { name: "b", verdict: "warn", detail: "STORY-2-1 again, plus STORY-9-9" },
    ];
    expect(gateFindHints(repeated)).toEqual(["STORY-2-1", "STORY-9-9"]);
    expect(gateFindHints(repeated, 1)).toEqual(["STORY-2-1"]);
  });

  it("returns nothing when there are no checks at all", () => {
    expect(gateFindHints(null)).toEqual([]);
    expect(gateFindHints(undefined)).toEqual([]);
  });
});

describe("gateInitialFind (#457 → #452)", () => {
  it("opens on the first token a FAILED check quotes", () => {
    expect(gateInitialFind(LIVE_CHECKS)).toBe("STORY-2-1");
  });

  it("does not arm on a warn-only gate — a warning is a summary, not a location", () => {
    const warnOnly = LIVE_CHECKS.filter((c) => c.verdict !== "fail");
    expect(gateInitialFind(warnOnly)).toBeUndefined();
  });

  it("stays undefined when a failing check quotes nothing addressable", () => {
    expect(gateInitialFind([{ name: "x", verdict: "fail", detail: "the document disagrees with itself" }]))
      .toBeUndefined();
  });
});

describe("loopPaneLayoutClasses (#447 split review)", () => {
  it("is today's single scrolling column when no artifact is open", () => {
    const { pane, decisionColumn } = loopPaneLayoutClasses(false);
    expect(pane).toBe("p-3 sm:p-6 space-y-4 overflow-y-auto");
    expect(decisionColumn).toBe("space-y-4");
    expect(pane).not.toContain("lg:");
  });

  it("splits into two SIBLING scrollers at lg once an artifact is open", () => {
    const { pane, decisionColumn } = loopPaneLayoutClasses(true);
    // The pane itself stops scrolling — that is what removes the nesting the ticket measured.
    expect(pane).toContain("lg:overflow-hidden");
    expect(pane).toContain("lg:flex-row");
    // …and the decision column becomes the scroller on its side, so Approve/Revise stay
    // reachable while the artifact scrolls independently.
    expect(decisionColumn).toContain("lg:overflow-y-auto");
    expect(decisionColumn).toContain("lg:shrink-0");
  });

  it("changes nothing below lg — the sub-sm sheet (#434) was a measured fix", () => {
    const { pane, decisionColumn } = loopPaneLayoutClasses(true);
    const stacked = loopPaneLayoutClasses(false);
    const withoutLg = (classes: string) =>
      classes.split(" ").filter((c) => !c.startsWith("lg:") && !c.startsWith("xl:")).join(" ");
    expect(withoutLg(pane)).toBe(stacked.pane);
    expect(withoutLg(decisionColumn)).toBe(stacked.decisionColumn);
  });
});
