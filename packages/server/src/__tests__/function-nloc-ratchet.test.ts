// @gate:always-run — recursively walks the whole server src tree; imports nothing it measures.
import { describe, expect, it } from "vitest";
import path from "node:path";
import { compareNlocRatchet, measureFunctionNloc } from "../../../shared/__tests__/helpers/function-nloc.js";
import { FUNCTION_NLOC_BASELINE, LIST_THRESHOLD } from "./function-nloc-baseline.js";

/**
 * #800 — the server half of #763's shrink-only nloc ring.
 *
 * #763 landed the ring for the CLIENT tree only and named two remainders. This is the first:
 * the server tree, which is where the largest units in the repo actually live (16 functions at
 * or over 400 nloc, topping out at 718). The second remainder — emptying the client ring's
 * `SHRINK_GRACE` — is the sibling commit.
 *
 * ── One scanner, not two ────────────────────────────────────────────────────────────────
 *
 * The measurement is NOT re-implemented here. #763 wrote it inline in the client test because
 * the client tsconfig has no node types outside `*.test.ts`; #800 lifted it, unchanged, to
 * `packages/shared/__tests__/helpers/function-nloc.ts` beside the rest of the guard machinery,
 * and both rings import it. That matters more than tidiness: two copies of a MEASUREMENT can
 * drift, and then the two rings no longer describe the same property while both stay green.
 * The extraction was verified by measuring the client tree with the old inline scanner and the
 * new shared one and diffing: 1434 units, 0 differences.
 *
 * The definition (see the helper's header): outermost function-likes only, nloc = lines in the
 * declaration's extent that are neither blank nor comment-only.
 *
 * ── Why 400 and not the DMM's 15 ────────────────────────────────────────────────────────
 *
 * Measured here: 3196 units, 1197 of them over 15 nloc. A repo-wide ceiling at 15 would be red
 * on arrival and would block ordinary work on day one, which #763's ticket is explicit is the
 * wrong remedy. Nearly every entry in the baseline is a `createXService` factory or a
 * `registerXCommand` builder — the architecture, not a tangle. So the gate enforces the
 * property that is worth enforcing and is independent of the threshold argument: the functions
 * that are genuinely unreadable may not get worse, and no new one may join them unnoticed.
 *
 * PROOF THIS GATE HAS ALREADY BITTEN: on its first duty cycle it reported four real movements
 * on master — one shrink to bank and three growths — each traceable to the commit that caused
 * it. The baseline file records all four and the ticket (#817) for why direct-master work can
 * grow a baselined function without this suite ever refusing.
 *
 * PROOF THIS GATE IS NOT VACUOUS: the client ring's test drives `compareNlocRatchet` — the
 * same shared function this file uses — with synthetic measurements for growth, shrink,
 * disappearance and a new unlisted offender, and asserts each is reported. The first `it` below
 * guards the other half: that the scanner really finds this tree's functions at their real
 * extent, so the assertions after it are not quietly comparing an empty measurement.
 */
const SERVER_SRC = path.join(import.meta.dirname!, "..");

describe("server function nloc is a shrink-only ring (#800)", () => {
  const measured = measureFunctionNloc(SERVER_SRC);
  const verdict = compareNlocRatchet(FUNCTION_NLOC_BASELINE, measured, [], LIST_THRESHOLD);

  it("the scanner finds the functions it claims to — a broken extent would silently pass everything", () => {
    // Guards the measurement itself. If the AST walk or the nloc counter regressed, every
    // other assertion here would go quietly green on numbers that mean nothing.
    expect(Object.keys(measured).length).toBeGreaterThan(2000);
    expect(measured["services/issue.service.ts::createIssueService"]).toBeGreaterThan(400);
    expect(measured["cli/commands/issue.ts::registerIssueCommand"]).toBeGreaterThan(400);
    // A small function must measure small — the failure mode that made #763's own list wrong
    // was a per-function number that did not describe the function's extent.
    const small = Object.values(measured).filter((n) => n <= 15).length;
    expect(small).toBeGreaterThan(1000);
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
