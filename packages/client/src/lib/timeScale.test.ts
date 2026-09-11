import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  clipSpan,
  defaultPxPerMs,
  panBy,
  parseLocalDate,
  stepAnchor,
  ticksFor,
  tsAtOffset,
  viewportForFitAll,
  viewportForToday,
  windowFor,
  withScale,
  xOf,
  zoomAround,
  type Viewport,
} from "./timeScale.js";

function local(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime();
}

describe("windowFor — snaps to calendar boundaries", () => {
  it("snaps a day-scale window to midnight on both edges", () => {
    const viewport: Viewport = { scale: "day", anchor: local(2026, 3, 10, 14, 30), pxPerMs: defaultPxPerMs("day") };
    const w = windowFor(viewport, 1200);
    expect(new Date(w.min).getHours()).toBe(0);
    expect(new Date(w.min).getMinutes()).toBe(0);
    expect(new Date(w.max).getHours()).toBe(0);
    expect(w.min).toBeLessThan(w.max);
  });

  it("snaps a week-scale window to Monday", () => {
    const viewport: Viewport = { scale: "week", anchor: local(2026, 3, 11), pxPerMs: defaultPxPerMs("week") }; // a Wednesday
    const w = windowFor(viewport, 1200);
    expect(new Date(w.min).getDay()).toBe(1); // Monday
    expect(new Date(w.max).getDay()).toBe(1);
  });

  it("snaps a month-scale window to the 1st of the month", () => {
    const viewport: Viewport = { scale: "month", anchor: local(2026, 3, 17), pxPerMs: defaultPxPerMs("month") };
    const w = windowFor(viewport, 1200);
    expect(new Date(w.min).getDate()).toBe(1);
    expect(new Date(w.max).getDate()).toBe(1);
  });

  it("survives a DST spring-forward week without breaking Monday snapping", () => {
    // US DST 2026 starts 2026-03-08. A window anchored inside that week must still land on
    // Mondays even though the week itself is 23 hours long in local time.
    const viewport: Viewport = { scale: "week", anchor: local(2026, 3, 9), pxPerMs: defaultPxPerMs("week") };
    const w = windowFor(viewport, 800);
    expect(new Date(w.min).getDay()).toBe(1);
    expect(new Date(w.max).getDay()).toBe(1);
    expect(w.max).toBeGreaterThan(w.min);
  });
});

describe("ticksFor — two-band axis", () => {
  it("day scale: major ticks are day boundaries, minor ticks are 6-hourly", () => {
    const window = { min: local(2026, 6, 1), max: local(2026, 6, 4) };
    const { major, minor } = ticksFor(window, "day");
    expect(major.length).toBeGreaterThanOrEqual(3);
    for (const t of major) expect(new Date(t.ts).getHours()).toBe(0);
    expect(minor.length).toBeGreaterThan(major.length);
  });

  it("week scale: major ticks fall on Mondays", () => {
    const window = { min: local(2026, 6, 1), max: local(2026, 6, 29) };
    const { major } = ticksFor(window, "week");
    for (const t of major) expect(new Date(t.ts).getDay()).toBe(1);
  });

  it("month scale: major ticks fall on the 1st, labelled with the year", () => {
    const window = { min: local(2026, 1, 1), max: local(2026, 6, 1) };
    const { major } = ticksFor(window, "month");
    for (const t of major) expect(new Date(t.ts).getDate()).toBe(1);
    expect(major.some((t) => t.label.includes("2026"))).toBe(true);
  });

  it("quarter scale: major ticks land on quarter-start months, labelled Qn", () => {
    const window = { min: local(2025, 1, 1), max: local(2026, 12, 31) };
    const { major } = ticksFor(window, "quarter");
    for (const t of major) expect([0, 3, 6, 9]).toContain(new Date(t.ts).getMonth());
    expect(major.some((t) => /^Q[1-4] /.test(t.label))).toBe(true);
  });

  // #1099 R2: day/week labels omit the year by default (there's nothing to disambiguate within
  // one year), but a window straddling New Year's needs it on the tick where the year changes
  // — otherwise two ticks both reading e.g. "Dec 30"/"Jan 2" give no clue which belongs to which
  // year.
  it("day scale: no tick shows a year when the window stays within one year", () => {
    const window = { min: local(2026, 6, 1), max: local(2026, 6, 10) };
    const { major } = ticksFor(window, "day");
    for (const t of major) expect(t.label).not.toMatch(/\d{4}/);
  });

  it("day scale: shows the year only on the tick where the year changes", () => {
    const window = { min: local(2025, 12, 29), max: local(2026, 1, 3) };
    const { major } = ticksFor(window, "day");
    const withYear = major.filter((t) => /\d{4}/.test(t.label));
    expect(withYear).toHaveLength(1);
    expect(new Date(withYear[0].ts).getFullYear()).toBe(2026);
    expect(new Date(withYear[0].ts).getMonth()).toBe(0); // January
    expect(new Date(withYear[0].ts).getDate()).toBe(1);
  });

  it("week scale: shows the year only on the 'Week of' tick where the year changes", () => {
    const window = { min: local(2025, 12, 15), max: local(2026, 1, 20) };
    const { major } = ticksFor(window, "week");
    const withYear = major.filter((t) => /\d{4}/.test(t.label));
    expect(withYear.length).toBe(1);
    expect(new Date(withYear[0].ts).getFullYear()).toBe(2026);
  });
});

