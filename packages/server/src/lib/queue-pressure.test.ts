import { describe, expect, it } from "vitest";
import { computeQueuePressure, formatQueuePressure } from "./queue-pressure.js";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");

describe("computeQueuePressure", () => {
  it("reads an empty queue as zero depth and no oldest age", () => {
    const summary = computeQueuePressure({ members: [], ledgerRows: [], nowMs: NOW });
    expect(summary).toEqual({
      queueDepth: 0,
      oldestWaitingMs: null,
      arrivalsPerHour: 0,
      gateRunsPerHour: 0,
      windowMs: 60 * 60 * 1000,
    });
  });

  it("counts queue depth and the oldest waiting member's age", () => {
    const summary = computeQueuePressure({
      members: [
        { readySince: new Date(NOW - 48 * 60 * 1000).toISOString() },
        { readySince: new Date(NOW - 10 * 60 * 1000).toISOString() },
        { readySince: new Date(NOW - 90 * 60 * 1000).toISOString() },
      ],
      ledgerRows: [],
      nowMs: NOW,
    });
    expect(summary.queueDepth).toBe(3);
    expect(summary.oldestWaitingMs).toBe(90 * 60 * 1000);
  });

  it("ignores a member with an unparseable readySince rather than crashing", () => {
    const summary = computeQueuePressure({
      members: [{ readySince: "not-a-date" }, { readySince: new Date(NOW - 5 * 60 * 1000).toISOString() }],
      ledgerRows: [],
      nowMs: NOW,
    });
    expect(summary.queueDepth).toBe(2);
    expect(summary.oldestWaitingMs).toBe(5 * 60 * 1000);
  });

  it("rates arrivals and gate runs per hour independently over the trailing window", () => {
    const summary = computeQueuePressure({
      members: [],
      ledgerRows: [
        { at: new Date(NOW - 10 * 60 * 1000).toISOString(), isGateRun: true },
        { at: new Date(NOW - 20 * 60 * 1000).toISOString(), isGateRun: true },
        { at: new Date(NOW - 30 * 60 * 1000).toISOString(), isGateRun: false },
        { at: new Date(NOW - 40 * 60 * 1000).toISOString(), isGateRun: false },
        { at: new Date(NOW - 50 * 60 * 1000).toISOString(), isGateRun: false },
        // outside the 1h window — excluded
        { at: new Date(NOW - 90 * 60 * 1000).toISOString(), isGateRun: true },
      ],
      nowMs: NOW,
    });
    expect(summary.arrivalsPerHour).toBe(3);
    expect(summary.gateRunsPerHour).toBe(2);
  });

  it("scales the rate by a non-default window", () => {
    const summary = computeQueuePressure({
      members: [],
      ledgerRows: [
        { at: new Date(NOW - 5 * 60 * 1000).toISOString(), isGateRun: true },
        { at: new Date(NOW - 15 * 60 * 1000).toISOString(), isGateRun: true },
      ],
      nowMs: NOW,
      windowMs: 30 * 60 * 1000, // half an hour -> doubles the rate
    });
    expect(summary.arrivalsPerHour).toBe(0);
    expect(summary.gateRunsPerHour).toBe(4);
    expect(summary.windowMs).toBe(30 * 60 * 1000);
  });

  it("excludes a future-dated row and one right at the window edge is included", () => {
    const summary = computeQueuePressure({
      members: [],
      ledgerRows: [
        { at: new Date(NOW + 5000).toISOString(), isGateRun: false }, // future — excluded
        { at: new Date(NOW - 60 * 60 * 1000).toISOString(), isGateRun: false }, // exactly at the edge — included
      ],
      nowMs: NOW,
    });
    expect(summary.arrivalsPerHour).toBe(1);
  });
});

describe("formatQueuePressure", () => {
  it("renders the one-line summary", () => {
    const line = formatQueuePressure({
      queueDepth: 7,
      oldestWaitingMs: 48 * 60 * 1000,
      arrivalsPerHour: 3.2,
      gateRunsPerHour: 1.1,
      windowMs: 60 * 60 * 1000,
    });
    expect(line).toBe("queue 7 waiting, oldest 48 min, 3.2 arrivals/h vs 1.1 gates/h");
  });

  it("renders n/a when the queue is empty", () => {
    const line = formatQueuePressure({
      queueDepth: 0,
      oldestWaitingMs: null,
      arrivalsPerHour: 0,
      gateRunsPerHour: 0,
      windowMs: 60 * 60 * 1000,
    });
    expect(line).toBe("queue 0 waiting, oldest n/a, 0.0 arrivals/h vs 0.0 gates/h");
  });

  it("renders hours once past 60 minutes", () => {
    const line = formatQueuePressure({
      queueDepth: 1,
      oldestWaitingMs: 125 * 60 * 1000,
      arrivalsPerHour: 0.5,
      gateRunsPerHour: 0.2,
      windowMs: 60 * 60 * 1000,
    });
    expect(line).toBe("queue 1 waiting, oldest 2h5m, 0.5 arrivals/h vs 0.2 gates/h");
  });
});
