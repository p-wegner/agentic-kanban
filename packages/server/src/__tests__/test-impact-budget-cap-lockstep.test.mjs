// @gate:always-run when:scripts/test-mine.mjs,packages/server/src/services/test-impact-outcome/budget-cap.ts,packages/server/src/services/test-impact-outcome.service.ts
/**
 * #1261 — the gate's pass message and the test-impact outcome ledger priced the impact selection
 * before #1260's whole-selection budget cap, so under a budget they could name MORE suites than
 * `scripts/test-mine.mjs`'s runner actually executed.
 *
 * Two implementations answer "given this `select --json` selection and a budget, what actually
 * gets kept?":
 *   - `capSelectionToBudget` in `scripts/test-mine.mjs` — decides what the RUNNER executes.
 *   - `capSelectionToBudget` in `packages/server/src/services/test-impact-outcome/budget-cap.ts` —
 *     decides what the gate's pass MESSAGE and the #954 outcome LEDGER report as "selected".
 *
 * They cannot share a module: the script runs under bare `node` with no build step and imports
 * only Node built-ins, while `packages/server` ships only `dist/` and cannot import a repo-root
 * script from published code (see `always-run-dirs-lockstep.test.ts`'s header for the same
 * constraint on the marker-matching rule). So they are bound here by BEHAVIOUR: both sides run
 * against the SAME fixtures and must agree on what is kept, cut, and priced.
 */
import { describe, it, expect } from "vitest";
import { capSelectionToBudget as scriptCap, parseBudgetMs as scriptParseBudgetMs } from "../../../../scripts/test-mine.mjs";
import { capSelectionToBudget as serverCap, parseBudgetMs as serverParseBudgetMs } from "../services/test-impact-outcome/budget-cap.js";

const suite = (test, score, durationMs, signals = []) => ({
  test,
  score,
  ...(durationMs !== undefined ? { durationMs } : {}),
  signals,
});

describe("budget-cap lockstep: scripts/test-mine.mjs vs the server's own mirror (#1261)", () => {
  it("parse the same budget spellings identically", () => {
    for (const spelling of ["120s", "90000ms", "1500", "2m", "", "0", "45.5s"]) {
      expect(serverParseBudgetMs(spelling), spelling).toBe(scriptParseBudgetMs(spelling));
    }
  });

  it("cap the same ranked selection to the same kept/cut set", () => {
    const selection = [
      suite("packages/server/src/__tests__/low-cheap.test.ts", 1.0, 100),
      suite("packages/server/src/__tests__/top.test.ts", 5.0, 40_000),
      suite("packages/server/src/__tests__/mid.test.ts", 3.0, 70_000),
      suite("packages/server/src/__tests__/union.test.ts", 0, 1_000, ["external"]),
    ];
    const fromScript = scriptCap(selection, 60_000);
    const fromServer = serverCap(selection, 60_000);
    expect(fromServer.kept.map((s) => s.test)).toEqual(fromScript.kept.map((s) => s.test));
    expect(fromServer.cut.map((s) => s.test)).toEqual(fromScript.cut.map((s) => s.test));
    expect(fromServer.keptMs).toBe(fromScript.keptMs);
    expect(fromServer.cutMs).toBe(fromScript.cutMs);
  });

  it("both charge the diff's OWN tests first and never cut them", () => {
    const selection = [
      suite("packages/server/src/__tests__/ranked.test.ts", 4.0, 30_000),
      suite("packages/server/src/__tests__/new.test.ts", 99, 50_000),
      suite("packages/server/src/__tests__/edited.test.ts", 1.2, 20_000, ["self"]),
    ];
    const fromScript = scriptCap(selection, 60_000);
    const fromServer = serverCap(selection, 60_000);
    expect(fromServer.ownCount).toBe(fromScript.ownCount);
    expect(fromServer.kept.map((s) => s.test)).toEqual(fromScript.kept.map((s) => s.test));
  });

  it("both keep at least one suite — an empty cap would fall back to a WIDER run", () => {
    const selection = [suite("packages/server/src/__tests__/huge.test.ts", 2, 500_000)];
    const fromScript = scriptCap(selection, 60_000);
    const fromServer = serverCap(selection, 60_000);
    expect(fromServer.kept).toHaveLength(fromScript.kept.length);
    expect(fromServer.kept).toHaveLength(1);
  });

  it("both price an unmeasured suite at the same default duration", () => {
    const selection = [
      { test: "a", score: 2, signals: [] },
      { test: "b", score: 1, signals: [] },
    ];
    const fromScript = scriptCap(selection, 5_000);
    const fromServer = serverCap(selection, 5_000);
    expect(fromServer.kept.map((s) => s.test)).toEqual(fromScript.kept.map((s) => s.test));
  });
});
