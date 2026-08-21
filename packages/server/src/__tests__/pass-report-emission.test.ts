// #689. `PassReport` (#592) was adopted by five passes, and every one of them BUILT the
// report and then returned it without ever printing it. The payload was write-only: the
// `scanned - acted - skipped` remainder — the single thing the shape exists to expose,
// because a candidate that threw is neither acted nor skipped — reached no log, so a pass
// that swallowed failures still read as a clean run in the server output.
//
// Two properties are worth pinning, and they fail differently:
//
//  - the FORMATTER names the remainder (a pure check, and the reason for the shape); and
//  - a pass actually EMITS it. That second one is what "write-only" meant, so a test that
//    only exercised the formatter would leave the defect exactly where it was.
//
// The emission check runs the born-blocked sweep against an empty database. Zero rows is
// deliberate: it isolates the summary line from any per-row logging, so the assertion can
// only pass if the pass emits a summary unconditionally — which is the behaviour that was
// missing.

import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return { db, writeDb: db, rawClient: undefined, rawWriteClient: undefined, schema: schemaMod, withDbRetry: <T>(fn: () => Promise<T>) => fn() };
});

import { db } from "../db/index.js";
import { emptyPassReport, formatPassReport, formatPassReportBody, recordActed, recordSkipped } from "../lib/pass-report.js";
import { reconcileBornBlockedWorkspaces } from "../startup/born-blocked-reconciler.js";

describe("the PassReport summary names the unaccounted remainder (#689)", () => {
  it("reports a candidate that was neither acted on nor skipped", () => {
    // Nine scanned, two acted, five skipped — the two that threw are the whole point.
    const report = emptyPassReport(9);
    recordActed(report, "ws-1", "closed");
    recordActed(report, "ws-2", "closed");
    for (const id of ["ws-3", "ws-4", "ws-5", "ws-6", "ws-7"]) recordSkipped(report, id, "hold");

    expect(formatPassReportBody(report)).toBe("scanned 9, acted 2, skipped 5, 2 unaccounted");
  });

  it("stays silent about a remainder when there is none, so the phrase means something", () => {
    const report = emptyPassReport(1);
    recordSkipped(report, "ws-1", "hold");

    expect(formatPassReportBody(report)).toBe("scanned 1, acted 0, skipped 1");
    expect(formatPassReportBody(report)).not.toContain("unaccounted");
  });

  it("tags exactly once, so a sweep with an injected logger can pass the body instead", () => {
    const report = emptyPassReport(0);

    expect(formatPassReport("worker-sweep", report)).toBe("[worker-sweep] scanned 0, acted 0, skipped 0");
    // The body carries no tag of its own — that is what makes it safe to hand to a `log`
    // that already applies one (#616). A doubled `[tag] [tag]` prefix is the regression.
    expect(formatPassReportBody(report)).not.toContain("[");
  });
});

describe("a pass EMITS its report rather than only building one (#689)", () => {
  it("logs the summary even when it scanned nothing", async () => {
    const lines: string[] = [];

    const result = await reconcileBornBlockedWorkspaces({
      database: db,
      log: (message) => lines.push(message),
    });

    expect(result.scanned).toBe(0);
    expect(
      lines,
      "the born-blocked sweep returned a PassReport but logged no summary — the #689 defect",
    ).toContain("scanned 0, acted 0, skipped 0");
  });
});
