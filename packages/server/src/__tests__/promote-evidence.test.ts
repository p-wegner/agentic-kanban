// @gate:always-run when:scripts/promote-evidence.mjs,scripts/promote-evidence.d.mts,scripts/promote.mjs,packages/server/src/services/test-impact-miss-rate.ts — imports scripts/promote-evidence.mjs, which no package-local diff links to (#687); holds its miss-rate mirror to the server module (#1234).
//
// Territory (#1041): the marker is here because the import crosses OUT of this package, so
// `vitest related` cannot see it — not because the suite reads the tree. Its subject is
// therefore exactly the three files it binds to: the script, its hand-written type
// declaration, and the promote entry point that consumes it.
/**
 * Unit tests for the accumulated-gate evidence a promotion PRINTS (#1045).
 *
 * The ledger rows are exactly what the pre-merge gate already writes through
 * `recordVerifyGateOutcome` → `impact.mjs record`; nothing here reads a real file, spawns the
 * skill, or promotes anything.
 *
 * The load-bearing assertion in this file is the last one: the summary must never be turned into
 * a verdict. A threshold here would be `--force-sweep` with a friendlier name.
 */
import { describe, expect, it } from "vitest";
// Typed by the hand-written `scripts/promote-evidence.d.mts`, per the `promote-plan.d.mts` convention.
import {
  OUTCOMES_RELPATH,
  formatGateEvidence,
  formatMissRate,
  isGateRow,
  isSuspectRow,
  parseOutcomeRows,
  summarizeGateEvidence,
  summarizeMissRate,
} from "../../../../scripts/promote-evidence.mjs";
import { formatMissRate as formatMissRateServer, summarizeMissRate as summarizeMissRateServer } from "../services/test-impact-miss-rate.js";

const SWEEP_AT = "2026-09-05T06:00:00.000Z";
const after = (minutes: number) => new Date(Date.parse(SWEEP_AT) + minutes * 60_000).toISOString();

const gate = (over: Record<string, unknown> = {}) => ({
  at: after(30),
  commit: "abc1234",
  source: "ci",
  result: "pass",
  changed: ["packages/server/src/a.ts"],
  selected: ["packages/server/src/__tests__/a.test.ts"],
  failed: [],
  missed: [],
  tier: "impact",
  ran: "impact-scoped",
  ...over,
});

describe("the ledger the gates already write", () => {
  it("lives where the skill puts it", () => {
    expect(OUTCOMES_RELPATH.replace(/\\/g, "/")).toBe(".test-impact/outcomes.jsonl");
  });

  it("reads one row per line and survives a half-written last line", () => {
    const text = `${JSON.stringify(gate())}\n\n${JSON.stringify(gate())}\n{"at":"2026-`;
    expect(parseOutcomeRows(text)).toHaveLength(2);
    expect(parseOutcomeRows("")).toEqual([]);
    expect(parseOutcomeRows(null)).toEqual([]);
  });

  it("recognises a gate row by the source the gate writes, suffixes included", () => {
    expect(isGateRow(gate())).toBe(true);
    expect(isGateRow(gate({ source: "ci-nochange" }))).toBe(true);
    expect(isGateRow(gate({ source: "base-sweep" }))).toBe(false);
    expect(isGateRow(gate({ source: "local" }))).toBe(false);
    // the quality suffixes the skill's own miss-rate report excludes
    expect(isSuspectRow(gate())).toBe(false);
    expect(isSuspectRow(gate({ source: "ci-partialselection" }))).toBe(true);
    expect(isSuspectRow(gate({ source: "ci-nochange-unattributed" }))).toBe(true);
  });
});

