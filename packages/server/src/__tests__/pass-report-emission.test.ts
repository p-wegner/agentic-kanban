// #689/#718. `PassReport` (#592) was adopted by five passes, and every one of them BUILT the
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

// @gate:always-run — the caller guard at the bottom walks the server source tree; it
// imports nothing it checks.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { importedBindingsFrom, walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";

vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return { db, writeDb: db, rawClient: undefined, rawWriteClient: undefined, schema: schemaMod, withDbRetry: <T>(fn: () => Promise<T>) => fn() };
});

import { db } from "../db/index.js";
import { emptyPassReport, formatPassReportBody, recordActed, recordSkipped } from "../lib/pass-report.js";
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

  it("carries no tag of its own, because the CALLER owns the tag (#718)", () => {
    const report = emptyPassReport(0);

    expect(formatPassReportBody(report)).toBe("scanned 0, acted 0, skipped 0");
    // No tag of its own is what makes it safe to hand to a `log` that already applies one
    // (#616), and what makes `console.log(`[tag] ${body}`)` — a literal first argument, the
    // only shape `console-tag-ratchet.test.ts` accepts — the direct-logging form. A doubled
    // `[tag] [tag]` prefix is the regression. The tagged wrapper that used to sit beside it
    // fitted neither call site and had 0 production callers; see pass-report.ts.
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

/**
 * #718: the tagged `formatPassReport` wrapper existed only to satisfy a guard, had zero
 * production callers, and no ratchet noticed — because nothing cross-checked that a helper a
 * guard forced into existence is actually reachable from production code.
 *
 * This is that cross-check, scoped to the one module rather than to all of `lib/`: every
 * exported function in `lib/pass-report.ts` must be imported by at least one non-test file
 * under `packages/server/src`. Scoped deliberately — a general "every `lib/` export has a
 * caller" rule would also flag the legitimately-unused-today exports of a barrel or a codec,
 * so it belongs in its own ticket with its own exemption list. Here the rule is exact: a pass
 * report exists to be BUILT and EMITTED by passes, so an export nothing builds or emits with
 * is dead.
 */
describe("every pass-report export has a production caller (#718)", () => {
  const serverSrc = path.resolve(import.meta.dirname!, "..");
  const exported = [
    ...fs
      .readFileSync(path.join(serverSrc, "lib", "pass-report.ts"), "utf8")
      .matchAll(/^export function (\w+)/gm),
  ].map((m) => m[1]!);

  /**
   * Exports with no production caller that are NOT the #718 defect, each with the reason.
   * Shrink-only: the companion test below fails when an entry stops being true.
   */
  const TEST_FACING_ONLY: Record<string, string> = {
    // A digest/grouping helper. Unlike the deleted `formatPassReport`, nothing PREVENTS a
    // production caller — the monitor digest it was written for (#592) just has not adopted
    // it yet — and it earns its keep meanwhile as the compact way a sweep's test asserts the
    // reasons it recorded (see agent-session-registry-reaper.test.ts).
    passReasonCounts: "digest helper; used by sweep tests, no monitor consumer yet",
  };

  const callers = new Map<string, string[]>();
  for (const file of walkPackageSources(serverSrc)) {
    if (file.endsWith(path.join("lib", "pass-report.ts"))) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const binding of importedBindingsFrom(source, /pass-report\.js$/)) {
      const rel = path.relative(serverSrc, file).replaceAll("\\", "/");
      callers.set(binding, [...(callers.get(binding) ?? []), rel]);
    }
  }

  it("finds the exports at all, so the scan cannot pass vacuously", () => {
    expect(exported).toContain("formatPassReportBody");
    expect(exported.length).toBeGreaterThanOrEqual(4);
  });

  it.each(exported.filter((n) => !(n in TEST_FACING_ONLY)))(
    "%s is imported by production code",
    (name) => {
      expect(
        callers.get(name) ?? [],
        `lib/pass-report.ts exports ${name}, but no non-test file under packages/server/src ` +
          `imports it. Either give it a caller or delete it — a helper a guard forced into ` +
          `existence with no reachable call site is the #591/#705/#718 defect.`,
      ).not.toHaveLength(0);
    },
  );

  // The exemption must invalidate itself, or it becomes the same blind spot one level up: a
  // stale entry permanently excuses an export that has since grown a caller (the
  // provider-pair-parity / compareRatchet rule — a baseline nobody lowers is a budget).
  it.each(Object.keys(TEST_FACING_ONLY))(
    "%s is still test-facing only, or the exemption is stale",
    (name) => {
      expect(exported, `${name} is no longer exported — drop it from TEST_FACING_ONLY.`).toContain(name);
      expect(
        callers.get(name) ?? [],
        `${name} now has a production caller (${(callers.get(name) ?? []).join(", ")}) — ` +
          `remove it from TEST_FACING_ONLY so it is guarded like the rest.`,
      ).toHaveLength(0);
    },
  );
});
