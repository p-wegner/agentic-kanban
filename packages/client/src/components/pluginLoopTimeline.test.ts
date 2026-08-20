import { describe, expect, it } from "vitest";
import { collapseTimelineEvents, timelineCategory, type LoopEvent } from "./PluginLoopExtras.js";

/**
 * #448 — the live mealplan gate's timeline was ~90% monitor heartbeat: the same
 * "Advanced: nothing planned" every ~4 minutes, 50 rows deep, which pushed every real event
 * out of the window at exactly the moment a human was deciding.
 */

const NOTE = "Step 7/9 (Test & QA (plan + execution)) v1 awaits your review — 8 of 50 acceptance criteria are UNEXECUTED";

function advance(id: string, createdAt: string, extra: Record<string, unknown> = {}): LoopEvent {
  return { id, type: "advance", createdAt, payload: { created: [], note: NOTE, ...extra } };
}

describe("collapseTimelineEvents", () => {
  it("folds a run of identical legacy advances (no repeatCount) into one row", () => {
    const rows = collapseTimelineEvents([
      advance("e3", "2026-08-13T09:50:00.000Z"),
      advance("e2", "2026-08-13T09:46:00.000Z"),
      advance("e1", "2026-08-12T20:50:00.000Z"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      count: 3,
      createdAt: "2026-08-13T09:50:00.000Z",
      firstSeenAt: "2026-08-12T20:50:00.000Z",
    });
    expect(rows[0].summary).toContain("Advanced: nothing planned");
  });

  it("honours a server-collapsed row's repeatCount and firstSeenAt", () => {
    const rows = collapseTimelineEvents([
      advance("e1", "2026-08-13T09:50:00.000Z", { repeatCount: 47, firstSeenAt: "2026-08-12T20:50:00.000Z" }),
    ]);
    expect(rows[0]).toMatchObject({ count: 47, firstSeenAt: "2026-08-12T20:50:00.000Z" });
  });

  it("adds server-collapsed and legacy runs of the same summary together", () => {
    const rows = collapseTimelineEvents([
      advance("e2", "2026-08-13T09:50:00.000Z", { repeatCount: 47, firstSeenAt: "2026-08-13T02:00:00.000Z" }),
      advance("e1", "2026-08-13T01:56:00.000Z"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 48, firstSeenAt: "2026-08-13T01:56:00.000Z" });
  });

  it("never merges across a different event, so the real history survives", () => {
    const rows = collapseTimelineEvents([
      advance("e4", "2026-08-13T09:50:00.000Z"),
      { id: "e3", type: "gate-reached", createdAt: "2026-08-13T09:00:00.000Z", payload: { question: "Approve step 7/9?" } },
      advance("e2", "2026-08-13T08:50:00.000Z"),
      advance("e1", "2026-08-13T08:46:00.000Z"),
    ]);
    expect(rows.map((r) => [r.type, r.count])).toEqual([
      ["advance", 1],
      ["gate-reached", 1],
      ["advance", 2],
    ]);
  });

  it("keeps advances whose note differs apart — a changed plan is not heartbeat", () => {
    const rows = collapseTimelineEvents([
      advance("e2", "2026-08-13T09:50:00.000Z"),
      advance("e1", "2026-08-13T09:46:00.000Z", { note: "Step 8/9 awaits your review" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("treats a single event as count 1 with firstSeenAt === createdAt", () => {
    const rows = collapseTimelineEvents([advance("e1", "2026-08-13T09:50:00.000Z")]);
    expect(rows[0]).toMatchObject({ count: 1, firstSeenAt: "2026-08-13T09:50:00.000Z" });
    expect(collapseTimelineEvents([])).toEqual([]);
  });

  it("ignores a nonsensical repeatCount rather than rendering '×0'", () => {
    const rows = collapseTimelineEvents([advance("e1", "2026-08-13T09:50:00.000Z", { repeatCount: 0 })]);
    expect(rows[0].count).toBe(1);
  });
});

describe("timelineCategory", () => {
  it("sorts the event types into the filter chips", () => {
    expect(timelineCategory("advance")).toBe("advances");
    expect(timelineCategory("gate-reached")).toBe("gates");
    expect(timelineCategory("gate-recommendation-skipped")).toBe("gates");
    expect(timelineCategory("gate-resolved")).toBe("decisions");
    expect(timelineCategory("converged")).toBe("decisions");
    expect(timelineCategory("something-new")).toBe("other");
  });
});
