// @covers review-merge.merge.gate-verify [measurement]
/**
 * #1234 — the miss-rate JOIN: a sweep's red suites against the gate rows of the merges landed
 * since the last green sweep, written to the `.test-impact/misses.jsonl` sidecar.
 *
 * The property worth pinning is the classification: a red suite that at least one intervening
 * gate did NOT run is a `miss` naming exactly those gates; one that every intervening gate DID
 * run is `flake-or-environment`; a green after reds is a `heal`. Getting any of these wrong
 * silently moves the miss rate in the direction that promotes the selector.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MISSES_RELATIVE_PATH,
  computeSweepJoinRows,
  gateRanSuite,
  openRedSuites,
  recordSweepJoin,
  rowsInWindow,
  type LedgerRow,
  type SweepJoinRow,
} from "../services/test-impact-misses.js";
import { OUTCOMES_RELATIVE_PATH } from "../services/test-impact-outcome.service.js";

const A = "packages/server/src/__tests__/a.test.ts";
const B = "packages/server/src/__tests__/b.test.ts";
const GUARD = "packages/server/src/__tests__/some-ratchet.test.ts";

/** Full shas of the three merges in `lastGreen..red`, in git-log order (newest first). */
const COMMITS = ["c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3", "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2", "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"];

const gateRow = (over: Partial<LedgerRow>): LedgerRow => ({
  at: "2026-09-24T01:00:00.000Z",
  source: "ci",
  result: "pass",
  changed: ["packages/server/src/x.ts"],
  selected: [A],
  failed: [],
  tier: "impact",
  ran: "impact-scoped",
  ...over,
});

/** Three gate rows: two that ran only A, one guard failure that ran A and its guard. */
const LEDGER: LedgerRow[] = [
  gateRow({ commit: "a1a1a1a", selected: [A] }),
  gateRow({ commit: "b2b2b2b", selected: [A] }),
  gateRow({ commit: "c3c3c3c", selected: [A], result: "fail", failed: [GUARD], guardFailure: true, source: "ci-guardfailure" }),
  // Landed BEFORE the last green: not in the window, never a candidate.
  gateRow({ commit: "0000000", selected: [] }),
];

describe("rowsInWindow", () => {
  it("places a row by its SHORT commit against the full shas of the window, and only gate rows", () => {
    const rows = rowsInWindow([...LEDGER, gateRow({ commit: "a1a1a1a", source: "base-sweep" })], COMMITS);
    expect(rows.map((r) => r.commit)).toEqual(["a1a1a1a", "b2b2b2b", "c3c3c3c"]);
  });
});

describe("gateRanSuite", () => {
  it("counts selected, seen and FAILED suites as run, and a full run as everything", () => {
    expect(gateRanSuite(gateRow({ selected: [A] }), A)).toBe(true);
    expect(gateRanSuite(gateRow({ selected: [A] }), B)).toBe(false);
    expect(gateRanSuite(gateRow({ selected: [], seenFiles: [B] }), B)).toBe(true);
    // #1230 — a guard failure's guards are in `failed`, so they count as run for that row.
    expect(gateRanSuite(gateRow({ selected: [A], failed: [GUARD], guardFailure: true }), GUARD)).toBe(true);
    expect(gateRanSuite(gateRow({ selected: [], ran: "full" }), B)).toBe(true);
    expect(gateRanSuite(gateRow({ selected: [`./${A.replace(/\//g, "\\")}`] }), A)).toBe(true);
  });
});