describe("zoomAround — keeps the focus point fixed and can switch scale", () => {
  it("keeps focusTs at roughly the same pixel offset after a small zoom step", () => {
    // `windowFor` snaps its displayed edges to calendar boundaries, so a zoom step can shift
    // the focus point by a fraction of one boundary unit even though the underlying anchor
    // math is exact (see the comment in `zoomAround`) — assert "did not jump", not
    // pixel-for-pixel identity.
    const trackPx = 1000;
    const viewport: Viewport = { scale: "month", anchor: local(2026, 1, 15), pxPerMs: defaultPxPerMs("month") };
    const focusTs = local(2026, 2, 15);
    const before = xOf(focusTs, windowFor(viewport, trackPx), trackPx);
    const zoomed = zoomAround(viewport, 1.1, focusTs, trackPx);
    const after = xOf(focusTs, windowFor(zoomed, trackPx), trackPx);
    expect(Math.abs(after - before)).toBeLessThan(trackPx * 0.15);
  });

  it("does not drift the stored anchor across repeated small zoom steps", () => {
    // Regression guard for snapping the ANCHOR itself on every zoom (rather than only the
    // displayed window) — that would round it towards a boundary every step and permanently
    // lose precision. Zooming in then back out by the inverse factor should return close to
    // the original anchor.
    const trackPx = 1000;
    const viewport: Viewport = { scale: "week", anchor: local(2026, 3, 12, 6), pxPerMs: defaultPxPerMs("week") };
    const focusTs = local(2026, 3, 20);
    let v = viewport;
    for (let i = 0; i < 5; i++) v = zoomAround(v, 1.05, focusTs, trackPx);
    for (let i = 0; i < 5; i++) v = zoomAround(v, 1 / 1.05, focusTs, trackPx);
    expect(Math.abs(v.anchor - viewport.anchor)).toBeLessThan(60_000); // within a minute of rounding noise
  });

  it("switches to a finer scale once zoomed in past the current scale's density ceiling", () => {
    const trackPx = 1000;
    let viewport: Viewport = { scale: "month", anchor: local(2026, 1, 1), pxPerMs: defaultPxPerMs("month") };
    const focusTs = local(2026, 1, 15);
    for (let i = 0; i < 40 && viewport.scale === "month"; i++) {
      viewport = zoomAround(viewport, 1.2, focusTs, trackPx);
    }
    expect(viewport.scale).toBe("week");
  });

  it("switches to a coarser scale once zoomed out past the current scale's density floor", () => {
    const trackPx = 1000;
    let viewport: Viewport = { scale: "week", anchor: local(2026, 1, 1), pxPerMs: defaultPxPerMs("week") };
    const focusTs = local(2026, 1, 15);
    for (let i = 0; i < 40 && viewport.scale === "week"; i++) {
      viewport = zoomAround(viewport, 0.8, focusTs, trackPx);
    }
    expect(viewport.scale).toBe("month");
  });

  it("clamps rather than switching past the finest scale (day)", () => {
    const trackPx = 1000;
    let viewport: Viewport = { scale: "day", anchor: local(2026, 1, 1), pxPerMs: defaultPxPerMs("day") };
    const focusTs = local(2026, 1, 2);
    for (let i = 0; i < 40; i++) viewport = zoomAround(viewport, 1.5, focusTs, trackPx);
    expect(viewport.scale).toBe("day");
  });

  it("clamps rather than switching past the coarsest scale (quarter)", () => {
    const trackPx = 1000;
    let viewport: Viewport = { scale: "quarter", anchor: local(2026, 1, 1), pxPerMs: defaultPxPerMs("quarter") };
    const focusTs = local(2026, 2, 1);
    for (let i = 0; i < 40; i++) viewport = zoomAround(viewport, 0.5, focusTs, trackPx);
    expect(viewport.scale).toBe("quarter");
  });
});

