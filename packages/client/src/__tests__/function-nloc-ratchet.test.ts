// @gate:always-run — walks the client src tree with the TS compiler; imports nothing it measures.
import { describe, expect, it } from "vitest";
import path from "node:path";
import { compareNlocRatchet, measureFunctionNloc } from "../../../shared/__tests__/helpers/function-nloc.js";
import { FUNCTION_NLOC_BASELINE, LIST_THRESHOLD } from "./function-nloc-baseline.js";

/**
 * #763 — long functions are a SHRINK-ONLY ring, and the shape of that ring is the whole
 * point of the ticket.
 *
 * The measurement #763 reports is DMM size = 0.483: of every line that landed in a unit in
 * the last 90 days, 48.3% went into a unit that was already <= 15 nloc, and 51.7% into one
 * that was not. The ticket is explicit that a repo-wide "max function length" gate is the
 * WRONG remedy — at 0.483 roughly half of all change already lands on the wrong side, so a
 * hard ceiling would block ordinary work on day one. A shrink-only ratchet on a named list is
 * the shape that fits (#705/#721 are the precedents).
 *
 * ── What was re-derived, and what it changed ────────────────────────────────────────────
 *
 * The ticket's "where it is happening" list is NOT the list this baseline uses, because six
 * of its eight entries do not survive measurement. Measured with the scanner below, at HEAD
 * and again at `931ef537ff` — the exact code sha the ticket cites, so this is not tree drift:
 *
 *   ticket                                        claimed nloc   measured @931ef537ff   @HEAD
 *   SettingsPanel.tsx::handleSave                          256                     40      24
 *   Layout.tsx::handleAddRepoSubmit                        331                     26      26
 *   CreateIssuePanel.tsx::(anonymous)                      228                     19      19
 *   WorkspacePanel.tsx::fetchWorkspaces                    198                     24      24
 *   StrategyTargetsView.tsx::updateProviderPolicy          197                      8       8
 *   CreateIssueForm.tsx::handleBlur                        181                      5       5
 *   IssueDetailPanel.tsx::IssueDetailPanel                 240                    561     561
 *   TableView.tsx::TableView                               165                    416     416
 *
 * Six handlers are 5-26 nloc — at or near the 15-line threshold, not 10-20x over it. The two
 * that ARE large are whole React components, and there the claimed number is far BELOW the
 * extent. The claimed column is not a measurement of the named function's extent in either
 * direction, so baselining it would have frozen six already-small functions and produced a
 * gate that is red on arrival at any number we chose.
 *
 * ── The interpretation does not survive either ──────────────────────────────────────────
 *
 * The ticket reads 0.483 as "the team is writing long functions, and then adding to them".
 * Statically, this codebase is already made of long units: of all lines inside a unit,
 * 92% (client), 80% (server) and 66% (shared) sit in units over 15 nloc. If change landed in
 * proportion to the code's shape, DMM size would be ~0.08-0.20. At 0.483 change is landing in
 * SHORT units at roughly 2.4-6x the rate the existing code would predict — the opposite of
 * the stated reading. What 0.483 mostly reflects is that a 15-nloc threshold classifies this
 * repo's ordinary architectural units as oversized: every one of the 23 largest functions is
 * a React component, a route or a `createXService` factory.
 *
 * So this gate enforces the property that IS worth enforcing and is independent of the
 * threshold argument: the functions that are genuinely unreadable may not get worse, and no
 * new one may join them unnoticed.
 *
 * ── Why AST, not a brace match ──────────────────────────────────────────────────────────
 *
 * `sliceTopLevelFunction` (the shared guard helper) relies on a closing brace at column 0.
 * Every function here is a component or a handler nested inside one, so its braces are
 * indented; a regex would get the extent wrong SILENTLY, which is the one failure mode a size
 * ratchet must not have.
 *
 * PROOF THIS GATE IS NOT VACUOUS: see the last describe block, which runs the same comparison
 * against synthetic measurements for growth, shrink, disappearance and a new unlisted
 * offender, and asserts each is reported.
 */
const CLIENT_SRC = path.join(import.meta.dirname!, "..");