describe("computeSweepJoinRows", () => {
  const red = { sweepAt: "2026-09-24T04:00:00.000Z", sweepSha: COMMITS[0]!, ledgerRows: LEDGER, commitsSinceGreen: COMMITS, priorRows: [] as SweepJoinRow[] };

  it("writes exactly one miss naming the gates that did not run the suite, and one flake for the suite every gate ran", () => {
    const rows = computeSweepJoinRows({ ...red, passed: false, failedSuites: [B, A] });
    expect(rows).toEqual([
      { kind: "flake-or-environment", sweepAt: red.sweepAt, sweepSha: red.sweepSha, suite: A },
      { kind: "miss", sweepAt: red.sweepAt, sweepSha: red.sweepSha, suite: B, candidateCommits: ["a1a1a1a", "b2b2b2b", "c3c3c3c"], tier: "impact" },
    ]);
  });

  it("does not blame the guard-failure row for its own guard, but does for a suite it never ran", () => {
    const rows = computeSweepJoinRows({ ...red, passed: false, failedSuites: [GUARD] });
    expect(rows).toEqual([
      { kind: "miss", sweepAt: red.sweepAt, sweepSha: red.sweepSha, suite: GUARD, candidateCommits: ["a1a1a1a", "b2b2b2b"], tier: "impact" },
    ]);
  });

  it("is a flake, not a miss, when nothing merged since the last green", () => {
    const rows = computeSweepJoinRows({ ...red, passed: false, failedSuites: [B], commitsSinceGreen: [] });
    expect(rows).toEqual([{ kind: "flake-or-environment", sweepAt: red.sweepAt, sweepSha: red.sweepSha, suite: B }]);
  });

  it("tags a miss staleMap when a candidate gate row was itself a non-observation, and reads mixed tiers as mixed", () => {
    const ledger = [
      gateRow({ commit: "a1a1a1a", selected: [A], source: "ci-partialselection" }),
      gateRow({ commit: "b2b2b2b", selected: [A], tier: "package" }),
    ];
    const rows = computeSweepJoinRows({ ...red, ledgerRows: ledger, passed: false, failedSuites: [B] });
    expect(rows).toEqual([
      { kind: "miss", sweepAt: red.sweepAt, sweepSha: red.sweepSha, suite: B, candidateCommits: ["a1a1a1a", "b2b2b2b"], tier: "mixed", staleMap: true },
    ]);
  });

  it("writes a heal row for the open red suites on a green sweep, and nothing when none are open", () => {
    const prior: SweepJoinRow[] = [
      { kind: "miss", sweepAt: "1", sweepSha: "x", suite: B, candidateCommits: ["a1a1a1a"], tier: "impact" },
      { kind: "flake-or-environment", sweepAt: "1", sweepSha: "x", suite: A },
    ];
    expect(openRedSuites(prior)).toEqual([A, B]);
    const heal = computeSweepJoinRows({ ...red, passed: true, failedSuites: [], priorRows: prior });
    expect(heal).toEqual([{ kind: "heal", sweepAt: red.sweepAt, sweepSha: red.sweepSha, suites: [A, B] }]);
    const healed: SweepJoinRow[] = [...prior, ...heal];
    expect(openRedSuites(healed)).toEqual([]);
    expect(computeSweepJoinRows({ ...red, passed: true, failedSuites: [], priorRows: healed })).toEqual([]);
  });
});

describe("recordSweepJoin (I/O)", () => {
  function makeRepo(): { main: string; cleanup: () => void } {
    const main = mkdtempSync(join(tmpdir(), "ak-ti-misses-"));
    mkdirSync(join(main, ".test-impact"), { recursive: true });
    writeFileSync(join(main, OUTCOMES_RELATIVE_PATH), LEDGER.map((row) => JSON.stringify(row)).join("\n") + "\n");
    return { main, cleanup: () => rmSync(main, { recursive: true, force: true }) };
  }

  it("seeds three ledger rows, joins one red sweep, and appends a miss and a flake; a green then heals", async () => {
    const repo = makeRepo();
    try {
      const listCommits = async () => COMMITS;
      const red = await recordSweepJoin({
        projectId: "p1",
        repoPath: repo.main,
        lastGreenSha: "9999999999999999999999999999999999999999",
        sweepSha: COMMITS[0]!,
        passed: false,
        failedSuites: [A, B],
        now: "2026-09-24T04:00:00.000Z",
        listCommits,
        log: () => {},
      });
      expect(red.written.map((r) => r.kind)).toEqual(["flake-or-environment", "miss"]);
      const sidecar = join(repo.main, MISSES_RELATIVE_PATH);
      const afterRed = readFileSync(sidecar, "utf8").trim().split("\n").map((line) => JSON.parse(line) as SweepJoinRow);
      expect(afterRed).toHaveLength(2);
      expect(afterRed[1]).toMatchObject({ kind: "miss", suite: B, candidateCommits: ["a1a1a1a", "b2b2b2b", "c3c3c3c"], tier: "impact" });

      const green = await recordSweepJoin({
        projectId: "p1",
        repoPath: repo.main,
        lastGreenSha: COMMITS[0]!,
        sweepSha: "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
        passed: true,
        failedSuites: [],
        now: "2026-09-25T04:00:00.000Z",
        listCommits: async () => ["d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4"],
        log: () => {},
      });
      expect(green.written).toEqual([{ kind: "heal", sweepAt: "2026-09-25T04:00:00.000Z", sweepSha: "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4", suites: [A, B] }]);
      expect(readFileSync(sidecar, "utf8").trim().split("\n")).toHaveLength(3);
      // The outcomes ledger's shape is untouched: the sidecar is the only thing written.
      expect(readFileSync(join(repo.main, OUTCOMES_RELATIVE_PATH), "utf8").trim().split("\n")).toHaveLength(LEDGER.length);
    } finally {
      repo.cleanup();
    }
  });

  it("records nothing and says why when git cannot list the window; never throws", async () => {
    const repo = makeRepo();
    try {
      const logged: string[] = [];
      const result = await recordSweepJoin({
        projectId: "p1",
        repoPath: repo.main,
        lastGreenSha: "9999999",
        sweepSha: "8888888",
        passed: false,
        failedSuites: [B],
        listCommits: async () => null,
        log: (m) => logged.push(m),
      });
      expect(result.written).toEqual([]);
      expect(result.reason).toMatch(/git log/);
      expect(logged).toHaveLength(1);
      expect(existsSync(join(repo.main, MISSES_RELATIVE_PATH))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
});