describe("stepAnchor — moves by one calendar unit of the current scale", () => {
  it("moves a day-scale viewport by one day", () => {
    const viewport: Viewport = { scale: "day", anchor: local(2026, 3, 10), pxPerMs: defaultPxPerMs("day") };
    const next = stepAnchor(viewport, 1);
    expect(next.anchor - viewport.anchor).toBe(DAY_MS);
  });

  it("moves a month-scale viewport by a calendar month, not a fixed 30 days", () => {
    // Feb 2026 has 28 days — stepping from Feb 1 to Mar 1 must not be a fixed offset.
    const viewport: Viewport = { scale: "month", anchor: local(2026, 2, 1), pxPerMs: defaultPxPerMs("month") };
    const next = stepAnchor(viewport, 1);
    expect(new Date(next.anchor).getMonth()).toBe(2); // March (0-indexed)
    expect(new Date(next.anchor).getDate()).toBe(1);
  });

  it("moves a quarter-scale viewport by three months", () => {
    const viewport: Viewport = { scale: "quarter", anchor: local(2026, 1, 1), pxPerMs: defaultPxPerMs("quarter") };
    const next = stepAnchor(viewport, 1);
    expect(new Date(next.anchor).getMonth()).toBe(3); // April = Q2 start
  });

  it("moves backward with direction -1", () => {
    const viewport: Viewport = { scale: "week", anchor: local(2026, 3, 9), pxPerMs: defaultPxPerMs("week") };
    const next = stepAnchor(viewport, -1);
    expect(next.anchor).toBeLessThan(viewport.anchor);
  });
});

describe("viewportForToday / viewportForFitAll", () => {
  it("centres today's viewport on `now`", () => {
    const now = local(2026, 5, 15, 12, 0);
    const trackPx = 1000;
    const pxPerMs = defaultPxPerMs("week");
    const viewport = viewportForToday("week", pxPerMs, trackPx, now);
    const w = windowFor(viewport, trackPx);
    expect(w.min).toBeLessThanOrEqual(now);
    expect(w.max).toBeGreaterThanOrEqual(now);
  });

  it("fits a wide data range into a coarser scale", () => {
    const dataMin = local(2024, 1, 1);
    const dataMax = local(2026, 1, 1);
    const viewport = viewportForFitAll(dataMin, dataMax, 1000);
    expect(viewport.scale).toBe("quarter");
    const w = windowFor(viewport, 1000);
    expect(w.min).toBeLessThanOrEqual(dataMin);
    expect(w.max).toBeGreaterThanOrEqual(dataMax);
  });

  it("fits a narrow data range into a finer scale", () => {
    const dataMin = local(2026, 6, 1);
    const dataMax = local(2026, 6, 5);
    const viewport = viewportForFitAll(dataMin, dataMax, 1000);
    expect(viewport.scale).toBe("day");
  });

  it("never produces a zero-length span for a single-instant data range", () => {
    const t = local(2026, 6, 1);
    const viewport = viewportForFitAll(t, t, 1000);
    const w = windowFor(viewport, 1000);
    expect(w.max).toBeGreaterThan(w.min);
  });
});

describe("withScale — re-anchors around a focus point when the scale tab changes", () => {
  it("keeps the focus timestamp inside the new window", () => {
    const trackPx = 1000;
    const viewport: Viewport = { scale: "week", anchor: local(2026, 3, 1), pxPerMs: defaultPxPerMs("week") };
    const focusTs = local(2026, 3, 10);
    const next = withScale(viewport, "month", focusTs, trackPx);
    expect(next.scale).toBe("month");
    const w = windowFor(next, trackPx);
    expect(w.min).toBeLessThanOrEqual(focusTs);
    expect(w.max).toBeGreaterThanOrEqual(focusTs);
  });

  it("is a no-op when the scale is unchanged", () => {
    const viewport: Viewport = { scale: "week", anchor: local(2026, 3, 1), pxPerMs: defaultPxPerMs("week") };
    expect(withScale(viewport, "week", local(2026, 3, 10), 1000)).toBe(viewport);
  });
});