describe("what has accumulated since the last sweep", () => {
  const rows = [
    gate({ at: after(-60), changed: ["packages/server/src/before-the-sweep.ts"] }), // outside the window
    gate({ at: after(10), changed: ["packages/server/src/a.ts", "packages/client/src/b.tsx"] }),
    gate({ at: after(20), changed: ["packages/server/src/a.ts", "packages/shared/src/c.ts"] }),
    gate({ at: after(30), result: "fail", failed: ["packages/server/src/__tests__/a.test.ts"] }),
    gate({ at: after(40), source: "ci-nochange", changed: [] }),
    gate({ at: after(50), source: "base-sweep", changed: [] }),
    gate({ at: null, changed: ["packages/server/src/undated.ts"] }),
  ];
  const summary = summarizeGateEvidence(rows, { sinceIso: SWEEP_AT, ledgerPath: "C:/repo/.test-impact/outcomes.jsonl" });

  it("counts only green, non-suspect gate rows inside the window", () => {
    expect(summary.green).toBe(2);
    expect(summary.red).toBe(1);
    expect(summary.suspect).toBe(1);
    expect(summary.undated).toBe(1);
    expect(summary.sweepRows).toBe(1);
  });

  it("unions the changed files of the GREEN runs, deduped — that is the 'M files' the ticket names", () => {
    expect(summary.files).toEqual(["packages/client/src/b.tsx", "packages/server/src/a.ts", "packages/shared/src/c.ts"]);
    expect(summary.fileCount).toBe(3);
    // a run from BEFORE the sweep contributes nothing: the sweep already covered it
    expect(summary.files).not.toContain("packages/server/src/before-the-sweep.ts");
    // and neither does an undated row, which is excluded rather than assumed to be in the window
    expect(summary.files).not.toContain("packages/server/src/undated.ts");
  });

  it("says plainly when nothing has accumulated", () => {
    const empty = summarizeGateEvidence([], { sinceIso: SWEEP_AT });
    expect(formatGateEvidence(empty)).toContain("no gate runs recorded");
  });

  it("reports an unreadable ledger as unreadable, not as zero evidence", () => {
    // "no gate runs" and "the file is not there" mean different things to an operator, and the
    // second one is a setup problem rather than a statement about the last few merges.
    const text = formatGateEvidence({ ledgerPath: "C:/repo/.test-impact/outcomes.jsonl", unreadable: "ENOENT" });
    expect(text).toContain("no ledger at");
    expect(text).toContain("ENOENT");
  });

  it("NEVER reads as a substitute for a sweep — the label is the point (#1045)", () => {
    const text = formatGateEvidence(summary);
    expect(text).toContain("2 green gate run(s)");
    expect(text).toContain("3 changed file(s)");
    expect(text).toContain("WEAKER THAN A SWEEP");
    expect(text).toContain("Authorizes nothing");
    // the caveats an operator would otherwise have to compute from the raw ledger
    expect(text).toContain("1 red");
    expect(text).toContain("suspect (excluded)");
    // and the summary exposes no boolean a caller could mistake for permission to promote
    expect(Object.values(summary).some((v) => typeof v === "boolean")).toBe(false);
  });
});

describe("the miss-rate line (#1234)", () => {
  it("prints the rate per tier beside the gate evidence, labelled as authorizing nothing", () => {
    const misses = [
      { kind: "miss" as const, sweepAt: after(120), sweepSha: "deadbeef", suite: "packages/server/src/__tests__/b.test.ts", candidateCommits: ["abc1234"], tier: "impact" },
      { kind: "flake-or-environment" as const, sweepAt: after(120), sweepSha: "deadbeef", suite: "packages/server/src/__tests__/a.test.ts" },
    ];
    const summary = summarizeMissRate([gate(), gate(), gate({ source: "ci-partialselection" })], misses);
    expect(summary.tiers).toEqual([{ tier: "impact", misses: 1, merges: 2, rate: 0.5, staleExcluded: 0 }]);
    const line = formatMissRate(summary);
    expect(line).toContain("impact: 1/2 = 50.0%");
    expect(line).toContain(`last sweep joined ${after(120)}`);
    expect(line).toMatch(/Authorizes nothing/);
    // The same failure shapes the gate evidence uses, so a promote dry run never prints a bare blank.
    expect(formatMissRate({ ledgerPath: "/x/outcomes.jsonl", unreadable: "ENOENT" })).toContain("no ledger at /x/outcomes.jsonl");
    expect(formatMissRate(summarizeMissRate([], []))).toMatch(/corpus is empty/);
  });
});

describe("the miss-rate mirror agrees with packages/server/src/services/test-impact-miss-rate.ts (#1234)", () => {
  // The rate lives twice on purpose (a published server cannot import a repo-root script, and
  // `pnpm promote` runs without the server). One fixture, both copies, same answer — or red.
  it("produces the same summary and the same line on one fixture", () => {
    const ledger = [gate(), gate({ tier: "package" }), gate({ source: "ci-nochange" }), gate({ source: "base-sweep" })];
    const misses = [
      { kind: "miss" as const, sweepAt: after(120), sweepSha: "deadbeef", suite: "b", candidateCommits: ["abc1234"], tier: "impact" },
      { kind: "miss" as const, sweepAt: after(120), sweepSha: "deadbeef", suite: "c", candidateCommits: ["abc1234"], tier: "impact", staleMap: true as const },
      { kind: "flake-or-environment" as const, sweepAt: after(120), sweepSha: "deadbeef", suite: "a" },
      { kind: "heal" as const, sweepAt: after(240), sweepSha: "feedface", suites: ["a", "b", "c"] },
    ];
    const server = summarizeMissRateServer(ledger, misses);
    const mirror = summarizeMissRate(ledger, misses);
    expect(mirror).toEqual(server);
    expect(server.tiers).toEqual([
      { tier: "impact", misses: 1, merges: 1, rate: 1, staleExcluded: 1 },
      { tier: "package", misses: 0, merges: 1, rate: 0, staleExcluded: 0 },
    ]);
    expect(formatMissRate(mirror)).toBe(formatMissRateServer(server));
    expect(formatMissRate(summarizeMissRate([], []))).toBe(formatMissRateServer(summarizeMissRateServer([], [])));
  });
});
