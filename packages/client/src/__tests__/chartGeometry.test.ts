import { describe, expect, it } from "vitest";
import {
  chartBox,
  fmtChartDate,
  fmtUsd,
  showsTick,
  stackSegments,
  stackTotal,
  summarizeStacks,
} from "../lib/chartGeometry.js";
import { windowedChartPath } from "../hooks/useWindowedChartData.js";

/**
 * The pure half of the extracted chart shell (#732).
 *
 * Before the extraction none of this was tested — the arithmetic lived inline in four
 * `.tsx` components, and this package's convention is pure-function tests with no
 * `@testing-library/react` (see `hooks/useApiResource.ts`). Pulling the geometry and the
 * stacking into `lib/` is what makes them assertable at all, so the tests are part of the
 * extraction rather than an afterthought.
 */
describe("chartBox", () => {
  it("derives the plot area from the outer box and paddings", () => {
    const box = chartBox({ svgW: 760, svgH: 220, padX: 44 });
    expect(box.plotW).toBe(760 - 44 * 2);
    expect(box.plotH).toBe(220 - 12 - 32);
  });

  it("honours an explicit padTop/padBottom", () => {
    const box = chartBox({ svgW: 480, svgH: 200, padX: 20, padTop: 0, padBottom: 0 });
    expect(box.plotH).toBe(200);
    expect(box.plotW).toBe(440);
  });
});

describe("summarizeStacks", () => {
  const series = ["claude", "codex"];
  const points = [
    { date: "2026-08-20", values: { claude: 2, codex: 1 } },
    { date: "2026-08-21", values: { claude: 4 } },
  ];

  it("totals each series, the grand total, and the tallest stack", () => {
    const s = summarizeStacks(series, points)!;
    expect(s.totals).toEqual({ claude: 6, codex: 1 });
    expect(s.grandTotal).toBe(7);
    // Day one stacks to 3, day two to 4 — the axis maximum is the taller of the two.
    expect(s.maxStack).toBe(4);
  });

  it("treats a missing series value as zero rather than NaN", () => {
    const s = summarizeStacks(["claude", "copilot"], points)!;
    expect(s.totals.copilot).toBe(0);
    expect(Number.isNaN(s.grandTotal)).toBe(false);
  });

  it("is null when there is no series or no point", () => {
    expect(summarizeStacks([], points)).toBeNull();
    expect(summarizeStacks(series, [])).toBeNull();
  });

  it("only calls an all-zero window empty when the caller asks (cost vs count)", () => {
    const zeroes = [{ date: "2026-08-20", values: { claude: 0 } }];
    // Cost: $0 means nothing was recorded — empty.
    expect(summarizeStacks(["claude"], zeroes, { requireNonZeroTotal: true })).toBeNull();
    // Counts: a zero-workspace day is itself the answer — not empty.
    expect(summarizeStacks(["claude"], zeroes)).not.toBeNull();
  });

  it("floors the axis maximum when asked, so an all-zero count window reads 0..1", () => {
    const zeroes = [{ date: "2026-08-20", values: { claude: 0 } }];
    expect(summarizeStacks(["claude"], zeroes)!.maxStack).toBe(0);
    expect(summarizeStacks(["claude"], zeroes, { minMaxStack: 1 })!.maxStack).toBe(1);
  });
});

describe("stackSegments", () => {
  const box = { padTop: 10, plotH: 100 };

  it("stacks bottom-up: the first series sits on the baseline", () => {
    const segs = stackSegments(["a", "b"], { a: 1, b: 1 }, 2, box);
    expect(segs.map((s) => s.height)).toEqual([50, 50]);
    // Baseline is padTop + plotH = 110; `a` occupies 60..110, `b` sits on top of it.
    expect(segs[0].y).toBe(60);
    expect(segs[1].y).toBe(10);
  });

  it("returns zero heights instead of dividing by a zero maximum", () => {
    const segs = stackSegments(["a"], { a: 0 }, 0, box);
    expect(segs[0].height).toBe(0);
    expect(Number.isFinite(segs[0].y)).toBe(true);
  });

  it("stackTotal sums only the named series", () => {
    expect(stackTotal(["a", "b"], { a: 2, b: 3, c: 99 })).toBe(5);
  });
});

describe("showsTick", () => {
  it("labels every nth slot and always the last one", () => {
    const shown = [0, 1, 2, 3, 4].filter((i) => showsTick(i, 5, 2));
    expect(shown).toEqual([0, 2, 4]);
  });

  it("labels the last slot even when it is not on the modulus", () => {
    // Slot 3 of 4 is not a multiple of 2 in a 0-indexed run of 4 — but it is the last.
    expect(showsTick(3, 4, 2)).toBe(true);
  });
});

describe("fmtUsd", () => {
  it("collapses an exact zero rather than printing $0.00", () => {
    expect(fmtUsd(0)).toBe("$0");
    expect(fmtUsd(Number.NaN)).toBe("$0");
  });

  it("surfaces sub-cent spend that two decimals would hide as $0.00", () => {
    expect(fmtUsd(0.0004)).toBe("$0.0004");
  });

  it("uses two decimals above a cent", () => {
    expect(fmtUsd(12.345)).toBe("$12.35");
  });
});

describe("fmtChartDate", () => {
  it("renders a date key in the shared axis format, locale-explicitly", () => {
    // Explicit en-US (see client/CLAUDE.md): on a de-DE machine the OS locale would
    // otherwise render "22. Aug" inside an English UI.
    expect(fmtChartDate("2026-08-22")).toBe("Aug 22");
  });
});

describe("windowedChartPath", () => {
  it("composes the one query string all four charts use", () => {
    expect(windowedChartPath("/api/x", "p1", 30)).toBe("/api/x?projectId=p1&days=30");
  });

  it("encodes the project id", () => {
    expect(windowedChartPath("/api/x", "a b/c", 7)).toBe("/api/x?projectId=a%20b%2Fc&days=7");
  });
});