/**
 * #800 lifted the scanner and the comparison into
 * `packages/shared/__tests__/helpers/function-nloc.ts`, unchanged, so the client ring and the
 * server ring measure with ONE definition. They lived inline here because the client tsconfig
 * has no node types outside `*.test.ts`; a test-only helper in `shared/__tests__` has them and
 * is imported by relative path, which is how every other guard suite reaches that machinery.
 *
 * The extraction was verified by measuring this tree with both scanners and diffing:
 * 1434 units, 0 differences, so no number in the baseline moved because of the move.
 */
const measureClient = (): Record<string, number> => measureFunctionNloc(CLIENT_SRC);

describe("client function nloc is a shrink-only ring (#763)", () => {
  const measured = measureClient();
  // No grace set: #800 emptied #763's, and the baseline file says why.
  const verdict = compareNlocRatchet(FUNCTION_NLOC_BASELINE, measured, [], LIST_THRESHOLD);

  it("the scanner finds the functions it claims to — a broken extent would silently pass everything", () => {
    // Guards the measurement itself. If the AST walk or the nloc counter regressed, every
    // other assertion here would go quietly green on numbers that mean nothing.
    expect(Object.keys(measured).length).toBeGreaterThan(500);
    expect(measured["components/TableView.tsx::TableView"]).toBeGreaterThan(300);
    expect(measured["components/ButlerView.tsx::ButlerView"]).toBeGreaterThan(300);
    // A small handler must measure small — the failure mode that made #763's own list wrong
    // was a per-function number that did not describe the function's extent.
    expect(measured["components/StrategyTargetsView.tsx::StrategyTargetsView"]).toBeGreaterThan(300);
  });

  it("no listed function has grown", () => {
    expect(verdict.grew).toEqual([]);
  });

  it("no baseline entry is stale (a shrink must be banked, not left as budget)", () => {
    expect(verdict.stale).toEqual([]);
  });

  it("no baseline entry names a function that no longer exists", () => {
    expect(verdict.vanished).toEqual([]);
  });

  it(`no unlisted function is at or above ${LIST_THRESHOLD} nloc`, () => {
    expect(verdict.unlisted).toEqual([]);
  });

});

describe("compareNlocRatchet reports each violation (the proof this gate can fail)", () => {
  const baseline = { "a.tsx::A": 100, "b.tsx::B": 50 };

  it("reports GROWTH", () => {
    const v = compareNlocRatchet(baseline, { "a.tsx::A": 101, "b.tsx::B": 50 }, [], 400);
    expect(v.grew).toEqual(["a.tsx::A: 101 > baseline 100"]);
    expect(v.stale).toEqual([]);
  });

  it("reports a STALE entry, so a shrink tightens the baseline instead of becoming budget", () => {
    const v = compareNlocRatchet(baseline, { "a.tsx::A": 80, "b.tsx::B": 50 }, [], 400);
    expect(v.stale).toEqual(["a.tsx::A: 80 < baseline 100 — lower it to 80"]);
  });

  it("waives ONLY the stale half for a graced entry, and still catches its growth", () => {
    expect(compareNlocRatchet(baseline, { "a.tsx::A": 80, "b.tsx::B": 50 }, ["a.tsx::A"], 400).stale).toEqual([]);
    expect(compareNlocRatchet(baseline, { "a.tsx::A": 101, "b.tsx::B": 50 }, ["a.tsx::A"], 400).grew).toHaveLength(1);
  });

  it("reports a VANISHED function (renamed or deleted) rather than reading it as a shrink to 0", () => {
    const v = compareNlocRatchet(baseline, { "b.tsx::B": 50 }, ["a.tsx::A"], 400);
    expect(v.vanished).toEqual(["a.tsx::A: no longer declared — delete this baseline entry"]);
    // Even a graced entry must not be allowed to disappear silently.
    expect(v.stale).toEqual([]);
  });

  it("reports a NEW unlisted offender at or above the threshold", () => {
    const v = compareNlocRatchet(baseline, { "a.tsx::A": 100, "b.tsx::B": 50, "c.tsx::C": 400 }, [], 400);
    expect(v.unlisted).toEqual(["c.tsx::C: 400 (NEW offender — not in the baseline)"]);
  });

  it("stays silent on a new function BELOW the threshold — the ticket forbids a repo-wide ceiling", () => {
    const v = compareNlocRatchet(baseline, { "a.tsx::A": 100, "b.tsx::B": 50, "c.tsx::C": 399 }, [], 400);
    expect(v).toEqual({ grew: [], vanished: [], stale: [], unlisted: [] });
  });
});