describe("clipSpan — pixel geometry clipped to the visible window", () => {
  const window = { min: local(2026, 3, 1), max: local(2026, 3, 11) }; // 10 days
  const trackPx = 1000; // 100px/day

  it("returns full geometry for a span entirely inside the window", () => {
    const clipped = clipSpan(local(2026, 3, 2), local(2026, 3, 4), window, trackPx);
    expect(clipped).not.toBeNull();
    expect(clipped!.clippedStart).toBe(false);
    expect(clipped!.clippedEnd).toBe(false);
    expect(clipped!.x).toBeCloseTo(100, 0);
    expect(clipped!.width).toBeCloseTo(200, 0);
  });

  it("clips a span starting before the window to the left edge", () => {
    const clipped = clipSpan(local(2026, 2, 20), local(2026, 3, 3), window, trackPx);
    expect(clipped!.clippedStart).toBe(true);
    expect(clipped!.x).toBe(0);
  });

  it("clips a span ending after the window to the right edge", () => {
    const clipped = clipSpan(local(2026, 3, 9), local(2026, 3, 20), window, trackPx);
    expect(clipped!.clippedEnd).toBe(true);
    expect(clipped!.x + clipped!.width).toBeCloseTo(trackPx, 0);
  });

  it("returns null for a span entirely outside the window (no piling at an edge)", () => {
    expect(clipSpan(local(2026, 4, 1), local(2026, 4, 5), window, trackPx)).toBeNull();
    expect(clipSpan(local(2026, 1, 1), local(2026, 1, 5), window, trackPx)).toBeNull();
  });

  it("handles a due date before the created date (reversed span) without negative width", () => {
    const clipped = clipSpan(local(2026, 3, 5), local(2026, 3, 2), window, trackPx);
    expect(clipped).not.toBeNull();
    expect(clipped!.width).toBeGreaterThanOrEqual(0);
  });
});

describe("tsAtOffset — inverse of xOf, for cursor-relative zoom (#1099 R1)", () => {
  const window = { min: local(2026, 3, 1), max: local(2026, 3, 11) }; // 10 days
  const trackPx = 1000; // 100px/day

  it("resolves offset 0 to the window's start", () => {
    expect(tsAtOffset(window, 0, trackPx)).toBe(window.min);
  });

  it("resolves the full track width to the window's end", () => {
    expect(tsAtOffset(window, trackPx, trackPx)).toBe(window.max);
  });

  it("resolves the midpoint offset to the midpoint timestamp", () => {
    expect(tsAtOffset(window, trackPx / 2, trackPx)).toBeCloseTo((window.min + window.max) / 2, 0);
  });

  it("round-trips with xOf", () => {
    const ts = local(2026, 3, 4);
    expect(tsAtOffset(window, xOf(ts, window, trackPx), trackPx)).toBeCloseTo(ts, 0);
  });

  it("clamps an offset outside the track instead of extrapolating past the window", () => {
    expect(tsAtOffset(window, -50, trackPx)).toBe(window.min);
    expect(tsAtOffset(window, trackPx + 50, trackPx)).toBe(window.max);
  });
});

describe("panBy — shifts the anchor without touching scale or zoom (#1099 R1)", () => {
  it("dragging right (positive deltaPx) reveals earlier content", () => {
    const viewport: Viewport = { scale: "day", anchor: local(2026, 3, 10), pxPerMs: 0.01 };
    const panned = panBy(viewport, 100);
    expect(panned.anchor).toBeLessThan(viewport.anchor);
    expect(panned.scale).toBe(viewport.scale);
    expect(panned.pxPerMs).toBe(viewport.pxPerMs);
  });

  it("dragging left (negative deltaPx) reveals later content", () => {
    const viewport: Viewport = { scale: "day", anchor: local(2026, 3, 10), pxPerMs: 0.01 };
    const panned = panBy(viewport, -100);
    expect(panned.anchor).toBeGreaterThan(viewport.anchor);
  });

  it("moves the anchor by exactly deltaPx / pxPerMs", () => {
    const viewport: Viewport = { scale: "day", anchor: local(2026, 3, 10), pxPerMs: 0.01 };
    const panned = panBy(viewport, 250);
    expect(viewport.anchor - panned.anchor).toBeCloseTo(250 / 0.01, 5);
  });
});

describe("parseLocalDate", () => {
  it("parses a YYYY-MM-DD string as local midnight, not UTC midnight", () => {
    const d = parseLocalDate("2026-03-15");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(0);
  });

  it("falls back to native parsing for a full ISO timestamp", () => {
    const iso = "2026-03-15T12:30:00.000Z";
    expect(parseLocalDate(iso).getTime()).toBe(new Date(iso).getTime());
  });
});
