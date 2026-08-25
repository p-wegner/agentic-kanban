// #879 — worker build staleness made visible, without ever collapsing the two directions.
//
// The traps this pins, from the ticket:
//  * never a bare "outdated": a worker AHEAD of the board is a normal dev-machine state,
//    so the two directions carry distinct words;
//  * an absent version stays unknown — never 0, never "current". The registry keeps
//    "we assumed 1" and "it said 1" apart, and the comparator must not launder an
//    absence into a verdict.
import { describe, expect, it } from "vitest";
import {
  compareWorkerBuild,
  formatBuildFreshness,
} from "../src/lib/worker-build-freshness.js";

describe("compareWorkerBuild — the two directions stay distinct", () => {
  it("calls an older worker behind-board", () => {
    expect(compareWorkerBuild("0.1.8", "0.1.9")).toBe("behind-board");
    expect(compareWorkerBuild("0.0.20", "0.1.0")).toBe("behind-board");
  });

  it("calls a newer worker ahead-of-board, NOT behind and NOT a bare 'outdated'", () => {
    expect(compareWorkerBuild("0.2.0", "0.1.9")).toBe("ahead-of-board");
    expect(compareWorkerBuild("1.0.0", "0.9.9")).toBe("ahead-of-board");
  });

  it("calls identical builds in-sync, dev stamps included", () => {
    expect(compareWorkerBuild("0.1.9", "0.1.9")).toBe("in-sync");
    expect(compareWorkerBuild("0.1.9-dev.abc1234", "0.1.9-dev.abc1234")).toBe("in-sync");
  });

  it("orders a pack-worker dev stamp BELOW its release, per semver", () => {
    // scripts/pack-worker.mjs stamps `<version>-dev.<sha>`; that prerelease precedes the
    // release it was cut toward.
    expect(compareWorkerBuild("0.1.9-dev.abc1234", "0.1.9")).toBe("behind-board");
    expect(compareWorkerBuild("0.1.9", "0.1.9-dev.abc1234")).toBe("ahead-of-board");
  });

  it("refuses to order two DIFFERENT dev stamps on the same base — unknown, not a guess", () => {
    expect(compareWorkerBuild("0.1.9-dev.aaa1111", "0.1.9-dev.bbb2222")).toBe("unknown");
  });

  it("an absent version on EITHER side is unknown — never in-sync, never a direction", () => {
    expect(compareWorkerBuild(undefined, "0.1.9")).toBe("unknown");
    expect(compareWorkerBuild("0.1.9", undefined)).toBe("unknown");
    expect(compareWorkerBuild(null, null)).toBe("unknown");
    expect(compareWorkerBuild("", "0.1.9")).toBe("unknown");
  });

  it("an unparseable version is unknown, unless the strings match exactly", () => {
    expect(compareWorkerBuild("not-a-version", "0.1.9")).toBe("unknown");
    expect(compareWorkerBuild("weird-build", "weird-build")).toBe("in-sync");
  });
});

describe("formatBuildFreshness — one wording for the panel and the CLI", () => {
  it("names each direction distinctly and includes the board's build when known", () => {
    expect(formatBuildFreshness("behind-board", "0.1.9")).toBe("behind board (board runs 0.1.9)");
    expect(formatBuildFreshness("ahead-of-board", "0.1.9")).toBe("ahead of board (board runs 0.1.9)");
    expect(formatBuildFreshness("behind-board")).toBe("behind board");
  });

  it("prints NOTHING for in-sync and unknown — '?' rendering stays with the caller", () => {
    expect(formatBuildFreshness("in-sync", "0.1.9")).toBeNull();
    expect(formatBuildFreshness("unknown", "0.1.9")).toBeNull();
    expect(formatBuildFreshness(undefined, "0.1.9")).toBeNull();
  });

  it("never says 'outdated' or 'current' — the words the ticket forbids", () => {
    for (const freshness of ["behind-board", "ahead-of-board", "in-sync", "unknown"] as const) {
      const label = formatBuildFreshness(freshness, "0.1.9");
      if (label !== null) {
        expect(label).not.toMatch(/outdated/i);
        expect(label).not.toMatch(/current/i);
      }
    }
  });
});
