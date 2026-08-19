import { describe, expect, it } from "vitest";
import {
  emptyPassReport,
  formatPassReport,
  passReasonCounts,
  recordActed,
  recordSkipped,
  type PassReport,
} from "./pass-report.js";

describe("PassReport (#592)", () => {
  it("counts acted and skipped separately and keeps decision order", () => {
    const report = emptyPassReport(3);
    recordActed(report, "ws-1", "closed");
    recordSkipped(report, "ws-2", "still-running");
    recordActed(report, "ws-3", "closed");
    expect(report).toEqual<PassReport>({
      scanned: 3,
      acted: 2,
      skipped: 1,
      reasons: [
        { id: "ws-1", reason: "closed" },
        { id: "ws-2", reason: "still-running" },
        { id: "ws-3", reason: "closed" },
      ],
    });
  });

  // The point of tracking the remainder: a pass that scanned 9 and classified 7 swallowed
  // 2 failures, and a report that only prints acted/skipped reads as a clean run.
  it("names the unaccounted-for remainder in the log line", () => {
    const report = emptyPassReport(9);
    recordActed(report, "a", "landed");
    recordActed(report, "b", "landed");
    for (const id of ["c", "d", "e", "f", "g"]) recordSkipped(report, id, "held");
    expect(formatPassReport("incoming", report)).toBe(
      "[incoming] scanned 9, acted 2, skipped 5, 2 unaccounted",
    );
  });

  it("omits the remainder when everything is accounted for", () => {
    const report = emptyPassReport(1);
    recordSkipped(report, "only", "nothing-to-do");
    expect(formatPassReport("reaper", report)).toBe("[reaper] scanned 1, acted 0, skipped 1");
  });

  it("groups reasons for a digest", () => {
    const report = emptyPassReport(4);
    recordActed(report, "a", "closed");
    recordActed(report, "b", "closed");
    recordSkipped(report, "c", "held");
    recordSkipped(report, "d", "held");
    expect(passReasonCounts(report)).toEqual({ closed: 2, held: 2 });
  });

  it("an empty pass is a valid report, not an absence of one", () => {
    const report = emptyPassReport();
    expect(formatPassReport("noop", report)).toBe("[noop] scanned 0, acted 0, skipped 0");
    expect(passReasonCounts(report)).toEqual({});
  });
});
