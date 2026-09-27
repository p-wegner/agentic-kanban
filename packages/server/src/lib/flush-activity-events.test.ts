/**
 * Pure diff logic for the flush activity-log sweep (#1253, #1246 follow-up).
 */
import { describe, expect, it } from "vitest";
import {
  describeFlushActivityEvent,
  diffFlushActivityLog,
  emptyFlushActivityLogCursor,
  parseFlushActivityLogCursor,
} from "./flush-activity-events.js";
import type { FlushRecord } from "@agentic-kanban/shared/types";

function fixtureRecord(overrides: Partial<FlushRecord> = {}): FlushRecord {
  return {
    id: "flush/20260926-1",
    at: "2026-09-26T10:00:00.000Z",
    triggeredBy: "auto",
    memberIssueNumbers: [1200, 1201],
    memberBranches: ["feature/ak-1200-x", "feature/ak-1201-y"],
    landingSha: "abc123",
    tag: "flush/20260926-1",
    sweepTarget: "rc/20260926",
    state: "flushed",
    openHealTickets: [],
    updatedAt: "2026-09-26T10:00:00.000Z",
    ...overrides,
  };
}

describe("diffFlushActivityLog", () => {
  it("reports every flush as new against an empty cursor", () => {
    const flush = fixtureRecord();
    const { entries, nextCursor } = diffFlushActivityLog([flush], emptyFlushActivityLogCursor());
    expect(entries).toEqual([{ flush, state: "flushed", isNewFlush: true }]);
    expect(nextCursor.loggedStates).toEqual({ "flush/20260926-1": "flushed" });
  });

  it("reports nothing when the flush's state has not moved since the cursor", () => {
    const flush = fixtureRecord({ state: "sweeping" });
    const cursor = { loggedStates: { "flush/20260926-1": "sweeping" as const } };
    const { entries, nextCursor } = diffFlushActivityLog([flush], cursor);
    expect(entries).toEqual([]);
    expect(nextCursor.loggedStates).toEqual({ "flush/20260926-1": "sweeping" });
  });

  it("reports a transition when the flush's state moved past the cursor", () => {
    const flush = fixtureRecord({ state: "red" });
    const cursor = { loggedStates: { "flush/20260926-1": "sweeping" as const } };
    const { entries } = diffFlushActivityLog([flush], cursor);
    expect(entries).toEqual([{ flush, state: "red", isNewFlush: false }]);
  });

  it("diffs several flushes independently, each against its own cursor entry", () => {
    const a = fixtureRecord({ id: "flush/20260926-1", state: "healed" });
    const b = fixtureRecord({ id: "flush/20260927-1", state: "flushed" });
    const cursor = { loggedStates: { "flush/20260926-1": "healing" as const } };
    const { entries, nextCursor } = diffFlushActivityLog([a, b], cursor);
    expect(entries).toEqual([
      { flush: a, state: "healed", isNewFlush: false },
      { flush: b, state: "flushed", isNewFlush: true },
    ]);
    expect(nextCursor.loggedStates).toEqual({
      "flush/20260926-1": "healed",
      "flush/20260927-1": "flushed",
    });
  });

  it("stops tracking a flush id no longer present in the file", () => {
    const stillHere = fixtureRecord({ id: "flush/20260927-1", state: "flushed" });
    const cursor = {
      loggedStates: {
        "flush/20260926-1": "merged-back" as const,
        "flush/20260927-1": "flushed" as const,
      },
    };
    const { nextCursor } = diffFlushActivityLog([stillHere], cursor);
    expect(nextCursor.loggedStates).toEqual({ "flush/20260927-1": "flushed" });
  });
});

describe("parseFlushActivityLogCursor", () => {
  it("reads null/empty/garbage as an empty cursor", () => {
    expect(parseFlushActivityLogCursor(null)).toEqual(emptyFlushActivityLogCursor());
    expect(parseFlushActivityLogCursor("")).toEqual(emptyFlushActivityLogCursor());
    expect(parseFlushActivityLogCursor("not json")).toEqual(emptyFlushActivityLogCursor());
  });

  it("round-trips a stored cursor", () => {
    const cursor = { loggedStates: { "flush/20260926-1": "healing" as const } };
    expect(parseFlushActivityLogCursor(JSON.stringify(cursor))).toEqual(cursor);
  });
});

describe("describeFlushActivityEvent", () => {
  it("describes a new flush by its member count and sweep target", () => {
    const flush = fixtureRecord();
    expect(describeFlushActivityEvent({ flush, state: "flushed", isNewFlush: true }))
      .toBe("flush flush/20260926-1 started (2 member tickets, target rc/20260926)");
  });

  it("uses singular 'ticket' for one member", () => {
    const flush = fixtureRecord({ memberIssueNumbers: [1200] });
    expect(describeFlushActivityEvent({ flush, state: "flushed", isNewFlush: true }))
      .toBe("flush flush/20260926-1 started (1 member ticket, target rc/20260926)");
  });

  it("describes a transition as an arrow", () => {
    const flush = fixtureRecord({ state: "red" });
    expect(describeFlushActivityEvent({ flush, state: "red", isNewFlush: false }))
      .toBe("flush flush/20260926-1 -> red");
  });
});
