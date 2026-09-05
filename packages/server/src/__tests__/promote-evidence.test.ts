// @gate:always-run — imports scripts/promote-evidence.mjs, which no package-local diff links to (#687).
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
  isGateRow,
  isSuspectRow,
  parseOutcomeRows,
  summarizeGateEvidence,
} from "../../../../scripts/promote-evidence.mjs";

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
